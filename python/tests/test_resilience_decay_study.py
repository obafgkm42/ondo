"""Regression tests for the resilience-decay replay contract."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from reversal_scanner_backtest.models import Candle
from reversal_scanner_backtest.resilience_decay_study import (
    ResilienceParameters,
    ResilienceMetrics,
    ResilienceOutcome,
    ResilienceReplaySettings,
    ResilienceSessionObservation,
    ResilienceShockEvent,
    build_sensitivity_analysis,
    build_resilience_replay,
    build_session_outcome,
    build_session_snapshots,
    calculate_resilience_event_score,
    calculate_resilience_metrics,
    chronological_slices,
    fading_vs_resilient,
    moving_block_bootstrap,
    replay_session_events,
    summarize_event_coverage,
    summarize_resilience_replay,
    unscored_reason,
)


def test_checkpoint_scores_use_only_then_visible_troughs() -> None:
    event = completed_event(
        "checkpoint",
        one_hour_price=96,
        one_hour_trough=94,
        two_hour_price=92,
        two_hour_trough=90,
        close_price=95,
        close_trough=90,
    )

    score = calculate_resilience_event_score(event, ResilienceParameters())

    assert score is not None
    assert score.one_hour_recovery_ratio == pytest.approx(1 / 3)
    assert score.two_hour_recovery_ratio == pytest.approx(0.2)
    assert score.close_recovery_ratio == pytest.approx(0.5)


def test_session_replay_freezes_checkpoint_and_completed_event_troughs() -> None:
    parameters = ResilienceParameters()
    closes = [100, 99, 99, 95, 96, 97, 99.5, 98, 98, 99, 100, 100, 100]
    candles = half_hour_session(closes)
    snapshots = build_session_snapshots(
        "2025-01-06",
        candles,
        parameters,
        "America/New_York",
    )

    events = replay_session_events(snapshots, parameters)

    first = events[0]
    assert first.one_hour_price == 95
    assert first.one_hour_trough_price == 95
    assert first.two_hour_price == 97
    assert first.two_hour_trough_price == 95
    assert first.trough_price == 95
    assert len(events) >= 2


def test_late_session_shock_is_explicitly_unscored() -> None:
    parameters = ResilienceParameters()
    closes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 99, 98, 98]
    snapshots = build_session_snapshots(
        "2025-01-06",
        half_hour_session(closes),
        parameters,
        "America/New_York",
    )

    events = replay_session_events(snapshots, parameters)

    assert events
    assert unscored_reason(events[-1]) == "missing_two_hours"
    assert calculate_resilience_event_score(events[-1], parameters) is None

    eligible_only = replay_session_events(
        snapshots,
        replace(parameters, require_two_hour_eligible_start=True),
    )
    assert eligible_only == []


def test_metrics_match_live_window_and_status_boundaries() -> None:
    parameters = ResilienceParameters()
    events = [
        score_event(f"baseline-{index}", 70, index)
        for index in range(5)
    ] + [
        score_event(f"recent-{index}", 55, index + 5)
        for index in range(3)
    ]

    metrics = calculate_resilience_metrics(events, parameters)

    assert metrics.status == "FADING"
    assert metrics.recent_resilience == pytest.approx(55)
    assert metrics.baseline_resilience == pytest.approx(70)
    assert metrics.decay_delta == pytest.approx(-15)
    assert metrics.recent_event_score_slope == pytest.approx(0)

    fragile = calculate_resilience_metrics(
        [*events[:5], *(score_event(f"weak-{index}", 54.99, index + 5) for index in range(3))],
        parameters,
    )
    assert fragile.status == "FRAGILE"


def test_future_outcome_requires_the_full_requested_horizon() -> None:
    from reversal_scanner_backtest.resilience_decay_study import SessionPath

    paths = [
        SessionPath("2025-01-07", high=101, low=98, close=99),
        SessionPath("2025-01-08", high=100, low=97, close=98),
    ]

    one_session = build_session_outcome(100, paths[:1], 1, -0.015)
    five_sessions = build_session_outcome(100, paths, 5, -0.02)

    assert one_session.minimum_return == pytest.approx(-0.02)
    assert one_session.drawdown_event is True
    assert five_sessions.minimum_return is None
    assert five_sessions.drawdown_event is None


def test_summary_bootstrap_is_deterministic_and_session_clustered() -> None:
    candles: list[Candle] = []
    for index in range(12):
        date_value = (datetime(2025, 1, 6) + timedelta(days=index)).date().isoformat()
        closes = [100, 99, 99, 96, 97, 98, 99.5, 100, 100, 100, 100, 100, 100]
        candles.extend(half_hour_session(closes, date_value))
    settings = ResilienceReplaySettings(
        bootstrap_runs=20,
        bootstrap_seed=7,
        bootstrap_block_sessions=2,
    )
    replay = build_resilience_replay(candles, ResilienceParameters(), settings)

    first = summarize_resilience_replay(replay, settings)
    second = summarize_resilience_replay(replay, settings)

    assert first == second
    bootstrap = first["movingBlockBootstrap"]
    assert isinstance(bootstrap, dict)
    assert bootstrap["resamplingUnit"] == "consecutive session-date blocks"
    bootstrap_metrics = bootstrap["metrics"]
    assert isinstance(bootstrap_metrics, dict)
    assert bootstrap_metrics["oneSessionDrawdownRateDifference"]["estimate"] is None
    coverage = first["eventCoverage"]
    assert isinstance(coverage, dict)
    assert coverage["eventCount"] == 12


def test_sensitivity_reuses_event_path_without_changing_classification() -> None:
    candles: list[Candle] = []
    for index in range(12):
        date_value = (datetime(2025, 1, 6) + timedelta(days=index)).date().isoformat()
        candles.extend(
            half_hour_session(
                [100, 99, 99, 96, 97, 98, 99.5, 100, 100, 100, 100, 100, 100],
                date_value,
            )
        )
    settings = ResilienceReplaySettings(bootstrap_runs=0)
    baseline_parameters = ResilienceParameters()
    baseline_replay = build_resilience_replay(
        candles,
        baseline_parameters,
        settings,
    )
    optimized = build_sensitivity_analysis(
        candles,
        settings,
        baseline_parameters,
        baseline_replay=baseline_replay,
    )
    floor_parameters = replace(
        baseline_parameters,
        fading_recent_minimum=25,
    )
    direct = build_resilience_replay(candles, floor_parameters, settings)
    direct_observations = list(direct.observations)
    direct_coverage = summarize_event_coverage(
        list(direct.events),
        floor_parameters,
    )
    floor_row = next(row for row in optimized if row["name"] == "recent_floor_25")

    assert floor_row["eventCount"] == direct_coverage["eventCount"]
    assert floor_row["scoredEventRate"] == direct_coverage["scoredEventRate"]
    assert floor_row["eventWeightedMeanScore"] == direct_coverage[
        "eventWeightedMeanScore"
    ]
    assert floor_row["fadingVsResilient"] == fading_vs_resilient(
        direct_observations
    )
    assert floor_row["chronologicalSlices"] == chronological_slices(
        list(direct.events),
        direct_observations,
    )


def test_bootstrap_keeps_predictive_intervals_for_large_session_cohorts() -> None:
    parameters = ResilienceParameters()
    events: list[ResilienceShockEvent] = []
    observations: list[ResilienceSessionObservation] = []
    for index in range(120):
        session_date = (
            datetime(2025, 1, 1) + timedelta(days=index)
        ).date().isoformat()
        is_fading = index % 2 == 0
        events.append(
            replace(
                score_event(f"event-{index}", 50, index),
                session_date=session_date,
            )
        )
        one_session = ResilienceOutcome(
            session_count=1,
            close_return=-0.02 if is_fading else 0.0,
            minimum_return=-0.03 if is_fading else -0.005,
            maximum_return=0.0,
            drawdown_event=is_fading,
            drawdown_threshold=-0.015,
        )
        five_sessions = replace(
            one_session,
            session_count=5,
            drawdown_threshold=-0.02,
        )
        observations.append(
            ResilienceSessionObservation(
                session_date=session_date,
                timestamp=index,
                latest_price=100,
                new_shock_count=1,
                new_scored_shock_count=1,
                metrics=ResilienceMetrics(
                    status="FADING" if is_fading else "RESILIENT",
                    recent_resilience=50,
                    baseline_resilience=70,
                    decay_delta=-20,
                    recent_event_score_slope=0,
                    decay_score=40,
                    scored_shock_count=8,
                    unscored_shock_count=0,
                ),
                outcomes={
                    "oneSession": one_session,
                    "fiveSessions": five_sessions,
                },
            )
        )

    bootstrap = moving_block_bootstrap(
        events,
        observations,
        ResilienceReplaySettings(
            bootstrap_runs=50,
            bootstrap_seed=7,
            bootstrap_block_sessions=5,
        ),
        parameters,
    )
    metrics = bootstrap["metrics"]
    assert isinstance(metrics, dict)
    one_session_interval = metrics["oneSessionDrawdownRateDifference"]
    assert isinstance(one_session_interval, dict)
    assert one_session_interval["estimate"] == pytest.approx(1)
    assert one_session_interval["lower95"] == pytest.approx(1)
    assert one_session_interval["upper95"] == pytest.approx(1)


def completed_event(
    event_id: str,
    one_hour_price: float,
    one_hour_trough: float,
    two_hour_price: float,
    two_hour_trough: float,
    close_price: float,
    close_trough: float,
) -> ResilienceShockEvent:
    """Build one deterministic complete shock."""

    return ResilienceShockEvent(
        event_id=event_id,
        session_date="2025-01-06",
        session_time="10:00",
        started_at=1_000_000,
        trigger_price=99,
        session_high_at_trigger=100,
        trough_price=90,
        trough_at=1_000_000,
        one_hour_price=one_hour_price,
        one_hour_trough_price=one_hour_trough,
        two_hour_price=two_hour_price,
        two_hour_trough_price=two_hour_trough,
        close_price=close_price,
        close_trough_price=close_trough,
        recovered_at=2_000_000,
        completed_at=2_000_000,
        completion_reason="recovered",
    )


def score_event(event_id: str, score: float, order: int) -> ResilienceShockEvent:
    """Build an event whose three checkpoint ratios equal the requested score."""

    recovery_price = 90 + score / 10
    return replace(
        completed_event(
            event_id,
            recovery_price,
            90,
            recovery_price,
            90,
            recovery_price,
            90,
        ),
        started_at=1_000_000 + order * 60_000,
    )


def half_hour_session(
    boundary_closes: list[float],
    session_date: str = "2025-01-06",
) -> list[Candle]:
    """Expand half-hour boundary closes into a full five-minute RTH path."""

    if len(boundary_closes) != 13:
        raise ValueError("one RTH session requires thirteen half-hour closes")
    start = datetime.fromisoformat(f"{session_date}T09:30:00").replace(
        tzinfo=ZoneInfo("America/New_York")
    )
    five_minute_closes = [
        close
        for close in boundary_closes
        for _repeat in range(6)
    ]
    candles: list[Candle] = []
    for index, close in enumerate(five_minute_closes):
        previous = close if index == 0 else five_minute_closes[index - 1]
        start_time = int((start + timedelta(minutes=index * 5)).timestamp() * 1000)
        candles.append(
            Candle(
                start_time=start_time,
                end_time=start_time + 299_999,
                open=previous,
                high=max(previous, close),
                low=min(previous, close),
                close=close,
                volume=100,
                trade_count=10,
            )
        )
    return candles
