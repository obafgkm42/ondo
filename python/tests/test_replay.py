"""Production-cadence replay tests for the Python research package."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from reversal_scanner_backtest.models import Candle
from reversal_scanner_backtest.replay import (
    ReplaySettings,
    available_history,
    build_delivery_decision,
    is_request_boundary,
    notification_delivery_time,
    should_evaluate_candle,
)

from factories import candle_ending_before, reversal_signal


def test_live_replay_catches_up_every_completed_candle() -> None:
    settings = ReplaySettings(mode="live")

    boundaries = (
        "2025-01-06T14:45:00-05:00",
        "2025-01-06T14:50:00-05:00",
        "2025-01-06T15:05:00-05:00",
        "2025-01-06T15:10:00-05:00",
    )
    assert all(
        should_evaluate_candle(candle_ending_before(value), settings)
        for value in boundaries
    )


def test_live_requests_keep_regular_and_final_hour_cadence() -> None:
    settings = ReplaySettings(mode="live")

    assert is_request_boundary(
        candle_ending_before("2025-01-06T14:45:00-05:00"), settings
    )
    assert not is_request_boundary(
        candle_ending_before("2025-01-06T14:50:00-05:00"), settings
    )
    assert is_request_boundary(
        candle_ending_before("2025-01-06T15:05:00-05:00"), settings
    )
    assert is_request_boundary(
        candle_ending_before("2025-01-06T15:10:00-05:00"), settings
    )


def test_live_replay_clips_history_to_request_lookback() -> None:
    settings = ReplaySettings(mode="live", request_lookback_hours=18)
    trigger = candle_ending_before("2025-01-06T23:00:00-05:00")
    too_old = candle_ending_before("2025-01-06T04:55:00-05:00")
    retained = candle_ending_before("2025-01-06T05:05:00-05:00")

    assert available_history([too_old, retained, trigger], trigger, settings) == [
        retained,
        trigger,
    ]


def test_live_delivery_waits_for_next_real_request_boundary() -> None:
    settings = ReplaySettings(mode="live")
    signal_candle = candle_ending_before("2025-01-06T11:35:00-05:00")

    delivered_at = notification_delivery_time(signal_candle, settings)

    assert datetime.fromtimestamp(
        delivered_at / 1000,
        tz=ZoneInfo("America/New_York"),
    ).isoformat() == "2025-01-06T11:45:00-05:00"


def test_delivery_revalidation_expires_a_stopped_signal() -> None:
    settings = ReplaySettings(mode="live")
    signal_candle = candle_ending_before("2025-01-06T11:35:00-05:00")
    stopped = Candle(
        start_time=signal_candle.end_time + 1,
        end_time=signal_candle.end_time + 300_000,
        open=100,
        high=101,
        low=94,
        close=100,
        volume=100,
        trade_count=10,
    )
    delivery_bar = Candle(
        start_time=stopped.end_time + 1 + 300_000,
        end_time=stopped.end_time + 600_000,
        open=100,
        high=101,
        low=99,
        close=100,
        volume=100,
        trade_count=10,
    )

    decision = build_delivery_decision(
        [signal_candle, stopped, delivery_bar],
        0,
        reversal_signal(signal_candle),
        settings,
    )

    assert decision.status == "invalidated_before_delivery"
    assert decision.observed_at == delivery_bar.start_time
