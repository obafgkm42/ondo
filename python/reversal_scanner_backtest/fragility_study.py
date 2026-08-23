"""Frozen market-fragility classifier and reproducible event-study helpers."""

from __future__ import annotations

import csv
import io
import math
from collections.abc import Iterable
from dataclasses import asdict, dataclass, replace
from datetime import date, datetime
from statistics import mean, median
from typing import Literal
from zoneinfo import ZoneInfo

import numpy as np

from reversal_scanner_backtest.models import Candle
from reversal_scanner_backtest.walk_forward import add_months, first_day_of_next_month

FragilityLevel = Literal[
    "resilient",
    "fragile",
    "breaking",
    "panic",
    "unknown",
]
IndicatorState = Literal["healthy", "stressed", "unavailable"]

MINIMUM_PRICE_CANDLES = 6
FRAGILITY_ATR_WINDOW = 12
SESSION_LOSS_THRESHOLD = -0.01
VWAP_GAP_ATR_THRESHOLD = -0.35
VWAP_CONFIRMATION_CANDLES = 3
POOR_CLOSE_LOCATION_THRESHOLD = 0.25
TAIL_LOOKBACK_RETURNS = 12
LARGE_DOWN_RETURN_FLOOR = 0.0025
LARGE_DOWN_RETURN_MEDIAN_MULTIPLIER = 2.0
LARGE_DOWN_RETURN_COUNT = 2
BREADTH_MINIMUM_ASSETS = 5
BREADTH_DECLINE_THRESHOLD = -0.005
BREADTH_STRESS_RATIO = 0.7
CROSS_ASSET_LOSS_THRESHOLD = -0.0075
TOTAL_INDICATOR_COUNT = 6
MINIMUM_AVAILABLE_INDICATORS = 4

PRICE_INDICATOR_IDS = (
    "session_loss",
    "vwap_repair_failure",
    "poor_close_location",
    "downside_tail_cluster",
)
UNAVAILABLE_CONTEXT_INDICATOR_IDS = (
    "mega_cap_breadth",
    "equity_cross_confirmation",
)
FRAGILITY_LEVELS: tuple[FragilityLevel, ...] = (
    "resilient",
    "fragile",
    "breaking",
    "panic",
    "unknown",
)
LEVEL_SEVERITY: dict[FragilityLevel, int] = {
    "unknown": -1,
    "resilient": 0,
    "fragile": 2,
    "breaking": 3,
    "panic": 4,
}
OUTCOME_THRESHOLDS = {
    "30m": -0.005,
    "60m": -0.0075,
    "120m": -0.01,
    "eod": -0.01,
    "1session": -0.015,
    "5sessions": -0.02,
}
MINUTE_HORIZON_BARS = {
    "30m": 6,
    "60m": 12,
    "120m": 24,
}
SESSION_HORIZONS = {
    "1session": 1,
    "5sessions": 5,
}


@dataclass(frozen=True)
class FragilityIndicator:
    """One transparent repair-mechanism diagnostic."""

    indicator_id: str
    state: IndicatorState
    value: float | None
    threshold: str

    def to_dict(self) -> dict[str, object]:
        """Return a TypeScript-compatible JSON representation."""

        return {
            "id": self.indicator_id,
            "state": self.state,
            "value": self.value,
            "threshold": self.threshold,
        }


@dataclass(frozen=True)
class FragilitySnapshot:
    """Classifier state at one completed-candle observation."""

    level: FragilityLevel
    score: int | None
    stressed_indicator_count: int
    available_indicator_count: int
    total_indicator_count: int
    data_quality: str
    indicators: tuple[FragilityIndicator, ...]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-compatible snapshot."""

        return {
            "level": self.level,
            "score": self.score,
            "stressedIndicatorCount": self.stressed_indicator_count,
            "availableIndicatorCount": self.available_indicator_count,
            "totalIndicatorCount": self.total_indicator_count,
            "dataQuality": self.data_quality,
            "indicators": [indicator.to_dict() for indicator in self.indicators],
        }


@dataclass(frozen=True)
class HorizonOutcome:
    """Forward path observed after, and never during, classification."""

    close_return: float | None
    minimum_return: float | None
    maximum_return: float | None
    drawdown_event: bool | None
    event_threshold: float

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-compatible forward outcome."""

        return {
            "closeReturn": self.close_return,
            "minimumReturn": self.minimum_return,
            "maximumReturn": self.maximum_return,
            "drawdownEvent": self.drawdown_event,
            "eventThreshold": self.event_threshold,
        }


@dataclass(frozen=True)
class FragilityObservation:
    """One scheduled market-status observation and its forward labels."""

    timestamp: int
    session_date: str
    session_time: str
    latest_price: float
    session_candle_count: int
    snapshot: FragilitySnapshot
    previous_level: FragilityLevel | None
    state_changed: bool
    escalated: bool
    outcomes: dict[str, HorizonOutcome]

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-compatible event row."""

        return {
            "timestamp": self.timestamp,
            "sessionDate": self.session_date,
            "sessionTime": self.session_time,
            "latestPrice": self.latest_price,
            "sessionCandleCount": self.session_candle_count,
            "snapshot": self.snapshot.to_dict(),
            "previousLevel": self.previous_level,
            "stateChanged": self.state_changed,
            "escalated": self.escalated,
            "outcomes": {
                horizon: outcome.to_dict()
                for horizon, outcome in self.outcomes.items()
            },
        }


@dataclass(frozen=True)
class FragilityReplaySettings:
    """Frozen scheduling and statistical settings for a fragility study."""

    brief_interval_minutes: int = 30
    session_time_zone: str = "America/New_York"
    bootstrap_runs: int = 1000
    bootstrap_seed: int = 42
    bootstrap_block_sessions: int = 5
    walk_forward_train_months: int = 24
    walk_forward_test_months: int = 6

    def validate(self) -> None:
        """Raise when settings cannot represent a reproducible replay."""

        if self.brief_interval_minutes <= 0:
            raise ValueError("brief_interval_minutes must be positive")
        if self.bootstrap_runs < 0:
            raise ValueError("bootstrap_runs cannot be negative")
        if self.bootstrap_block_sessions <= 0:
            raise ValueError("bootstrap_block_sessions must be positive")
        if self.walk_forward_train_months <= 0:
            raise ValueError("walk_forward_train_months must be positive")
        if self.walk_forward_test_months <= 0:
            raise ValueError("walk_forward_test_months must be positive")
        ZoneInfo(self.session_time_zone)


@dataclass(frozen=True)
class SessionPathSummary:
    """Compact session path needed for one- and five-session labels."""

    session_date: str
    high: float
    low: float
    close: float


def frozen_fragility_thresholds() -> dict[str, object]:
    """Return the complete v1 threshold snapshot used by Python and TypeScript."""

    return {
        "minimumPriceCandles": MINIMUM_PRICE_CANDLES,
        "atrWindow": FRAGILITY_ATR_WINDOW,
        "sessionLossThreshold": SESSION_LOSS_THRESHOLD,
        "vwapGapAtrThreshold": VWAP_GAP_ATR_THRESHOLD,
        "vwapConfirmationCandles": VWAP_CONFIRMATION_CANDLES,
        "poorCloseLocationThreshold": POOR_CLOSE_LOCATION_THRESHOLD,
        "tailLookbackReturns": TAIL_LOOKBACK_RETURNS,
        "largeDownReturnFloor": LARGE_DOWN_RETURN_FLOOR,
        "largeDownReturnMedianMultiplier": (
            LARGE_DOWN_RETURN_MEDIAN_MULTIPLIER
        ),
        "largeDownReturnCount": LARGE_DOWN_RETURN_COUNT,
        "breadthMinimumAssets": BREADTH_MINIMUM_ASSETS,
        "breadthDeclineThreshold": BREADTH_DECLINE_THRESHOLD,
        "breadthStressRatio": BREADTH_STRESS_RATIO,
        "crossAssetLossThreshold": CROSS_ASSET_LOSS_THRESHOLD,
        "totalIndicatorCount": TOTAL_INDICATOR_COUNT,
        "minimumAvailableIndicators": MINIMUM_AVAILABLE_INDICATORS,
        "scoreMap": [0, 15, 35, 60, 80, 90, 100],
    }


def analyze_price_fragility(candles: list[Candle]) -> FragilitySnapshot:
    """Replay the four price indicators while marking context inputs absent."""

    indicators = (
        _session_loss_indicator(candles),
        _vwap_repair_indicator(candles),
        _close_location_indicator(candles),
        _downside_tail_indicator(candles),
        _unavailable_indicator(
            "mega_cap_breadth",
            ">= 70% down at least 0.5%",
        ),
        _unavailable_indicator(
            "equity_cross_confirmation",
            "SP500 and XYZ100 both <= -0.75%",
        ),
    )
    available_count = sum(
        indicator.state != "unavailable" for indicator in indicators
    )
    stressed_count = sum(
        indicator.state == "stressed" for indicator in indicators
    )
    data_quality = _data_quality(available_count)
    enough_data = data_quality != "insufficient"
    return FragilitySnapshot(
        level=_fragility_level(stressed_count) if enough_data else "unknown",
        score=_fragility_score(stressed_count) if enough_data else None,
        stressed_indicator_count=stressed_count,
        available_indicator_count=available_count,
        total_indicator_count=TOTAL_INDICATOR_COUNT,
        data_quality=data_quality,
        indicators=indicators,
    )


def build_fragility_observations(
    candles: list[Candle],
    settings: FragilityReplaySettings,
) -> list[FragilityObservation]:
    """Replay completed RTH candles only at scheduled status-brief boundaries."""

    settings.validate()
    sessions = _group_sessions(candles, settings.session_time_zone)
    observations: list[FragilityObservation] = []
    path_summaries: list[SessionPathSummary] = []
    for session_date, session_candles in sessions:
        observations.extend(
            build_session_fragility_observations(
                session_date,
                session_candles,
                settings,
            )
        )
        path_summaries.append(
            build_session_path_summary(session_date, session_candles)
        )
    return add_session_horizon_outcomes(observations, path_summaries)


def build_session_fragility_observations(
    session_date: str,
    session_candles: list[Candle],
    settings: FragilityReplaySettings,
) -> list[FragilityObservation]:
    """Classify one complete session and label only its intraday future."""

    previous_level: FragilityLevel | None = None
    observations: list[FragilityObservation] = []
    for candle_index, candle in enumerate(session_candles):
        if not _is_brief_boundary(candle, settings):
            continue
        history = session_candles[: candle_index + 1]
        snapshot = analyze_price_fragility(history)
        if snapshot.level == "unknown":
            continue
        local_boundary = datetime.fromtimestamp(
            (candle.end_time + 1) / 1000,
            tz=ZoneInfo(settings.session_time_zone),
        )
        state_changed = previous_level != snapshot.level
        escalated = (
            previous_level is not None
            and LEVEL_SEVERITY[snapshot.level]
            > LEVEL_SEVERITY[previous_level]
        )
        observations.append(
            FragilityObservation(
                timestamp=candle.end_time,
                session_date=session_date,
                session_time=local_boundary.strftime("%H:%M"),
                latest_price=candle.close,
                session_candle_count=len(history),
                snapshot=snapshot,
                previous_level=previous_level,
                state_changed=state_changed,
                escalated=escalated,
                outcomes=_build_intraday_outcomes(
                    session_candles,
                    candle_index,
                ),
            )
        )
        previous_level = snapshot.level
    return observations


def build_session_path_summary(
    session_date: str,
    candles: list[Candle],
) -> SessionPathSummary:
    """Reduce one session to the fields required by multi-session labels."""

    if not candles:
        raise ValueError("cannot summarize an empty session")
    return SessionPathSummary(
        session_date=session_date,
        high=max(candle.high for candle in candles),
        low=min(candle.low for candle in candles),
        close=candles[-1].close,
    )


def add_session_horizon_outcomes(
    observations: list[FragilityObservation],
    sessions: list[SessionPathSummary],
) -> list[FragilityObservation]:
    """Attach one- and five-session labels using compact daily paths."""

    session_positions = {
        session.session_date: index for index, session in enumerate(sessions)
    }
    enriched: list[FragilityObservation] = []
    for observation in observations:
        session_index = session_positions[observation.session_date]
        outcomes = dict(observation.outcomes)
        for horizon, future_session_count in SESSION_HORIZONS.items():
            target_index = session_index + future_session_count
            if target_index >= len(sessions):
                outcomes[horizon] = HorizonOutcome(
                    None,
                    None,
                    None,
                    None,
                    OUTCOME_THRESHOLDS[horizon],
                )
                continue
            future_sessions = sessions[session_index + 1 : target_index + 1]
            eod = outcomes["eod"]
            minimum_returns = [
                session.low / observation.latest_price - 1
                for session in future_sessions
            ]
            maximum_returns = [
                session.high / observation.latest_price - 1
                for session in future_sessions
            ]
            if eod.minimum_return is not None:
                minimum_returns.append(eod.minimum_return)
            if eod.maximum_return is not None:
                maximum_returns.append(eod.maximum_return)
            minimum_return = min(minimum_returns)
            outcomes[horizon] = HorizonOutcome(
                close_return=(
                    sessions[target_index].close / observation.latest_price - 1
                ),
                minimum_return=minimum_return,
                maximum_return=max(maximum_returns),
                drawdown_event=(
                    minimum_return <= OUTCOME_THRESHOLDS[horizon]
                ),
                event_threshold=OUTCOME_THRESHOLDS[horizon],
            )
        enriched.append(replace(observation, outcomes=outcomes))
    return enriched


def summarize_fragility_observations(
    observations: list[FragilityObservation],
    settings: FragilityReplaySettings,
) -> dict[str, object]:
    """Build state, prediction, transition, and uncertainty summaries."""

    settings.validate()
    usable_levels = FRAGILITY_LEVELS[:-1]
    by_level = {
        level: _summarize_level(
            [item for item in observations if item.snapshot.level == level],
            len(observations),
        )
        for level in usable_levels
    }
    first_fragile_plus = _first_fragile_plus_observations(observations)
    return {
        "observationCount": len(observations),
        "sessionCount": len({item.session_date for item in observations}),
        "byLevel": by_level,
        "fragilePlus": _prediction_summary(observations),
        "firstFragilePlusPerSession": _prediction_summary(
            first_fragile_plus,
            prediction_always_true=True,
        ),
        "transitionMatrix": _transition_matrix(observations),
        "movingBlockBootstrap": _moving_block_bootstrap(
            observations,
            settings.bootstrap_runs,
            settings.bootstrap_seed,
            settings.bootstrap_block_sessions,
        ),
    }


def build_fragility_yearly_summary(
    observations: list[FragilityObservation],
) -> list[dict[str, object]]:
    """Summarize classifier prevalence and precision for each calendar year."""

    years = sorted({item.session_date[:4] for item in observations})
    return [
        {
            "year": year,
            **_slice_summary(
                [item for item in observations if item.session_date[:4] == year]
            ),
        }
        for year in years
    ]


def build_fragility_rolling_stability(
    observations: list[FragilityObservation],
    train_months: int,
    test_months: int,
) -> dict[str, object] | None:
    """Build fixed-calendar context/test folds without selecting parameters."""

    if not observations:
        return None
    if train_months <= 0 or test_months <= 0:
        raise ValueError("walk-forward month counts must be positive")
    ordered = sorted(observations, key=lambda item: item.timestamp)
    first_date = date.fromisoformat(ordered[0].session_date)
    last_date = date.fromisoformat(ordered[-1].session_date)
    train_start = date(first_date.year, first_date.month, 1)
    folds: list[dict[str, object]] = []
    combined_test: list[FragilityObservation] = []
    while True:
        train_end = add_months(train_start, train_months)
        test_end = add_months(train_end, test_months)
        if test_end > first_day_of_next_month(last_date):
            break
        train = _observations_between(ordered, train_start, train_end)
        test = _observations_between(ordered, train_end, test_end)
        folds.append(
            {
                "contextStart": train_start.isoformat(),
                "contextEndExclusive": train_end.isoformat(),
                "testStart": train_end.isoformat(),
                "testEndExclusive": test_end.isoformat(),
                "context": _slice_summary(train),
                "test": _slice_summary(test),
            }
        )
        combined_test.extend(test)
        train_start = add_months(train_start, test_months)
    return {
        "contextMonths": train_months,
        "testMonths": test_months,
        "foldCount": len(folds),
        "folds": folds,
        "combinedTest": _slice_summary(combined_test),
    }


def observations_to_csv(observations: list[FragilityObservation]) -> str:
    """Render auditable observation rows with flattened indicator outcomes."""

    fieldnames = [
        "timestamp",
        "session_date",
        "session_time",
        "latest_price",
        "session_candle_count",
        "level",
        "score",
        "stressed_indicator_count",
        "available_indicator_count",
        "data_quality",
        "previous_level",
        "state_changed",
        "escalated",
    ]
    for indicator_id in (
        *PRICE_INDICATOR_IDS,
        *UNAVAILABLE_CONTEXT_INDICATOR_IDS,
    ):
        fieldnames.extend(
            [f"{indicator_id}_state", f"{indicator_id}_value"]
        )
    for horizon in OUTCOME_THRESHOLDS:
        fieldnames.extend(
            [
                f"{horizon}_close_return",
                f"{horizon}_minimum_return",
                f"{horizon}_maximum_return",
                f"{horizon}_drawdown_event",
            ]
        )
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for observation in observations:
        row: dict[str, object] = {
            "timestamp": observation.timestamp,
            "session_date": observation.session_date,
            "session_time": observation.session_time,
            "latest_price": observation.latest_price,
            "session_candle_count": observation.session_candle_count,
            "level": observation.snapshot.level,
            "score": observation.snapshot.score,
            "stressed_indicator_count": (
                observation.snapshot.stressed_indicator_count
            ),
            "available_indicator_count": (
                observation.snapshot.available_indicator_count
            ),
            "data_quality": observation.snapshot.data_quality,
            "previous_level": observation.previous_level,
            "state_changed": observation.state_changed,
            "escalated": observation.escalated,
        }
        for indicator in observation.snapshot.indicators:
            row[f"{indicator.indicator_id}_state"] = indicator.state
            row[f"{indicator.indicator_id}_value"] = indicator.value
        for horizon, outcome in observation.outcomes.items():
            row[f"{horizon}_close_return"] = outcome.close_return
            row[f"{horizon}_minimum_return"] = outcome.minimum_return
            row[f"{horizon}_maximum_return"] = outcome.maximum_return
            row[f"{horizon}_drawdown_event"] = outcome.drawdown_event
        writer.writerow(row)
    return output.getvalue()


def yearly_summary_to_csv(rows: list[dict[str, object]]) -> str:
    """Render stable yearly comparison columns."""

    fieldnames = [
        "year",
        "observations",
        "sessions",
        "fragile_plus_observations",
        "fragile_plus_share",
        "intraday_120m_event_rate",
        "intraday_120m_precision",
        "intraday_120m_recall",
        "intraday_120m_lift_vs_resilient",
        "swing_5session_event_rate",
        "swing_5session_precision",
        "swing_5session_recall",
        "swing_5session_lift_vs_resilient",
    ]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for source in rows:
        intraday = source["intraday120m"]
        swing = source["swing5sessions"]
        assert isinstance(intraday, dict)
        assert isinstance(swing, dict)
        writer.writerow(
            {
                "year": source["year"],
                "observations": source["observations"],
                "sessions": source["sessions"],
                "fragile_plus_observations": source[
                    "fragilePlusObservations"
                ],
                "fragile_plus_share": source["fragilePlusShare"],
                "intraday_120m_event_rate": intraday["eventRate"],
                "intraday_120m_precision": intraday["precision"],
                "intraday_120m_recall": intraday["recall"],
                "intraday_120m_lift_vs_resilient": intraday[
                    "liftVsResilient"
                ],
                "swing_5session_event_rate": swing["eventRate"],
                "swing_5session_precision": swing["precision"],
                "swing_5session_recall": swing["recall"],
                "swing_5session_lift_vs_resilient": swing[
                    "liftVsResilient"
                ],
            }
        )
    return output.getvalue()


def render_fragility_summary_markdown(
    payload: dict[str, object],
) -> str:
    """Render the primary classifier event-study report."""

    summary = payload["summary"]
    input_metadata = payload["input"]
    methodology = payload["methodology"]
    assert isinstance(summary, dict)
    assert isinstance(input_metadata, dict)
    assert isinstance(methodology, dict)
    by_level = summary["byLevel"]
    assert isinstance(by_level, dict)
    lines = [
        "# SP500 Market Fragility Event Study",
        "",
        (
            f"Run `{payload['runId']}` · schema {payload['schemaVersion']} · "
            f"classifier `{methodology['classifierVersion']}`"
        ),
        "",
        "## Scope",
        "",
        (
            "This is a classifier diagnostic, not a short strategy or option "
            "PnL backtest. The run replays the frozen four price indicators; "
            "breadth and SP500/XYZ100 context are unavailable historically."
        ),
        "",
        f"- observations: {summary['observationCount']}",
        f"- sessions: {summary['sessionCount']}",
        f"- input SHA-256: `{input_metadata['sha256']}`",
        f"- methodology fingerprint: `{payload['methodologyFingerprint']}`",
        f"- VWAP mode: `{methodology['vwapMode']}`",
        "",
        "## State-Conditioned Outcomes",
        "",
        (
            "| state | observations | share | 120m min return | "
            "120m drawdown rate | 5-session min return | "
            "5-session drawdown rate |"
        ),
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for level in FRAGILITY_LEVELS[:-1]:
        level_summary = by_level[level]
        assert isinstance(level_summary, dict)
        horizons = level_summary["horizons"]
        assert isinstance(horizons, dict)
        intraday = horizons["120m"]
        swing = horizons["5sessions"]
        assert isinstance(intraday, dict)
        assert isinstance(swing, dict)
        lines.append(
            "| "
            f"{level.upper()} | {level_summary['observations']} | "
            f"{_format_percent(level_summary['share'])} | "
            f"{_format_percent(intraday['meanMinimumReturn'])} | "
            f"{_format_percent(intraday['drawdownEventRate'])} | "
            f"{_format_percent(swing['meanMinimumReturn'])} | "
            f"{_format_percent(swing['drawdownEventRate'])} |"
        )
    prediction = summary["fragilePlus"]
    assert isinstance(prediction, dict)
    lines.extend(
        [
            "",
            "## FRAGILE-or-Worse Diagnostic",
            "",
            _prediction_markdown_line(
                "120-minute >= 1% downside path",
                prediction["120m"],
            ),
            _prediction_markdown_line(
                "five-session >= 2% downside path",
                prediction["5sessions"],
            ),
            "",
            "## Interpretation Rules",
            "",
            "- Repeated briefs are observations, not independent trades.",
            "- Confidence intervals use five-session moving blocks.",
            "- Thresholds are frozen; rolling context rows do not tune them.",
            "- A zero-volume source uses mean close instead of true VWAP.",
            "- PANIC describes failed repair mechanisms and is not permission to chase puts.",
        ]
    )
    warnings = input_metadata.get("warnings", [])
    if isinstance(warnings, list) and warnings:
        lines.extend(["", "## Data Warnings", ""])
        lines.extend(f"- {warning}" for warning in warnings)
    return "\n".join(lines) + "\n"


def render_fragility_rolling_markdown(
    summary: dict[str, object] | None,
) -> str:
    """Render rolling chronological stability without parameter selection."""

    if summary is None:
        return "# Fragility Rolling Stability\n\nNo observations available.\n"
    folds = summary["folds"]
    assert isinstance(folds, list)
    lines = [
        "# Fragility Rolling Out-of-Time Stability",
        "",
        (
            f"Frozen rule · context={summary['contextMonths']} months · "
            f"test={summary['testMonths']} months · folds={summary['foldCount']}"
        ),
        "",
        "Context rows describe the preceding market only. They do not select thresholds.",
        "",
        (
            "| test period | observations | fragile+ share | "
            "120m precision | 120m lift | 5-session precision | "
            "5-session lift |"
        ),
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for fold in folds:
        assert isinstance(fold, dict)
        test = fold["test"]
        assert isinstance(test, dict)
        intraday = test["intraday120m"]
        swing = test["swing5sessions"]
        assert isinstance(intraday, dict)
        assert isinstance(swing, dict)
        lines.append(
            "| "
            f"{fold['testStart']} to {fold['testEndExclusive']} | "
            f"{test['observations']} | "
            f"{_format_percent(test['fragilePlusShare'])} | "
            f"{_format_percent(intraday['precision'])} | "
            f"{_format_number(intraday['liftVsResilient'])} | "
            f"{_format_percent(swing['precision'])} | "
            f"{_format_number(swing['liftVsResilient'])} |"
        )
    return "\n".join(lines) + "\n"


def render_fragility_comparison_markdown(
    baseline: dict[str, object],
    candidate: dict[str, object],
) -> str:
    """Compare stable headline metrics from two schema-v1 runs."""

    baseline_slice = _payload_prediction_summary(baseline)
    candidate_slice = _payload_prediction_summary(candidate)
    lines = [
        "# Fragility Backtest Comparison",
        "",
        f"Baseline `{baseline.get('runId', 'unknown')}`",
        f"Candidate `{candidate.get('runId', 'unknown')}`",
        "",
        (
            "Methodology fingerprints are "
            + (
                "identical."
                if baseline.get("methodologyFingerprint")
                == candidate.get("methodologyFingerprint")
                else "different; inspect both methodology snapshots before attributing metric changes to the classifier."
            )
        ),
        "",
        "| metric | baseline | candidate | delta |",
        "| --- | ---: | ---: | ---: |",
    ]
    for key, label in (
        ("fragilePlusShare", "fragile+ observation share"),
        ("intradayPrecision", "120m precision"),
        ("intradayRecall", "120m recall"),
        ("intradayLift", "120m lift vs resilient"),
        ("swingPrecision", "5-session precision"),
        ("swingRecall", "5-session recall"),
        ("swingLift", "5-session lift vs resilient"),
    ):
        baseline_value = baseline_slice[key]
        candidate_value = candidate_slice[key]
        delta = (
            None
            if baseline_value is None or candidate_value is None
            else candidate_value - baseline_value
        )
        lines.append(
            f"| {label} | {_format_number(baseline_value)} | "
            f"{_format_number(candidate_value)} | {_format_number(delta)} |"
        )
    return "\n".join(lines) + "\n"


def _session_loss_indicator(candles: list[Candle]) -> FragilityIndicator:
    first = candles[0] if candles else None
    latest = candles[-1] if candles else None
    if (
        len(candles) < MINIMUM_PRICE_CANDLES
        or first is None
        or latest is None
        or first.open <= 0
    ):
        return _unavailable_indicator("session_loss", "<= -1.0%")
    value = latest.close / first.open - 1
    return _indicator("session_loss", value <= SESSION_LOSS_THRESHOLD, value, "<= -1.0%")


def _vwap_repair_indicator(candles: list[Candle]) -> FragilityIndicator:
    latest = candles[-1] if candles else None
    atr = _average_true_range(candles, FRAGILITY_ATR_WINDOW)
    if len(candles) < MINIMUM_PRICE_CANDLES or latest is None or atr <= 0:
        return _unavailable_indicator(
            "vwap_repair_failure",
            "<= -0.35 ATR and 3 closes below VWAP",
        )
    vwap = _vwap(candles)
    gap_atr = (latest.close - vwap) / atr
    closes_below = all(
        candle.close < vwap for candle in candles[-VWAP_CONFIRMATION_CANDLES:]
    )
    return _indicator(
        "vwap_repair_failure",
        gap_atr <= VWAP_GAP_ATR_THRESHOLD and closes_below,
        gap_atr,
        "<= -0.35 ATR and 3 closes below VWAP",
    )


def _close_location_indicator(candles: list[Candle]) -> FragilityIndicator:
    latest = candles[-1] if candles else None
    if len(candles) < MINIMUM_PRICE_CANDLES or latest is None:
        return _unavailable_indicator(
            "poor_close_location",
            "<= 25% of range",
        )
    session_high = max(candle.high for candle in candles)
    session_low = min(candle.low for candle in candles)
    session_range = session_high - session_low
    if session_range <= 0:
        return _unavailable_indicator(
            "poor_close_location",
            "<= 25% of range",
        )
    value = (latest.close - session_low) / session_range
    return _indicator(
        "poor_close_location",
        value <= POOR_CLOSE_LOCATION_THRESHOLD,
        value,
        "<= 25% of range",
    )


def _downside_tail_indicator(candles: list[Candle]) -> FragilityIndicator:
    if len(candles) < MINIMUM_PRICE_CANDLES:
        return _unavailable_indicator(
            "downside_tail_cluster",
            ">= 2 volatility-adjusted large down returns",
        )
    sample = candles[-(TAIL_LOOKBACK_RETURNS + 1) :]
    returns = [
        current.close / previous.close - 1
        for previous, current in zip(sample, sample[1:])
        if previous.close > 0
    ]
    if len(returns) < MINIMUM_PRICE_CANDLES - 1:
        return _unavailable_indicator(
            "downside_tail_cluster",
            ">= 2 volatility-adjusted large down returns",
        )
    median_absolute_return = median(abs(value) for value in returns)
    threshold = max(
        LARGE_DOWN_RETURN_FLOOR,
        median_absolute_return * LARGE_DOWN_RETURN_MEDIAN_MULTIPLIER,
    )
    large_down_count = sum(value <= -threshold for value in returns)
    return _indicator(
        "downside_tail_cluster",
        large_down_count >= LARGE_DOWN_RETURN_COUNT,
        float(large_down_count),
        ">= 2 volatility-adjusted large down returns",
    )


def _indicator(
    indicator_id: str,
    stressed: bool,
    value: float,
    threshold: str,
) -> FragilityIndicator:
    return FragilityIndicator(
        indicator_id=indicator_id,
        state="stressed" if stressed else "healthy",
        value=value,
        threshold=threshold,
    )


def _unavailable_indicator(
    indicator_id: str,
    threshold: str,
) -> FragilityIndicator:
    return FragilityIndicator(
        indicator_id=indicator_id,
        state="unavailable",
        value=None,
        threshold=threshold,
    )


def _data_quality(available_count: int) -> str:
    if available_count == TOTAL_INDICATOR_COUNT:
        return "full"
    if available_count >= MINIMUM_AVAILABLE_INDICATORS:
        return "partial"
    return "insufficient"


def _fragility_level(stressed_count: int) -> FragilityLevel:
    if stressed_count >= 4:
        return "panic"
    if stressed_count == 3:
        return "breaking"
    if stressed_count == 2:
        return "fragile"
    return "resilient"


def _fragility_score(stressed_count: int) -> int:
    scores = (0, 15, 35, 60, 80, 90, 100)
    return scores[min(stressed_count, len(scores) - 1)]


def _vwap(candles: list[Candle]) -> float:
    total_volume = sum(candle.volume for candle in candles)
    if total_volume <= 0:
        return mean(candle.close for candle in candles)
    return sum(
        ((candle.high + candle.low + candle.close) / 3) * candle.volume
        for candle in candles
    ) / total_volume


def _average_true_range(candles: list[Candle], window: int) -> float:
    sample = candles[-(window + 1) :]
    true_ranges = [
        max(
            current.high - current.low,
            abs(current.high - previous.close),
            abs(current.low - previous.close),
        )
        for previous, current in zip(sample, sample[1:])
    ]
    return 0.0 if not true_ranges else mean(true_ranges)


def _group_sessions(
    candles: list[Candle],
    time_zone_name: str,
) -> list[tuple[str, list[Candle]]]:
    time_zone = ZoneInfo(time_zone_name)
    grouped: dict[str, list[Candle]] = {}
    for candle in candles:
        session_date = datetime.fromtimestamp(
            candle.start_time / 1000,
            tz=time_zone,
        ).date().isoformat()
        grouped.setdefault(session_date, []).append(candle)
    return [
        (session_date, sorted(session, key=lambda item: item.end_time))
        for session_date, session in sorted(grouped.items())
    ]


def _is_brief_boundary(
    candle: Candle,
    settings: FragilityReplaySettings,
) -> bool:
    boundary = datetime.fromtimestamp(
        (candle.end_time + 1) / 1000,
        tz=ZoneInfo(settings.session_time_zone),
    )
    minute_of_day = boundary.hour * 60 + boundary.minute
    return minute_of_day % settings.brief_interval_minutes == 0


def _build_intraday_outcomes(
    current_session: list[Candle],
    candle_index: int,
) -> dict[str, HorizonOutcome]:
    current = current_session[candle_index]
    outcomes: dict[str, HorizonOutcome] = {}
    for horizon, bars in MINUTE_HORIZON_BARS.items():
        future = current_session[candle_index + 1 : candle_index + 1 + bars]
        outcomes[horizon] = _path_outcome(
            current.close,
            future if len(future) == bars else [],
            OUTCOME_THRESHOLDS[horizon],
        )
    eod_future = current_session[candle_index + 1 :]
    outcomes["eod"] = _path_outcome(
        current.close,
        eod_future,
        OUTCOME_THRESHOLDS["eod"],
    )
    for horizon in SESSION_HORIZONS:
        outcomes[horizon] = _path_outcome(
            current.close,
            [],
            OUTCOME_THRESHOLDS[horizon],
        )
    return outcomes


def _path_outcome(
    base_price: float,
    future: list[Candle],
    threshold: float,
) -> HorizonOutcome:
    if base_price <= 0 or not future:
        return HorizonOutcome(None, None, None, None, threshold)
    close_return = future[-1].close / base_price - 1
    minimum_return = min(candle.low for candle in future) / base_price - 1
    maximum_return = max(candle.high for candle in future) / base_price - 1
    return HorizonOutcome(
        close_return=close_return,
        minimum_return=minimum_return,
        maximum_return=maximum_return,
        drawdown_event=minimum_return <= threshold,
        event_threshold=threshold,
    )


def _summarize_level(
    observations: list[FragilityObservation],
    total_observations: int,
) -> dict[str, object]:
    return {
        "observations": len(observations),
        "sessions": len({item.session_date for item in observations}),
        "share": _safe_divide(len(observations), total_observations),
        "meanScore": _mean_or_none(
            float(item.snapshot.score)
            for item in observations
            if item.snapshot.score is not None
        ),
        "horizons": {
            horizon: _summarize_horizon(observations, horizon)
            for horizon in OUTCOME_THRESHOLDS
        },
    }


def _summarize_horizon(
    observations: list[FragilityObservation],
    horizon: str,
) -> dict[str, object]:
    outcomes = [item.outcomes[horizon] for item in observations]
    usable = [item for item in outcomes if item.drawdown_event is not None]
    return {
        "sampleCount": len(usable),
        "meanCloseReturn": _mean_or_none(
            item.close_return for item in usable if item.close_return is not None
        ),
        "meanMinimumReturn": _mean_or_none(
            item.minimum_return
            for item in usable
            if item.minimum_return is not None
        ),
        "meanMaximumReturn": _mean_or_none(
            item.maximum_return
            for item in usable
            if item.maximum_return is not None
        ),
        "drawdownEventRate": _rate(
            item.drawdown_event for item in usable
        ),
        "eventThreshold": OUTCOME_THRESHOLDS[horizon],
    }


def _prediction_summary(
    observations: list[FragilityObservation],
    prediction_always_true: bool = False,
) -> dict[str, object]:
    return {
        horizon: _binary_prediction_summary(
            observations,
            horizon,
            prediction_always_true,
        )
        for horizon in OUTCOME_THRESHOLDS
    }


def _binary_prediction_summary(
    observations: list[FragilityObservation],
    horizon: str,
    prediction_always_true: bool,
) -> dict[str, object]:
    eligible = [
        item
        for item in observations
        if item.outcomes[horizon].drawdown_event is not None
    ]
    predicted = [
        item
        for item in eligible
        if prediction_always_true or LEVEL_SEVERITY[item.snapshot.level] >= 2
    ]
    positives = [
        item for item in eligible if item.outcomes[horizon].drawdown_event is True
    ]
    true_positives = [
        item for item in predicted if item.outcomes[horizon].drawdown_event is True
    ]
    resilient = [
        item for item in eligible if item.snapshot.level == "resilient"
    ]
    resilient_rate = _rate(
        item.outcomes[horizon].drawdown_event for item in resilient
    )
    precision = _safe_divide(len(true_positives), len(predicted))
    recall = _safe_divide(len(true_positives), len(positives))
    return {
        "eligibleObservations": len(eligible),
        "predictedObservations": len(predicted),
        "positiveOutcomes": len(positives),
        "truePositives": len(true_positives),
        "eventRate": _safe_divide(len(positives), len(eligible)),
        "precision": precision,
        "recall": recall,
        "falseAlarmRate": None if precision is None else 1 - precision,
        "resilientEventRate": resilient_rate,
        "liftVsResilient": (
            None
            if precision is None or resilient_rate in {None, 0}
            else precision / resilient_rate
        ),
        "eventThreshold": OUTCOME_THRESHOLDS[horizon],
    }


def _first_fragile_plus_observations(
    observations: list[FragilityObservation],
) -> list[FragilityObservation]:
    first_by_session: dict[str, FragilityObservation] = {}
    for item in observations:
        if (
            LEVEL_SEVERITY[item.snapshot.level] >= 2
            and item.session_date not in first_by_session
        ):
            first_by_session[item.session_date] = item
    return list(first_by_session.values())


def _transition_matrix(
    observations: list[FragilityObservation],
) -> dict[str, dict[str, int]]:
    matrix = {
        previous: {current: 0 for current in FRAGILITY_LEVELS[:-1]}
        for previous in FRAGILITY_LEVELS[:-1]
    }
    for item in observations:
        if item.previous_level is not None:
            matrix[item.previous_level][item.snapshot.level] += 1
    return matrix


def _moving_block_bootstrap(
    observations: list[FragilityObservation],
    runs: int,
    seed: int,
    block_sessions: int,
) -> dict[str, object]:
    session_dates = sorted({item.session_date for item in observations})
    metric_keys = [
        (level, horizon)
        for level in FRAGILITY_LEVELS[:-1]
        for horizon in OUTCOME_THRESHOLDS
    ]
    if runs == 0 or not session_dates:
        return {
            "runs": runs,
            "seed": seed,
            "blockSessions": block_sessions,
            "resamplingUnit": "consecutive session-date blocks",
            "metrics": {},
        }
    session_index = {value: index for index, value in enumerate(session_dates)}
    metric_index = {value: index for index, value in enumerate(metric_keys)}
    shape = (len(session_dates), len(metric_keys))
    counts = np.zeros(shape, dtype=float)
    event_counts = np.zeros(shape, dtype=float)
    minimum_sums = np.zeros(shape, dtype=float)
    for item in observations:
        level = item.snapshot.level
        if level == "unknown":
            continue
        session_position = session_index[item.session_date]
        for horizon, outcome in item.outcomes.items():
            if outcome.drawdown_event is None or outcome.minimum_return is None:
                continue
            metric_position = metric_index[(level, horizon)]
            counts[session_position, metric_position] += 1
            event_counts[session_position, metric_position] += float(
                outcome.drawdown_event
            )
            minimum_sums[session_position, metric_position] += (
                outcome.minimum_return
            )
    rng = np.random.default_rng(seed)
    event_samples = np.full((runs, len(metric_keys)), np.nan)
    minimum_samples = np.full((runs, len(metric_keys)), np.nan)
    blocks_needed = math.ceil(len(session_dates) / block_sessions)
    for run_index in range(runs):
        starts = rng.integers(0, len(session_dates), size=blocks_needed)
        sampled_indices = np.concatenate(
            [
                (start + np.arange(block_sessions)) % len(session_dates)
                for start in starts
            ]
        )[: len(session_dates)]
        sampled_counts = counts[sampled_indices].sum(axis=0)
        valid = sampled_counts > 0
        event_samples[run_index, valid] = (
            event_counts[sampled_indices].sum(axis=0)[valid]
            / sampled_counts[valid]
        )
        minimum_samples[run_index, valid] = (
            minimum_sums[sampled_indices].sum(axis=0)[valid]
            / sampled_counts[valid]
        )
    metrics: dict[str, dict[str, object]] = {
        level: {} for level in FRAGILITY_LEVELS[:-1]
    }
    total_counts = counts.sum(axis=0)
    total_events = event_counts.sum(axis=0)
    total_minimum = minimum_sums.sum(axis=0)
    for metric_position, (level, horizon) in enumerate(metric_keys):
        count = total_counts[metric_position]
        event_estimate = None if count == 0 else total_events[metric_position] / count
        minimum_estimate = None if count == 0 else total_minimum[metric_position] / count
        metrics[level][horizon] = {
            "drawdownEventRate": _bootstrap_interval(
                event_estimate,
                event_samples[:, metric_position],
            ),
            "meanMinimumReturn": _bootstrap_interval(
                minimum_estimate,
                minimum_samples[:, metric_position],
            ),
        }
    return {
        "runs": runs,
        "seed": seed,
        "blockSessions": block_sessions,
        "resamplingUnit": "consecutive session-date blocks",
        "metrics": metrics,
    }


def _bootstrap_interval(
    estimate: float | None,
    samples: np.ndarray,
) -> dict[str, float | None]:
    finite = samples[np.isfinite(samples)]
    if estimate is None or finite.size == 0:
        return {"estimate": estimate, "lower95": None, "upper95": None}
    return {
        "estimate": estimate,
        "lower95": float(np.percentile(finite, 2.5)),
        "upper95": float(np.percentile(finite, 97.5)),
    }


def _slice_summary(
    observations: list[FragilityObservation],
) -> dict[str, object]:
    fragile_plus = [
        item
        for item in observations
        if LEVEL_SEVERITY[item.snapshot.level] >= 2
    ]
    prediction = _prediction_summary(observations)
    return {
        "observations": len(observations),
        "sessions": len({item.session_date for item in observations}),
        "fragilePlusObservations": len(fragile_plus),
        "fragilePlusShare": _safe_divide(
            len(fragile_plus),
            len(observations),
        ),
        "intraday120m": prediction["120m"],
        "swing5sessions": prediction["5sessions"],
    }


def _observations_between(
    observations: list[FragilityObservation],
    start: date,
    end: date,
) -> list[FragilityObservation]:
    return [
        item
        for item in observations
        if start <= date.fromisoformat(item.session_date) < end
    ]


def _payload_prediction_summary(
    payload: dict[str, object],
) -> dict[str, float | None]:
    summary = payload["summary"]
    assert isinstance(summary, dict)
    observations = int(summary["observationCount"])
    by_level = summary["byLevel"]
    prediction = summary["fragilePlus"]
    assert isinstance(by_level, dict)
    assert isinstance(prediction, dict)
    fragile_count = sum(
        int(by_level[level]["observations"])
        for level in ("fragile", "breaking", "panic")
    )
    intraday = prediction["120m"]
    swing = prediction["5sessions"]
    assert isinstance(intraday, dict)
    assert isinstance(swing, dict)
    return {
        "fragilePlusShare": _safe_divide(fragile_count, observations),
        "intradayPrecision": _optional_float(intraday["precision"]),
        "intradayRecall": _optional_float(intraday["recall"]),
        "intradayLift": _optional_float(intraday["liftVsResilient"]),
        "swingPrecision": _optional_float(swing["precision"]),
        "swingRecall": _optional_float(swing["recall"]),
        "swingLift": _optional_float(swing["liftVsResilient"]),
    }


def _prediction_markdown_line(label: str, value: object) -> str:
    assert isinstance(value, dict)
    return (
        f"- {label}: precision {_format_percent(value['precision'])}, "
        f"recall {_format_percent(value['recall'])}, false alarm "
        f"{_format_percent(value['falseAlarmRate'])}, lift vs resilient "
        f"{_format_number(value['liftVsResilient'])}x."
    )


def _mean_or_none(values: Iterable[float | int]) -> float | None:
    materialized = [float(value) for value in values]
    return None if not materialized else mean(materialized)


def _rate(values: Iterable[bool | None]) -> float | None:
    materialized = [bool(value) for value in values if value is not None]
    return (
        None
        if not materialized
        else sum(materialized) / len(materialized)
    )


def _safe_divide(numerator: int, denominator: int) -> float | None:
    return None if denominator == 0 else numerator / denominator


def _optional_float(value: object) -> float | None:
    return None if value is None else float(value)


def _format_percent(value: object) -> str:
    return "n/a" if value is None else f"{float(value) * 100:.2f}%"


def _format_number(value: object) -> str:
    return "n/a" if value is None else f"{float(value):.3f}"
