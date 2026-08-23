"""Statistical and calendar regression tests for reversal events."""

from __future__ import annotations

from dataclasses import replace
from datetime import date

from reversal_scanner_backtest.reversal_study import (
    PlaceboCandidate,
    build_cluster_bootstrap_summary,
    build_placebo_sample,
    build_reversal_event,
    compare_metric,
    summarize_placebo_samples,
    summarize_reversal_events,
    time_of_day_bucket,
    volatility_is_similar,
)
from reversal_scanner_backtest.walk_forward import build_walk_forward_summary

from factories import candle, candle_at, signal_from_candle


def test_late_session_metrics_stay_inside_new_york_session_date() -> None:
    signal_candle = candle_at(
        "2025-01-04T00:55:00.000Z", 100, 101, 99, 100, 100
    )
    signal = signal_from_candle(signal_candle, "bullish", 95, 120)
    event = build_reversal_event(
        signal,
        signal_candle,
        [signal_candle],
        [
            candle_at("2025-01-04T01:00:00.000Z", 100, 110, 99, 108, 100),
            candle_at("2025-01-06T14:35:00.000Z", 108, 140, 107, 139, 100),
        ],
    )

    assert event.date == "2025-01-03"
    assert event.eod_close == 108
    assert event.mfe_points == 10


def test_time_of_day_buckets_use_new_york_cash_session_boundaries() -> None:
    cases = {
        "2025-01-06T14:20:00.000Z": "premarket",
        "2025-01-06T14:45:00.000Z": "first_30_minutes",
        "2025-01-06T16:00:00.000Z": "midday",
        "2025-01-06T20:45:00.000Z": "final_30_minutes",
    }
    for timestamp, expected in cases.items():
        value = candle_at(timestamp, 1, 1, 1, 1, 1)
        assert time_of_day_bucket(value.end_time) == expected


def test_placebo_sample_matches_full_event_metrics() -> None:
    signal_candle = candle(10, 100, 102, 98, 100, 100)
    signal = signal_from_candle(signal_candle, "bullish", 97, 125)
    future = [
        candle(11, 100, 101, 96, 97, 100),
        candle(12, 97, 103, 96.5, 101, 100),
        candle(13, 101, 121, 100, 120, 100),
    ]
    event = build_reversal_event(signal, signal_candle, [signal_candle], future)
    event_summary = summarize_reversal_events([event])

    sample_summary = summarize_placebo_samples(
        [build_placebo_sample(signal, future)],
    )

    assert sample_summary == {
        "hit20MfeRate": event_summary.mfe20_rate,
        "hit20EodRate": event_summary.eod20_rate,
        "medianMfePoints": event_summary.mfe_median_points,
        "medianMaePoints": event_summary.mae_median_points,
        "currentStopAvgPoints": event_summary.current_stop_performance[
            "conservative"
        ].avg_points,
        "currentStopProfitFactor": event_summary.current_stop_performance[
            "conservative"
        ].profit_factor,
    }


def test_placebo_volatility_match_rejects_unfair_candidates() -> None:
    signal_candle = candle(10, 100, 102, 98, 100, 100)
    signal = signal_from_candle(signal_candle, "bullish", 97, 125)
    history = [candle(index, 100, 102, 98, 100, 100) for index in range(4, 11)]
    event = build_reversal_event(
        signal,
        signal_candle,
        history,
        [candle(11, 100, 104, 99, 103, 100)],
    )
    matched = PlaceboCandidate(
        candle=signal_candle,
        atr_points=event.atr_points,
        session_range_in_atr=event.session_range_in_atr,
        date="2024-01-01",
    )
    too_volatile = PlaceboCandidate(
        candle=signal_candle,
        atr_points=event.atr_points * 2,
        session_range_in_atr=event.session_range_in_atr,
        date="2024-01-01",
    )

    assert volatility_is_similar(matched, event) is True
    assert volatility_is_similar(too_volatile, event) is False


def test_cluster_bootstrap_is_deterministic_by_session() -> None:
    signal_candle = candle(10, 100, 102, 98, 100, 100)
    signal = signal_from_candle(signal_candle, "bullish", 97, 125)
    event = build_reversal_event(
        signal,
        signal_candle,
        [signal_candle],
        [candle(11, 100, 104, 99, 103, 100)],
    )

    summary = build_cluster_bootstrap_summary([event], runs=25, seed=7)

    assert summary is not None
    assert summary.cluster_count == 1
    assert summary.mfe20_rate.lower_95 == summary.mfe20_rate.estimate
    assert summary.mfe20_rate.upper_95 == summary.mfe20_rate.estimate


def test_lower_mae_uses_inverted_advantage_percentile() -> None:
    comparison = compare_metric(10, [5, 6, 7], higher_is_better=False)

    assert comparison["rawPercentileRank"] == 1
    assert comparison["advantagePercentile"] == 0


def test_walk_forward_uses_past_train_and_non_overlapping_test_months() -> None:
    signal_candle = candle(10, 100, 102, 98, 100, 100)
    signal = signal_from_candle(signal_candle, "bullish", 97, 125)
    base_event = build_reversal_event(
        signal,
        signal_candle,
        [signal_candle],
        [candle(11, 100, 104, 99, 103, 100)],
    )
    dates = [
        f"{year:04d}-{month:02d}-15"
        for year, month in [
            (2024 + month_index // 12, month_index % 12 + 1)
            for month_index in range(18)
        ]
    ]
    events = [replace(base_event, date=value) for value in dates]

    summary = build_walk_forward_summary(
        events,
        train_months=12,
        test_months=6,
    )

    assert summary is not None
    assert summary.fold_count == 1
    assert summary.folds[0].train.events == 12
    assert summary.folds[0].test.events == 6
    assert summary.folds[0].test_start == "2025-01-01"
    assert summary.folds[0].test_end_exclusive == "2025-07-01"


def test_walk_forward_uses_explicit_dataset_calendar_anchor() -> None:
    signal_candle = candle(10, 100, 102, 98, 100, 100)
    signal = signal_from_candle(signal_candle, "bullish", 97, 125)
    base_event = build_reversal_event(
        signal,
        signal_candle,
        [signal_candle],
        [candle(11, 100, 104, 99, 103, 100)],
    )
    events = [
        replace(base_event, date="2024-04-15"),
        replace(base_event, date="2025-02-15"),
    ]

    summary = build_walk_forward_summary(
        events,
        train_months=12,
        test_months=6,
        calendar_start=date(2024, 1, 1),
        calendar_end=date(2025, 6, 30),
    )

    assert summary is not None
    assert summary.folds[0].train_start == "2024-01-01"
    assert summary.folds[0].test_start == "2025-01-01"
