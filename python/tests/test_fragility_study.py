"""Regression tests for the frozen fragility event-study contract."""

from __future__ import annotations

from reversal_scanner_backtest.fragility_study import (
    FragilityReplaySettings,
    analyze_price_fragility,
    build_fragility_observations,
    summarize_fragility_observations,
)

from factories import candles_from_closes, session_candles


def test_price_only_fragility_classifies_resilient_and_partial() -> None:
    result = analyze_price_fragility(
        candles_from_closes([100, 100.1, 100.2, 100.15, 100.3, 100.4, 100.5])
    )

    assert result.level == "resilient"
    assert result.score == 0
    assert result.available_indicator_count == 4
    assert result.data_quality == "partial"
    assert [
        item.indicator_id
        for item in result.indicators
        if item.state == "unavailable"
    ] == ["mega_cap_breadth", "equity_cross_confirmation"]


def test_price_only_fragility_can_reach_partial_panic() -> None:
    result = analyze_price_fragility(
        candles_from_closes(
            [100, 99.95, 99.9, 99.45, 99.4, 99.35, 98.9, 98.85, 98.8]
        )
    )

    assert result.level == "panic"
    assert result.score == 80
    assert result.stressed_indicator_count == 4


def test_scheduled_replay_uses_future_only_for_outcomes() -> None:
    settings = FragilityReplaySettings(bootstrap_runs=0)
    stable_future = session_candles([100] * 12)
    weak_future = session_candles(
        [100, 100, 100, 100, 100, 100, 99.8, 99.4, 99, 99, 99, 99]
    )

    stable = build_fragility_observations(stable_future, settings)
    weak = build_fragility_observations(weak_future, settings)

    assert len(stable) == 2
    assert len(weak) == 2
    assert stable[0].session_time == "10:00"
    assert stable[0].snapshot == weak[0].snapshot
    assert stable[0].outcomes["30m"].drawdown_event is False
    assert weak[0].outcomes["30m"].drawdown_event is True


def test_replay_requires_a_complete_forward_horizon() -> None:
    observations = build_fragility_observations(
        session_candles([100] * 10),
        FragilityReplaySettings(bootstrap_runs=0),
    )

    assert len(observations) == 1
    assert observations[0].outcomes["30m"].drawdown_event is None
    assert observations[0].outcomes["eod"].drawdown_event is False


def test_summary_and_bootstrap_are_deterministic() -> None:
    settings = FragilityReplaySettings(
        bootstrap_runs=20,
        bootstrap_seed=7,
        bootstrap_block_sessions=2,
    )
    first = session_candles([100] * 12, "2025-01-06")
    second = session_candles(
        [100, 100, 100, 100, 100, 100, 99.8, 99.4, 99, 99, 99, 99],
        "2025-01-07",
    )
    observations = build_fragility_observations(first + second, settings)

    first_summary = summarize_fragility_observations(observations, settings)
    second_summary = summarize_fragility_observations(observations, settings)

    assert first_summary == second_summary
    assert first_summary["observationCount"] == 4
    assert first_summary["movingBlockBootstrap"]["runs"] == 20
