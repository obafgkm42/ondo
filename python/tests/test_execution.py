"""Execution and trade-policy tests for the Python research package."""

from __future__ import annotations

from dataclasses import replace

import pytest

from reversal_scanner_backtest.reversal_study import (
    ExecutionAssumptions,
    build_reversal_event,
    build_single_position_summary,
    summarize_reversal_events,
)

from factories import candle, signal_from_candle


def test_reversal_event_measures_sweep_recovery_and_stop_out() -> None:
    signal_candle = candle(10, 100, 102, 98, 100, 100)
    signal = signal_from_candle(signal_candle, "bullish", 97, 125)
    event = build_reversal_event(
        signal,
        signal_candle,
        [candle(0, 110, 112, 108, 110, 100), signal_candle],
        [
            candle(11, 100, 101, 96, 97, 100),
            candle(12, 97, 103, 96.5, 101, 100),
            candle(13, 101, 121, 100, 120, 100),
        ],
    )

    assert event.eod_directional_points == 20
    assert event.mfe_points == 21
    assert event.mae_points == 4
    assert event.hit20_mfe is True
    assert event.swept_invalidation is True
    assert event.recovered_after_sweep is True
    assert event.hit20_after_sweep is True
    assert event.sweep_depth_points == 1
    assert event.mae_before_mfe20_points == 4
    assert event.stop_out_study is not None
    assert event.stop_out_study.stopped_out is True
    assert event.stop_out_study.first_stop_out_loss_points == -3
    assert event.stop_out_study.swept_then_reversed is True
    assert event.stop_out_study.points_after_stopout == 23
    assert event.stop_out_study.time_from_stopout_to_reversal_minutes == 10
    assert event.stop_out_study.max_adverse_before_post_stop20_points == 3.5


def test_summary_includes_retry_and_delayed_entry_policies() -> None:
    signal_candle = candle(10, 100, 102, 98, 100, 100)
    signal = signal_from_candle(signal_candle, "bullish", 97, 125)
    event = build_reversal_event(
        signal,
        signal_candle,
        [signal_candle],
        [
            candle(11, 100, 101, 96, 98, 100),
            candle(12, 97, 103, 96.5, 101, 100),
            candle(13, 101, 121, 100, 120, 100),
        ],
    )

    summary = summarize_reversal_events([event])

    assert summary.stop_out_study.swept_then_reversed_rate == 1
    assert summary.stop_out_study.avg_points_after_stopout == 23
    assert summary.stop_out_study.median_minutes_from_stopout_to_reversal == 10
    assert summary.stop_out_study.reentry_after_stopout.trades == 1
    assert summary.stop_out_study.one_retry_policy.trades == 1
    assert summary.stop_out_study.two_retry_policy.avg_points is not None
    assert summary.stop_out_study.two_retry_policy.avg_points > 0
    assert summary.stop_out_study.delayed_entry5m.trades == 1
    assert summary.stop_out_study.delayed_entry_after_confirmation.trades == 1


def test_same_candle_stop_and_target_ambiguity_modes() -> None:
    signal_candle = candle(10, 100, 101, 99, 100, 100)
    signal = replace(
        signal_from_candle(signal_candle, "bullish", 95, 105),
        entry_high=101,
    )
    event = build_reversal_event(
        signal,
        signal_candle,
        [signal_candle],
        [candle(11, 100, 106, 94, 101, 100)],
    )

    assert event.current_stop["conservative"].points == -5
    assert event.current_stop["optimistic"].points == 5
    assert event.current_stop["ambiguous_excluded"].ambiguous is True

    summary = summarize_reversal_events([event])
    assert summary.current_stop_performance["ambiguous_excluded"].ambiguous_trades == 1
    assert summary.current_stop_performance["ambiguous_excluded"].trades == 0


def test_next_open_execution_applies_slippage_cost_and_actual_risk() -> None:
    signal_candle = candle(10, 100, 101, 99, 100, 100)
    signal = replace(
        signal_from_candle(signal_candle, "bullish", 95, 105),
        entry_high=101,
    )
    event = build_reversal_event(
        signal,
        signal_candle,
        [signal_candle],
        [candle(11, 101, 106, 100, 105, 100)],
        ExecutionAssumptions(
            entry_mode="next-open",
            slippage_points=0.25,
            round_trip_cost_points=0.1,
        ),
    )

    assert event.execution_status == "filled"
    assert event.execution_entry_price == 101.25
    assert event.execution_risk_points == pytest.approx(6.6)
    assert event.current_stop["conservative"].points == pytest.approx(3.4)


def test_next_open_outside_frozen_entry_zone_is_not_filled() -> None:
    signal_candle = candle(10, 100, 101, 99, 100, 100)
    signal = signal_from_candle(signal_candle, "bullish", 95, 110)

    event = build_reversal_event(
        signal,
        signal_candle,
        [signal_candle],
        [candle(11, 101, 106, 100, 105, 100)],
        ExecutionAssumptions(entry_mode="next-open"),
    )

    assert event.execution_status == "outside_entry_zone_at_entry"
    assert event.execution_entry_price is None


def test_gap_through_stop_uses_worse_opening_fill() -> None:
    signal_candle = candle(10, 100, 101, 99, 100, 100)
    signal = signal_from_candle(signal_candle, "bullish", 95, 110)
    event = build_reversal_event(
        signal,
        signal_candle,
        [signal_candle],
        [candle(11, 93, 94, 90, 92, 100)],
    )

    assert event.current_stop["conservative"].exit_reason == "gap_stop"
    assert event.current_stop["conservative"].points == -7


def test_fixed_stop_r_uses_fixed_stop_risk() -> None:
    signal_candle = candle(10, 100, 101, 99, 100, 100)
    signal = signal_from_candle(signal_candle, "bullish", 97, 125)
    event = build_reversal_event(
        signal,
        signal_candle,
        [signal_candle],
        [candle(11, 100, 101, 89, 90, 100)],
    )

    assert event.fixed_stops["10pt"]["conservative"].points == -10
    assert event.fixed_stops["10pt"]["conservative"].r == -1


def test_single_position_summary_skips_overlapping_executions() -> None:
    signal_candle = candle(10, 100, 101, 99, 100, 100)
    signal = replace(
        signal_from_candle(signal_candle, "bullish", 95, 105),
        entry_high=101,
    )
    event = build_reversal_event(
        signal,
        signal_candle,
        [signal_candle],
        [
            candle(11, 100, 102, 99, 101, 100),
            candle(12, 101, 106, 100, 105, 100),
        ],
    )

    summary = build_single_position_summary([event, event])

    assert summary.executable_signals == 2
    assert summary.selected_trades == 1
    assert summary.skipped_overlapping == 1
