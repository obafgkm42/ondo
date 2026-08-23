"""No-lookahead replay and stability analysis for resilience decay."""

from __future__ import annotations

import csv
import io
import math
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, replace
from datetime import datetime
from statistics import mean, median
from typing import Literal
from zoneinfo import ZoneInfo

import numpy as np

from reversal_scanner_backtest.models import Candle

ResilienceStatus = Literal[
    "INSUFFICIENT_DATA",
    "RESILIENT",
    "FADING",
    "FRAGILE",
]
CompletionReason = Literal["recovered", "session_close"]

ONE_SESSION_DRAWDOWN_THRESHOLD = -0.015
FIVE_SESSION_DRAWDOWN_THRESHOLD = -0.02
CHECKPOINT_ONE_HOUR_MS = 60 * 60 * 1_000
CHECKPOINT_TWO_HOURS_MS = 2 * 60 * 60 * 1_000
METRIC_COMPARISON_TOLERANCE = 1e-9
MINIMUM_PREDICTIVE_COHORT_SESSIONS = 30


@dataclass(frozen=True)
class ResilienceParameters:
    """Complete parameter contract for one resilience-decay replay."""

    observation_interval_minutes: int = 30
    shock_drop_threshold: float = 0.006
    one_hour_weight: float = 0.35
    two_hour_weight: float = 0.45
    close_weight: float = 0.2
    recent_event_count: int = 3
    baseline_event_count: int = 5
    fading_recent_minimum: float = 55
    fading_decay_delta_threshold: float = -15
    maximum_completed_shocks: int = 12
    require_two_hour_eligible_start: bool = False

    def validate(self) -> None:
        """Raise when parameters cannot represent the live calculation."""

        if (
            self.observation_interval_minutes <= 0
            or self.observation_interval_minutes % 5 != 0
        ):
            raise ValueError(
                "observation_interval_minutes must be a positive multiple of 5"
            )
        if not 0 < self.shock_drop_threshold < 1:
            raise ValueError("shock_drop_threshold must be between 0 and 1")
        weights = (
            self.one_hour_weight,
            self.two_hour_weight,
            self.close_weight,
        )
        if any(weight < 0 for weight in weights) or not math.isclose(
            sum(weights),
            1,
        ):
            raise ValueError("checkpoint weights must be non-negative and sum to 1")
        if self.recent_event_count <= 0 or self.baseline_event_count <= 0:
            raise ValueError("recent and baseline event counts must be positive")
        if self.maximum_completed_shocks < (
            self.recent_event_count + self.baseline_event_count
        ):
            raise ValueError("maximum_completed_shocks cannot truncate the metric window")
        if not 0 <= self.fading_recent_minimum <= 100:
            raise ValueError("fading_recent_minimum must be between 0 and 100")
        if self.fading_decay_delta_threshold > 0:
            raise ValueError("fading_decay_delta_threshold must be non-positive")

    def to_dict(self) -> dict[str, object]:
        """Return a stable JSON-compatible parameter snapshot."""

        return {
            "observationIntervalMinutes": self.observation_interval_minutes,
            "shockDropThreshold": self.shock_drop_threshold,
            "eventWeights": {
                "oneHour": self.one_hour_weight,
                "twoHours": self.two_hour_weight,
                "close": self.close_weight,
            },
            "recentEventCount": self.recent_event_count,
            "baselineEventCount": self.baseline_event_count,
            "fadingRecentMinimum": self.fading_recent_minimum,
            "fadingDecayDeltaThreshold": self.fading_decay_delta_threshold,
            "maximumCompletedShocks": self.maximum_completed_shocks,
            "requireTwoHourEligibleStart": self.require_two_hour_eligible_start,
        }


@dataclass(frozen=True)
class ResilienceReplaySettings:
    """Reproducible statistical settings for resilience-decay research."""

    session_time_zone: str = "America/New_York"
    bootstrap_runs: int = 1_000
    bootstrap_seed: int = 42
    bootstrap_block_sessions: int = 5

    def validate(self) -> None:
        """Raise when replay settings are invalid."""

        ZoneInfo(self.session_time_zone)
        if self.bootstrap_runs < 0:
            raise ValueError("bootstrap_runs cannot be negative")
        if self.bootstrap_block_sessions <= 0:
            raise ValueError("bootstrap_block_sessions must be positive")


@dataclass(frozen=True)
class ResilienceSnapshot:
    """One completed observation on the configured intraday grid."""

    session_date: str
    timestamp: int
    session_time: str
    price: float
    session_high: float
    session_low: float
    is_session_close: bool


@dataclass(frozen=True)
class ResilienceShockEvent:
    """Raw no-lookahead shock path matching the TypeScript state shape."""

    event_id: str
    session_date: str
    session_time: str
    started_at: int
    trigger_price: float
    session_high_at_trigger: float
    trough_price: float
    trough_at: int
    one_hour_price: float | None = None
    one_hour_trough_price: float | None = None
    two_hour_price: float | None = None
    two_hour_trough_price: float | None = None
    close_price: float | None = None
    close_trough_price: float | None = None
    recovered_at: int | None = None
    completed_at: int | None = None
    completion_reason: CompletionReason | None = None

    def to_dict(self) -> dict[str, object]:
        """Return an auditable JSON event row."""

        score = calculate_resilience_event_score(self, ResilienceParameters())
        return {
            "eventId": self.event_id,
            "sessionDate": self.session_date,
            "sessionTime": self.session_time,
            "startedAt": self.started_at,
            "triggerPrice": self.trigger_price,
            "sessionHighAtTrigger": self.session_high_at_trigger,
            "troughPrice": self.trough_price,
            "troughAt": self.trough_at,
            "oneHourPrice": self.one_hour_price,
            "oneHourTroughPrice": self.one_hour_trough_price,
            "twoHourPrice": self.two_hour_price,
            "twoHourTroughPrice": self.two_hour_trough_price,
            "closePrice": self.close_price,
            "closeTroughPrice": self.close_trough_price,
            "recoveredAt": self.recovered_at,
            "completedAt": self.completed_at,
            "completionReason": self.completion_reason,
            "score": None if score is None else score.to_dict(),
            "unscoredReason": unscored_reason(self),
        }


@dataclass(frozen=True)
class ResilienceEventScore:
    """Comparable complete-case score for one shock."""

    event_id: str
    session_date: str
    one_hour_recovery_ratio: float
    two_hour_recovery_ratio: float
    close_recovery_ratio: float
    event_score: float

    def to_dict(self) -> dict[str, object]:
        """Return the TypeScript-compatible score fields."""

        return {
            "eventId": self.event_id,
            "oneHourRecoveryRatio": self.one_hour_recovery_ratio,
            "twoHourRecoveryRatio": self.two_hour_recovery_ratio,
            "closeRecoveryRatio": self.close_recovery_ratio,
            "eventScore": self.event_score,
        }


@dataclass(frozen=True)
class ResilienceMetrics:
    """Decay metrics available after one session has completed."""

    status: ResilienceStatus
    recent_resilience: float | None
    baseline_resilience: float | None
    decay_delta: float | None
    recent_event_score_slope: float | None
    decay_score: float | None
    scored_shock_count: int
    unscored_shock_count: int

    def to_dict(self) -> dict[str, object]:
        """Return the live metric naming contract."""

        return {
            "status": self.status,
            "recentResilience": self.recent_resilience,
            "baselineResilience": self.baseline_resilience,
            "decayDelta": self.decay_delta,
            "recentEventScoreSlope": self.recent_event_score_slope,
            "decayScore": self.decay_score,
            "scoredShockCount": self.scored_shock_count,
            "unscoredShockCount": self.unscored_shock_count,
        }


@dataclass(frozen=True)
class ResilienceOutcome:
    """Future-only path label after a session-close decay observation."""

    session_count: int
    close_return: float | None
    minimum_return: float | None
    maximum_return: float | None
    drawdown_event: bool | None
    drawdown_threshold: float

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-compatible future label."""

        return {
            "sessionCount": self.session_count,
            "closeReturn": self.close_return,
            "minimumReturn": self.minimum_return,
            "maximumReturn": self.maximum_return,
            "drawdownEvent": self.drawdown_event,
            "drawdownThreshold": self.drawdown_threshold,
        }


@dataclass(frozen=True)
class ResilienceSessionObservation:
    """One non-overlapping session-close classification observation."""

    session_date: str
    timestamp: int
    latest_price: float
    new_shock_count: int
    new_scored_shock_count: int
    metrics: ResilienceMetrics
    outcomes: dict[str, ResilienceOutcome]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-compatible observation row."""

        return {
            "sessionDate": self.session_date,
            "timestamp": self.timestamp,
            "latestPrice": self.latest_price,
            "newShockCount": self.new_shock_count,
            "newScoredShockCount": self.new_scored_shock_count,
            "metrics": self.metrics.to_dict(),
            "outcomes": {
                name: outcome.to_dict()
                for name, outcome in self.outcomes.items()
            },
        }


@dataclass(frozen=True)
class ResilienceReplayResult:
    """Complete auditable output of one parameter replay."""

    parameters: ResilienceParameters
    events: tuple[ResilienceShockEvent, ...]
    observations: tuple[ResilienceSessionObservation, ...]


@dataclass(frozen=True)
class SessionPath:
    """Compact path used only after a session classification is frozen."""

    session_date: str
    high: float
    low: float
    close: float


def build_resilience_replay(
    candles: list[Candle],
    parameters: ResilienceParameters | None = None,
    settings: ResilienceReplaySettings | None = None,
) -> ResilienceReplayResult:
    """Replay live-parity shock state and attach future session outcomes."""

    active_parameters = parameters or ResilienceParameters()
    active_settings = settings or ResilienceReplaySettings()
    active_parameters.validate()
    active_settings.validate()
    sessions = group_rth_sessions(candles, active_settings.session_time_zone)
    return _build_resilience_replay_from_sessions(
        sessions,
        active_parameters,
        active_settings,
    )


def _build_resilience_replay_from_sessions(
    sessions: list[tuple[str, list[Candle]]],
    parameters: ResilienceParameters,
    settings: ResilienceReplaySettings,
) -> ResilienceReplayResult:
    """Replay pre-grouped sessions without repeating timezone conversion."""

    retained_history: list[ResilienceShockEvent] = []
    all_events: list[ResilienceShockEvent] = []
    observations: list[ResilienceSessionObservation] = []
    paths: list[SessionPath] = []

    for session_date, session_candles in sessions:
        snapshots = build_session_snapshots(
            session_date,
            session_candles,
            parameters,
            settings.session_time_zone,
        )
        if not snapshots:
            continue
        session_events = replay_session_events(snapshots, parameters)
        all_events.extend(session_events)
        retained_history = [
            *retained_history,
            *session_events,
        ][-parameters.maximum_completed_shocks :]
        metrics = calculate_resilience_metrics(
            retained_history,
            parameters,
        )
        latest = snapshots[-1]
        observations.append(
            ResilienceSessionObservation(
                session_date=session_date,
                timestamp=latest.timestamp,
                latest_price=latest.price,
                new_shock_count=len(session_events),
                new_scored_shock_count=sum(
                    calculate_resilience_event_score(event, parameters)
                    is not None
                    for event in session_events
                ),
                metrics=metrics,
                outcomes={},
            )
        )
        paths.append(
            SessionPath(
                session_date=session_date,
                high=max(candle.high for candle in session_candles),
                low=min(candle.low for candle in session_candles),
                close=session_candles[-1].close,
            )
        )
    return ResilienceReplayResult(
        parameters=parameters,
        events=tuple(all_events),
        observations=tuple(add_future_outcomes(observations, paths)),
    )


def _reclassify_resilience_replay(
    replay: ResilienceReplayResult,
    parameters: ResilienceParameters,
) -> ResilienceReplayResult:
    """Recalculate scores and statuses when the detected paths are unchanged."""

    parameters.validate()
    events_by_session: dict[str, list[ResilienceShockEvent]] = defaultdict(list)
    for event in replay.events:
        events_by_session[event.session_date].append(event)

    retained_history: list[ResilienceShockEvent] = []
    observations: list[ResilienceSessionObservation] = []
    for observation in replay.observations:
        session_events = events_by_session[observation.session_date]
        retained_history = [
            *retained_history,
            *session_events,
        ][-parameters.maximum_completed_shocks :]
        observations.append(
            replace(
                observation,
                new_scored_shock_count=sum(
                    calculate_resilience_event_score(event, parameters) is not None
                    for event in session_events
                ),
                metrics=calculate_resilience_metrics(
                    retained_history,
                    parameters,
                ),
            )
        )
    return ResilienceReplayResult(
        parameters=parameters,
        events=replay.events,
        observations=tuple(observations),
    )


def _event_stream_key(
    parameters: ResilienceParameters,
) -> tuple[int, float, bool]:
    """Return the parameters that can change shock detection or checkpoints."""

    return (
        parameters.observation_interval_minutes,
        parameters.shock_drop_threshold,
        parameters.require_two_hour_eligible_start,
    )


def group_rth_sessions(
    candles: list[Candle],
    session_time_zone: str,
) -> list[tuple[str, list[Candle]]]:
    """Group ordered RTH candles by local session date."""

    time_zone = ZoneInfo(session_time_zone)
    grouped: dict[str, list[Candle]] = defaultdict(list)
    for candle in candles:
        session_date = datetime.fromtimestamp(
            candle.start_time / 1000,
            tz=time_zone,
        ).date().isoformat()
        grouped[session_date].append(candle)
    return [
        (session_date, sorted(items, key=lambda item: item.end_time))
        for session_date, items in sorted(grouped.items())
    ]


def build_session_snapshots(
    session_date: str,
    candles: list[Candle],
    parameters: ResilienceParameters,
    session_time_zone: str,
) -> list[ResilienceSnapshot]:
    """Build the fixed completed-candle grid used by one replay variant."""

    parameters.validate()
    time_zone = ZoneInfo(session_time_zone)
    interval_ms = parameters.observation_interval_minutes * 60_000
    session_high = float("-inf")
    session_low = float("inf")
    snapshots: list[ResilienceSnapshot] = []
    for candle in candles:
        session_high = max(session_high, candle.high)
        session_low = min(session_low, candle.low)
        boundary_timestamp = candle.end_time + 1
        if boundary_timestamp % interval_ms != 0:
            continue
        boundary = datetime.fromtimestamp(
            boundary_timestamp / 1000,
            tz=time_zone,
        )
        snapshots.append(
            ResilienceSnapshot(
                session_date=session_date,
                timestamp=candle.end_time,
                session_time=boundary.strftime("%H:%M"),
                price=candle.close,
                session_high=session_high,
                session_low=session_low,
                is_session_close=(boundary.hour == 16 and boundary.minute == 0),
            )
        )
    return snapshots


def replay_session_events(
    snapshots: list[ResilienceSnapshot],
    parameters: ResilienceParameters,
) -> list[ResilienceShockEvent]:
    """Replay one session with the live event ordering and completion rules."""

    if not snapshots:
        return []
    completed: list[ResilienceShockEvent] = []
    active: ResilienceShockEvent | None = None
    for snapshot in snapshots:
        completed = [observe_event(event, snapshot) for event in completed]
        active = None if active is None else observe_event(active, snapshot)
        shock_completed = False
        if active is not None:
            recovered = snapshot.price >= active.session_high_at_trigger * (
                1 - parameters.shock_drop_threshold
            )
            if snapshot.is_session_close or recovered:
                active = complete_event(
                    active,
                    snapshot,
                    "session_close" if snapshot.is_session_close else "recovered",
                )
                completed.append(active)
                active = None
                shock_completed = True
        if (
            active is None
            and not shock_completed
            and (
                not parameters.require_two_hour_eligible_start
                or two_hour_checkpoint_is_eligible(snapshot)
            )
            and snapshot.price
            <= snapshot.session_high * (1 - parameters.shock_drop_threshold)
        ):
            active = start_event(snapshot)
            if snapshot.is_session_close:
                completed.append(complete_event(active, snapshot, "session_close"))
                active = None
        if snapshot.is_session_close:
            completed = [finalize_event_at_close(event, snapshot) for event in completed]

    last_snapshot = snapshots[-1]
    completed = [
        finalize_event_at_close(observe_event(event, last_snapshot), last_snapshot)
        for event in completed
    ]
    if active is not None:
        completed.append(
            finalize_event_at_close(
                observe_event(active, last_snapshot),
                last_snapshot,
            )
        )
    return sorted(completed, key=lambda event: event.started_at)


def two_hour_checkpoint_is_eligible(snapshot: ResilienceSnapshot) -> bool:
    """Return whether a two-hour checkpoint fits before the RTH close."""

    hour_text, minute_text = snapshot.session_time.split(":", maxsplit=1)
    minute_of_day = int(hour_text) * 60 + int(minute_text)
    return minute_of_day <= 14 * 60


def start_event(snapshot: ResilienceSnapshot) -> ResilienceShockEvent:
    """Start one raw event at the first qualifying observation."""

    return ResilienceShockEvent(
        event_id=f"{snapshot.session_date}:{snapshot.timestamp}",
        session_date=snapshot.session_date,
        session_time=snapshot.session_time,
        started_at=snapshot.timestamp,
        trigger_price=snapshot.price,
        session_high_at_trigger=snapshot.session_high,
        trough_price=snapshot.price,
        trough_at=snapshot.timestamp,
    )


def observe_event(
    event: ResilienceShockEvent,
    snapshot: ResilienceSnapshot,
) -> ResilienceShockEvent:
    """Observe one event without rewriting a completed event's trough."""

    can_update_trough = event.completed_at is None
    makes_new_trough = can_update_trough and snapshot.price < event.trough_price
    trough_price = snapshot.price if makes_new_trough else event.trough_price
    trough_at = snapshot.timestamp if makes_new_trough else event.trough_at
    record_one_hour = (
        event.one_hour_price is None
        and snapshot.timestamp >= event.started_at + CHECKPOINT_ONE_HOUR_MS
    )
    record_two_hours = (
        event.two_hour_price is None
        and snapshot.timestamp >= event.started_at + CHECKPOINT_TWO_HOURS_MS
    )
    return replace(
        event,
        trough_price=trough_price,
        trough_at=trough_at,
        one_hour_price=(snapshot.price if record_one_hour else event.one_hour_price),
        one_hour_trough_price=(
            trough_price if record_one_hour else event.one_hour_trough_price
        ),
        two_hour_price=(snapshot.price if record_two_hours else event.two_hour_price),
        two_hour_trough_price=(
            trough_price if record_two_hours else event.two_hour_trough_price
        ),
    )


def complete_event(
    event: ResilienceShockEvent,
    snapshot: ResilienceSnapshot,
    reason: CompletionReason,
) -> ResilienceShockEvent:
    """Complete an active event without fabricating future close data."""

    return replace(
        event,
        close_price=(snapshot.price if snapshot.is_session_close else event.close_price),
        close_trough_price=(
            event.trough_price
            if snapshot.is_session_close
            else event.close_trough_price
        ),
        recovered_at=(snapshot.timestamp if reason == "recovered" else event.recovered_at),
        completed_at=snapshot.timestamp,
        completion_reason=reason,
    )


def finalize_event_at_close(
    event: ResilienceShockEvent,
    snapshot: ResilienceSnapshot,
) -> ResilienceShockEvent:
    """Attach the last available session observation as the close checkpoint."""

    return replace(
        event,
        close_price=snapshot.price,
        close_trough_price=event.trough_price,
        completed_at=(event.completed_at or snapshot.timestamp),
        completion_reason=(event.completion_reason or "session_close"),
    )


def calculate_resilience_event_score(
    event: ResilienceShockEvent,
    parameters: ResilienceParameters,
) -> ResilienceEventScore | None:
    """Calculate one complete-case score using checkpoint-visible troughs."""

    one_hour = recovery_ratio(
        event.session_high_at_trigger,
        event.one_hour_price,
        event.one_hour_trough_price,
    )
    two_hours = recovery_ratio(
        event.session_high_at_trigger,
        event.two_hour_price,
        event.two_hour_trough_price,
    )
    close = recovery_ratio(
        event.session_high_at_trigger,
        event.close_price,
        event.close_trough_price,
    )
    if one_hour is None or two_hours is None or close is None:
        return None
    return ResilienceEventScore(
        event_id=event.event_id,
        session_date=event.session_date,
        one_hour_recovery_ratio=one_hour,
        two_hour_recovery_ratio=two_hours,
        close_recovery_ratio=close,
        event_score=100
        * (
            one_hour * parameters.one_hour_weight
            + two_hours * parameters.two_hour_weight
            + close * parameters.close_weight
        ),
    )


def recovery_ratio(
    session_high: float,
    recovery_price: float | None,
    checkpoint_trough: float | None,
) -> float | None:
    """Measure recovery using only the trough visible at that checkpoint."""

    if recovery_price is None or checkpoint_trough is None:
        return None
    recovery_range = session_high - checkpoint_trough
    if recovery_range <= 0:
        return None
    return min(1.0, max(0.0, (recovery_price - checkpoint_trough) / recovery_range))


def unscored_reason(event: ResilienceShockEvent) -> str | None:
    """Return the first explicit reason an event is not comparable."""

    if event.one_hour_price is None or event.one_hour_trough_price is None:
        return "missing_one_hour"
    if event.two_hour_price is None or event.two_hour_trough_price is None:
        return "missing_two_hours"
    if event.close_price is None or event.close_trough_price is None:
        return "missing_close"
    if any(
        checkpoint >= event.session_high_at_trigger
        for checkpoint in (
            event.one_hour_trough_price,
            event.two_hour_trough_price,
            event.close_trough_price,
        )
    ):
        return "invalid_recovery_range"
    return None


def calculate_resilience_metrics(
    completed_shocks: list[ResilienceShockEvent],
    parameters: ResilienceParameters,
) -> ResilienceMetrics:
    """Calculate live-parity metrics from the retained completed event log."""

    event_scores = [
        score
        for event in sorted(completed_shocks, key=lambda item: item.started_at)
        if (score := calculate_resilience_event_score(event, parameters)) is not None
    ]
    recent_scores = (
        event_scores[-parameters.recent_event_count :]
        if len(event_scores) >= parameters.recent_event_count
        else []
    )
    required = parameters.recent_event_count + parameters.baseline_event_count
    baseline_scores = (
        event_scores[-required : -parameters.recent_event_count]
        if len(event_scores) >= required
        else []
    )
    recent_resilience = mean_score(recent_scores)
    baseline_resilience = mean_score(baseline_scores)
    decay_delta = (
        None
        if recent_resilience is None or baseline_resilience is None
        else recent_resilience - baseline_resilience
    )
    slope = event_score_slope(recent_scores)
    decay_score = (
        None
        if decay_delta is None or slope is None
        else min(100.0, 2 * max(0.0, -decay_delta) + 2 * max(0.0, -slope))
    )
    return ResilienceMetrics(
        status=classify_resilience(
            recent_resilience,
            baseline_resilience,
            decay_delta,
            slope,
            parameters,
        ),
        recent_resilience=recent_resilience,
        baseline_resilience=baseline_resilience,
        decay_delta=decay_delta,
        recent_event_score_slope=slope,
        decay_score=decay_score,
        scored_shock_count=len(event_scores),
        unscored_shock_count=len(completed_shocks) - len(event_scores),
    )


def mean_score(scores: list[ResilienceEventScore]) -> float | None:
    """Return the event-score mean or no value for an incomplete window."""

    return None if not scores else mean(score.event_score for score in scores)


def event_score_slope(scores: list[ResilienceEventScore]) -> float | None:
    """Return ordinary least-squares points per event for an ordered window."""

    if len(scores) < 2:
        return None
    x_mean = (len(scores) - 1) / 2
    y_mean = mean(score.event_score for score in scores)
    numerator = sum(
        (index - x_mean) * (score.event_score - y_mean)
        for index, score in enumerate(scores)
    )
    denominator = sum((index - x_mean) ** 2 for index in range(len(scores)))
    return None if denominator == 0 else numerator / denominator


def classify_resilience(
    recent: float | None,
    baseline: float | None,
    delta: float | None,
    slope: float | None,
    parameters: ResilienceParameters,
) -> ResilienceStatus:
    """Apply the deterministic live status ordering."""

    if recent is None or baseline is None or delta is None or slope is None:
        return "INSUFFICIENT_DATA"
    if recent + METRIC_COMPARISON_TOLERANCE < parameters.fading_recent_minimum:
        return "FRAGILE"
    if delta <= (
        parameters.fading_decay_delta_threshold + METRIC_COMPARISON_TOLERANCE
    ):
        return "FADING"
    return "RESILIENT"


def add_future_outcomes(
    observations: list[ResilienceSessionObservation],
    paths: list[SessionPath],
) -> list[ResilienceSessionObservation]:
    """Attach only future sessions after each close classification is frozen."""

    path_positions = {path.session_date: index for index, path in enumerate(paths)}
    enriched: list[ResilienceSessionObservation] = []
    for observation in observations:
        position = path_positions[observation.session_date]
        outcomes = {
            "oneSession": build_session_outcome(
                observation.latest_price,
                paths[position + 1 : position + 2],
                1,
                ONE_SESSION_DRAWDOWN_THRESHOLD,
            ),
            "fiveSessions": build_session_outcome(
                observation.latest_price,
                paths[position + 1 : position + 6],
                5,
                FIVE_SESSION_DRAWDOWN_THRESHOLD,
            ),
        }
        enriched.append(replace(observation, outcomes=outcomes))
    return enriched


def build_session_outcome(
    base_price: float,
    future_paths: list[SessionPath],
    required_sessions: int,
    threshold: float,
) -> ResilienceOutcome:
    """Build a fixed-horizon future path or an explicit missing label."""

    if len(future_paths) != required_sessions or base_price <= 0:
        return ResilienceOutcome(
            required_sessions,
            None,
            None,
            None,
            None,
            threshold,
        )
    minimum_return = min(path.low for path in future_paths) / base_price - 1
    return ResilienceOutcome(
        session_count=required_sessions,
        close_return=future_paths[-1].close / base_price - 1,
        minimum_return=minimum_return,
        maximum_return=max(path.high for path in future_paths) / base_price - 1,
        drawdown_event=minimum_return <= threshold,
        drawdown_threshold=threshold,
    )


def summarize_resilience_replay(
    replay: ResilienceReplayResult,
    settings: ResilienceReplaySettings,
) -> dict[str, object]:
    """Summarize coverage, dependence, prediction, and clustered uncertainty."""

    settings.validate()
    events = list(replay.events)
    observations = list(replay.observations)
    return {
        "sessionCount": len(observations),
        "eventCoverage": summarize_event_coverage(events, replay.parameters),
        "statusObservations": summarize_status_observations(observations),
        "fadingVsResilient": fading_vs_resilient(observations),
        "chronologicalSlices": chronological_slices(events, observations),
        "movingBlockBootstrap": moving_block_bootstrap(
            events,
            observations,
            settings,
            replay.parameters,
        ),
    }


def summarize_event_coverage(
    events: list[ResilienceShockEvent],
    parameters: ResilienceParameters,
) -> dict[str, object]:
    """Report score availability and session-cluster dependence."""

    scores = [
        score
        for event in events
        if (score := calculate_resilience_event_score(event, parameters)) is not None
    ]
    scores_by_session: dict[str, list[float]] = defaultdict(list)
    starts: dict[str, list[ResilienceShockEvent]] = defaultdict(list)
    reasons: dict[str, int] = defaultdict(int)
    completions: dict[str, int] = defaultdict(int)
    for event in events:
        starts[event.session_time].append(event)
        completions[str(event.completion_reason)] += 1
        reason = unscored_reason(event)
        if reason is not None:
            reasons[reason] += 1
    for score in scores:
        scores_by_session[score.session_date].append(score.event_score)
    event_values = [score.event_score for score in scores]
    session_means = [mean(values) for values in scores_by_session.values()]
    event_counts = list(_count_by_session(events).values())
    return {
        "eventCount": len(events),
        "scoredEventCount": len(scores),
        "unscoredEventCount": len(events) - len(scores),
        "scoredEventRate": safe_divide(len(scores), len(events)),
        "unscoredReasons": dict(sorted(reasons.items())),
        "completionReasons": dict(sorted(completions.items())),
        "byStartTime": {
            start_time: {
                "events": len(items),
                "scored": sum(
                    calculate_resilience_event_score(item, parameters) is not None
                    for item in items
                ),
                "scoredRate": rate(
                    calculate_resilience_event_score(item, parameters) is not None
                    for item in items
                ),
            }
            for start_time, items in sorted(starts.items())
        },
        "scoreDistribution": distribution_summary(event_values),
        "eventWeightedMeanScore": mean_or_none(event_values),
        "sessionWeightedMeanScore": mean_or_none(session_means),
        "sessionsWithScoredEvents": len(session_means),
        "eventsPerEventSession": distribution_summary(event_counts),
    }


def summarize_status_observations(
    observations: list[ResilienceSessionObservation],
) -> dict[str, object]:
    """Summarize one session-close observation per independent date."""

    statuses: tuple[ResilienceStatus, ...] = (
        "INSUFFICIENT_DATA",
        "RESILIENT",
        "FADING",
        "FRAGILE",
    )
    return {
        status: {
            "observations": len(items),
            "share": safe_divide(len(items), len(observations)),
            "oneSession": summarize_outcome(items, "oneSession"),
            "fiveSessions": summarize_outcome(items, "fiveSessions"),
        }
        for status in statuses
        if (
            items := [item for item in observations if item.metrics.status == status]
        )
        or status == "INSUFFICIENT_DATA"
    }


def summarize_outcome(
    observations: list[ResilienceSessionObservation],
    horizon: str,
) -> dict[str, object]:
    """Summarize future path labels for one status cohort."""

    outcomes = [item.outcomes[horizon] for item in observations]
    complete = [item for item in outcomes if item.drawdown_event is not None]
    return {
        "completeOutcomes": len(complete),
        "drawdownEventRate": rate(item.drawdown_event for item in complete),
        "meanMinimumReturn": mean_or_none(
            item.minimum_return for item in complete if item.minimum_return is not None
        ),
        "meanCloseReturn": mean_or_none(
            item.close_return for item in complete if item.close_return is not None
        ),
    }


def fading_vs_resilient(
    observations: list[ResilienceSessionObservation],
) -> dict[str, object]:
    """Report separation without interpreting it as causal or tradable."""

    fading = [item for item in observations if item.metrics.status == "FADING"]
    resilient = [item for item in observations if item.metrics.status == "RESILIENT"]
    return {
        horizon: outcome_difference(fading, resilient, horizon)
        for horizon in ("oneSession", "fiveSessions")
    }


def outcome_difference(
    fading: list[ResilienceSessionObservation],
    resilient: list[ResilienceSessionObservation],
    horizon: str,
) -> dict[str, object]:
    """Calculate FADING minus RESILIENT path statistics."""

    fading_summary = summarize_outcome(fading, horizon)
    resilient_summary = summarize_outcome(resilient, horizon)
    fading_sessions = len({item.session_date for item in fading})
    resilient_sessions = len({item.session_date for item in resilient})
    identifiable = (
        fading_sessions >= MINIMUM_PREDICTIVE_COHORT_SESSIONS
        and resilient_sessions >= MINIMUM_PREDICTIVE_COHORT_SESSIONS
    )
    return {
        "fading": fading_summary,
        "resilient": resilient_summary,
        "fadingIndependentSessions": fading_sessions,
        "resilientIndependentSessions": resilient_sessions,
        "minimumCohortSessions": MINIMUM_PREDICTIVE_COHORT_SESSIONS,
        "identifiable": identifiable,
        "drawdownEventRateDifference": (
            optional_difference(
                fading_summary["drawdownEventRate"],
                resilient_summary["drawdownEventRate"],
            )
            if identifiable
            else None
        ),
        "meanMinimumReturnDifference": (
            optional_difference(
                fading_summary["meanMinimumReturn"],
                resilient_summary["meanMinimumReturn"],
            )
            if identifiable
            else None
        ),
    }


def chronological_slices(
    events: list[ResilienceShockEvent],
    observations: list[ResilienceSessionObservation],
) -> dict[str, object]:
    """Create fixed 60/20/20 development, validation, and holdout slices."""

    dates = sorted({item.session_date for item in observations})
    if not dates:
        return {}
    development_end = max(1, math.floor(len(dates) * 0.6))
    validation_end = max(development_end + 1, math.floor(len(dates) * 0.8))
    validation_end = min(validation_end, len(dates))
    slices = {
        "development": dates[:development_end],
        "validation": dates[development_end:validation_end],
        "holdout": dates[validation_end:],
    }
    return {
        name: compact_slice_summary(
            [event for event in events if event.session_date in selected_dates],
            [
                observation
                for observation in observations
                if observation.session_date in selected_dates
            ],
        )
        for name, slice_dates in slices.items()
        if (selected_dates := set(slice_dates))
    }


def compact_slice_summary(
    events: list[ResilienceShockEvent],
    observations: list[ResilienceSessionObservation],
) -> dict[str, object]:
    """Return stable comparison fields for one chronological slice."""

    scored_count = sum(unscored_reason(event) is None for event in events)
    fading_count = sum(item.metrics.status == "FADING" for item in observations)
    return {
        "start": observations[0].session_date if observations else None,
        "end": observations[-1].session_date if observations else None,
        "sessions": len(observations),
        "events": len(events),
        "scoredEventRate": safe_divide(scored_count, len(events)),
        "fadingObservations": fading_count,
        "fadingShare": safe_divide(fading_count, len(observations)),
        "fadingVsResilient": fading_vs_resilient(observations),
    }


def moving_block_bootstrap(
    events: list[ResilienceShockEvent],
    observations: list[ResilienceSessionObservation],
    settings: ResilienceReplaySettings,
    parameters: ResilienceParameters,
) -> dict[str, object]:
    """Build session-block intervals for score and status separation."""

    session_dates = [item.session_date for item in observations]
    estimates = bootstrap_metrics(events, observations, parameters)
    if settings.bootstrap_runs == 0 or not session_dates:
        return {
            "runs": settings.bootstrap_runs,
            "seed": settings.bootstrap_seed,
            "blockSessions": settings.bootstrap_block_sessions,
            "resamplingUnit": "consecutive session-date blocks",
            "metrics": {
                name: bootstrap_interval(value, [])
                for name, value in estimates.items()
            },
        }
    scores_by_date: dict[str, list[float]] = defaultdict(list)
    observations_by_date = {item.session_date: item for item in observations}
    for event in events:
        score = calculate_resilience_event_score(event, parameters)
        if score is not None:
            scores_by_date[event.session_date].append(score.event_score)
    can_estimate_predictive_separation = (
        len(
            {
                item.session_date
                for item in observations
                if item.metrics.status == "FADING"
            }
        )
        >= MINIMUM_PREDICTIVE_COHORT_SESSIONS
        and len(
            {
                item.session_date
                for item in observations
                if item.metrics.status == "RESILIENT"
            }
        )
        >= MINIMUM_PREDICTIVE_COHORT_SESSIONS
    )
    rng = np.random.default_rng(settings.bootstrap_seed)
    samples: dict[str, list[float]] = defaultdict(list)
    block_count = math.ceil(
        len(session_dates) / settings.bootstrap_block_sessions
    )
    for _run in range(settings.bootstrap_runs):
        starts = rng.integers(0, len(session_dates), size=block_count)
        sampled_dates = [
            session_dates[(int(start) + offset) % len(session_dates)]
            for start in starts
            for offset in range(settings.bootstrap_block_sessions)
        ][: len(session_dates)]
        sampled_scores = [
            score
            for session_date in sampled_dates
            for score in scores_by_date[session_date]
        ]
        sampled_metrics = _bootstrap_metrics_from_scores(
            sampled_scores,
            (
                [
                    observations_by_date[session_date]
                    for session_date in sampled_dates
                ]
                if can_estimate_predictive_separation
                else None
            ),
        )
        for name, value in sampled_metrics.items():
            if value is not None and math.isfinite(value):
                samples[name].append(value)
    return {
        "runs": settings.bootstrap_runs,
        "seed": settings.bootstrap_seed,
        "blockSessions": settings.bootstrap_block_sessions,
        "resamplingUnit": "consecutive session-date blocks",
        "metrics": {
            name: bootstrap_interval(value, samples[name])
            for name, value in estimates.items()
        },
    }


def bootstrap_metrics(
    events: list[ResilienceShockEvent],
    observations: list[ResilienceSessionObservation],
    parameters: ResilienceParameters,
) -> dict[str, float | None]:
    """Return the small stable metric set used by clustered resampling."""

    scores = [
        score.event_score
        for event in events
        if (score := calculate_resilience_event_score(event, parameters)) is not None
    ]
    return _bootstrap_metrics_from_scores(scores, observations)


def _bootstrap_metrics_from_scores(
    scores: list[float],
    observations: list[ResilienceSessionObservation] | None,
) -> dict[str, float | None]:
    """Calculate bootstrap metrics from scores cached by session date."""

    separation = (
        None if observations is None else fading_vs_resilient(observations)
    )
    one_session = None if separation is None else separation["oneSession"]
    five_sessions = None if separation is None else separation["fiveSessions"]
    assert one_session is None or isinstance(one_session, dict)
    assert five_sessions is None or isinstance(five_sessions, dict)
    return {
        "eventScoreMean": mean_or_none(scores),
        "oneSessionDrawdownRateDifference": optional_float(
            None
            if one_session is None
            else one_session["drawdownEventRateDifference"]
        ),
        "oneSessionMinimumReturnDifference": optional_float(
            None
            if one_session is None
            else one_session["meanMinimumReturnDifference"]
        ),
        "fiveSessionDrawdownRateDifference": optional_float(
            None
            if five_sessions is None
            else five_sessions["drawdownEventRateDifference"]
        ),
        "fiveSessionMinimumReturnDifference": optional_float(
            None
            if five_sessions is None
            else five_sessions["meanMinimumReturnDifference"]
        ),
    }


def bootstrap_interval(
    estimate: float | None,
    samples: list[float],
) -> dict[str, float | None]:
    """Return a percentile interval without row-level independence claims."""

    if estimate is None or not samples:
        return {"estimate": estimate, "lower95": None, "upper95": None}
    return {
        "estimate": estimate,
        "lower95": float(np.percentile(samples, 2.5)),
        "upper95": float(np.percentile(samples, 97.5)),
    }


def sensitivity_parameter_sets(
    base: ResilienceParameters | None = None,
) -> list[tuple[str, ResilienceParameters]]:
    """Return one-at-a-time variants without selecting a best full-sample rule."""

    baseline = base or ResilienceParameters()
    variants = [
        ("live_30m", baseline),
        ("path_5m", replace(baseline, observation_interval_minutes=5)),
        ("path_15m", replace(baseline, observation_interval_minutes=15)),
        ("shock_0_4pct", replace(baseline, shock_drop_threshold=0.004)),
        ("shock_0_8pct", replace(baseline, shock_drop_threshold=0.008)),
        (
            "two_hour_eligible_starts_only",
            replace(baseline, require_two_hour_eligible_start=True),
        ),
        ("relative_decay_only", replace(baseline, fading_recent_minimum=0)),
        ("recent_floor_25", replace(baseline, fading_recent_minimum=25)),
        ("recent_floor_35", replace(baseline, fading_recent_minimum=35)),
        ("recent_floor_45", replace(baseline, fading_recent_minimum=45)),
        ("recent_floor_50", replace(baseline, fading_recent_minimum=50)),
        ("recent_floor_60", replace(baseline, fading_recent_minimum=60)),
        ("decay_delta_5", replace(baseline, fading_decay_delta_threshold=-5)),
        ("decay_delta_10", replace(baseline, fading_decay_delta_threshold=-10)),
        ("decay_delta_20", replace(baseline, fading_decay_delta_threshold=-20)),
        (
            "equal_checkpoint_weights",
            replace(
                baseline,
                one_hour_weight=1 / 3,
                two_hour_weight=1 / 3,
                close_weight=1 / 3,
            ),
        ),
        (
            "close_heavy_weights",
            replace(
                baseline,
                one_hour_weight=0.25,
                two_hour_weight=0.35,
                close_weight=0.4,
            ),
        ),
    ]
    for _name, parameters in variants:
        parameters.validate()
    return variants


def build_sensitivity_analysis(
    candles: list[Candle],
    settings: ResilienceReplaySettings,
    base: ResilienceParameters | None = None,
    baseline_replay: ResilienceReplayResult | None = None,
) -> list[dict[str, object]]:
    """Replay one-at-a-time variants and retain compact comparable evidence."""

    baseline_parameters = base or ResilienceParameters()
    baseline_parameters.validate()
    settings.validate()
    if (
        baseline_replay is not None
        and baseline_replay.parameters != baseline_parameters
    ):
        raise ValueError("baseline_replay parameters must match base parameters")
    sessions = group_rth_sessions(candles, settings.session_time_zone)
    reference_replay = baseline_replay or _build_resilience_replay_from_sessions(
        sessions,
        baseline_parameters,
        settings,
    )
    reference_event_key = _event_stream_key(baseline_parameters)
    results: list[dict[str, object]] = []
    for name, parameters in sensitivity_parameter_sets(baseline_parameters):
        if parameters == baseline_parameters:
            replay = reference_replay
        elif _event_stream_key(parameters) == reference_event_key:
            # Threshold floors, decay deltas, and checkpoint weights do not
            # alter which shocks occurred, so reuse the audited event path.
            replay = _reclassify_resilience_replay(
                reference_replay,
                parameters,
            )
        else:
            replay = _build_resilience_replay_from_sessions(
                sessions,
                parameters,
                settings,
            )
        coverage = summarize_event_coverage(list(replay.events), parameters)
        observations = list(replay.observations)
        fading_count = sum(
            item.metrics.status == "FADING" for item in observations
        )
        results.append(
            {
                "name": name,
                "parameters": parameters.to_dict(),
                "eventCount": coverage["eventCount"],
                "scoredEventRate": coverage["scoredEventRate"],
                "eventWeightedMeanScore": coverage["eventWeightedMeanScore"],
                "sessionWeightedMeanScore": coverage["sessionWeightedMeanScore"],
                "fadingObservations": fading_count,
                "fadingShare": safe_divide(fading_count, len(observations)),
                "fadingVsResilient": fading_vs_resilient(observations),
                "chronologicalSlices": chronological_slices(
                    list(replay.events),
                    observations,
                ),
            }
        )
    return results


def events_to_csv(
    events: Iterable[ResilienceShockEvent],
    parameters: ResilienceParameters,
) -> str:
    """Render one auditable row per shock."""

    fieldnames = [
        "event_id",
        "session_date",
        "session_time",
        "started_at",
        "trigger_price",
        "session_high_at_trigger",
        "trough_price",
        "trough_at",
        "one_hour_price",
        "one_hour_trough_price",
        "two_hour_price",
        "two_hour_trough_price",
        "close_price",
        "close_trough_price",
        "completion_reason",
        "one_hour_recovery_ratio",
        "two_hour_recovery_ratio",
        "close_recovery_ratio",
        "event_score",
        "unscored_reason",
    ]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for event in events:
        score = calculate_resilience_event_score(event, parameters)
        writer.writerow(
            {
                "event_id": event.event_id,
                "session_date": event.session_date,
                "session_time": event.session_time,
                "started_at": event.started_at,
                "trigger_price": event.trigger_price,
                "session_high_at_trigger": event.session_high_at_trigger,
                "trough_price": event.trough_price,
                "trough_at": event.trough_at,
                "one_hour_price": event.one_hour_price,
                "one_hour_trough_price": event.one_hour_trough_price,
                "two_hour_price": event.two_hour_price,
                "two_hour_trough_price": event.two_hour_trough_price,
                "close_price": event.close_price,
                "close_trough_price": event.close_trough_price,
                "completion_reason": event.completion_reason,
                "one_hour_recovery_ratio": (
                    None if score is None else score.one_hour_recovery_ratio
                ),
                "two_hour_recovery_ratio": (
                    None if score is None else score.two_hour_recovery_ratio
                ),
                "close_recovery_ratio": (
                    None if score is None else score.close_recovery_ratio
                ),
                "event_score": None if score is None else score.event_score,
                "unscored_reason": unscored_reason(event),
            }
        )
    return output.getvalue()


def observations_to_csv(
    observations: Iterable[ResilienceSessionObservation],
) -> str:
    """Render one independent session-close status row."""

    fieldnames = [
        "session_date",
        "timestamp",
        "latest_price",
        "new_shock_count",
        "new_scored_shock_count",
        "status",
        "recent_resilience",
        "baseline_resilience",
        "decay_delta",
        "recent_event_score_slope",
        "decay_score",
        "scored_shock_count",
        "unscored_shock_count",
        "one_session_minimum_return",
        "one_session_drawdown_event",
        "five_session_minimum_return",
        "five_session_drawdown_event",
    ]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for observation in observations:
        metrics = observation.metrics
        one_session = observation.outcomes["oneSession"]
        five_sessions = observation.outcomes["fiveSessions"]
        writer.writerow(
            {
                "session_date": observation.session_date,
                "timestamp": observation.timestamp,
                "latest_price": observation.latest_price,
                "new_shock_count": observation.new_shock_count,
                "new_scored_shock_count": observation.new_scored_shock_count,
                "status": metrics.status,
                "recent_resilience": metrics.recent_resilience,
                "baseline_resilience": metrics.baseline_resilience,
                "decay_delta": metrics.decay_delta,
                "recent_event_score_slope": metrics.recent_event_score_slope,
                "decay_score": metrics.decay_score,
                "scored_shock_count": metrics.scored_shock_count,
                "unscored_shock_count": metrics.unscored_shock_count,
                "one_session_minimum_return": one_session.minimum_return,
                "one_session_drawdown_event": one_session.drawdown_event,
                "five_session_minimum_return": five_sessions.minimum_return,
                "five_session_drawdown_event": five_sessions.drawdown_event,
            }
        )
    return output.getvalue()


def distribution_summary(values: list[float] | list[int]) -> dict[str, object]:
    """Return stable descriptive statistics without an independence claim."""

    if not values:
        return {
            "count": 0,
            "mean": None,
            "median": None,
            "p10": None,
            "p90": None,
            "minimum": None,
            "maximum": None,
        }
    return {
        "count": len(values),
        "mean": mean(values),
        "median": median(values),
        "p10": float(np.percentile(values, 10)),
        "p90": float(np.percentile(values, 90)),
        "minimum": min(values),
        "maximum": max(values),
    }


def _count_by_session(
    events: list[ResilienceShockEvent],
) -> dict[str, int]:
    counts: dict[str, int] = defaultdict(int)
    for event in events:
        counts[event.session_date] += 1
    return counts


def mean_or_none(values: Iterable[float | int]) -> float | None:
    """Return a finite mean when at least one value exists."""

    materialized = list(values)
    return None if not materialized else mean(materialized)


def rate(values: Iterable[bool | None]) -> float | None:
    """Return a Boolean rate while omitting missing labels."""

    materialized = [value for value in values if value is not None]
    return (
        None
        if not materialized
        else sum(bool(value) for value in materialized) / len(materialized)
    )


def safe_divide(numerator: int, denominator: int) -> float | None:
    """Return no rate for an empty denominator."""

    return None if denominator == 0 else numerator / denominator


def optional_difference(left: object, right: object) -> float | None:
    """Subtract two optional numeric summary values."""

    left_value = optional_float(left)
    right_value = optional_float(right)
    return (
        None
        if left_value is None or right_value is None
        else left_value - right_value
    )


def optional_float(value: object) -> float | None:
    """Narrow one JSON-compatible optional numeric value."""

    return None if value is None else float(value)
