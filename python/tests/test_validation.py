"""Candle validation and timestamp normalization regression tests."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from reversal_scanner_backtest.cli import reinterpret_naive_local_candle
from reversal_scanner_backtest.models import Candle
from reversal_scanner_backtest.validation import validate_candles

from factories import candle_ending_before


def test_validation_reports_zero_volume_and_rejects_bad_ohlc() -> None:
    valid = candle_ending_before("2025-01-06T09:35:00-05:00", volume=0)
    invalid = Candle(
        start_time=valid.start_time + 300_000,
        end_time=valid.end_time + 300_000,
        open=105,
        high=104,
        low=100,
        close=101,
        volume=0,
        trade_count=0,
    )

    report = validate_candles([valid, invalid], 5, "America/New_York")

    assert report.is_valid is False
    assert report.invalid_ohlc_rows == 1
    assert report.zero_volume_rate == 1
    assert any("VWAP will fall back" in warning for warning in report.warnings)


def test_naive_chicago_timestamp_is_converted_with_dst() -> None:
    winter = reinterpret_naive_local_candle(
        candle_ending_before("2008-01-02T08:35:00+00:00"),
        ZoneInfo("America/Chicago"),
    )
    summer = reinterpret_naive_local_candle(
        candle_ending_before("2020-06-15T08:35:00+00:00"),
        ZoneInfo("America/Chicago"),
    )

    assert datetime.fromtimestamp(
        winter.start_time / 1000,
        tz=ZoneInfo("America/New_York"),
    ).strftime("%H:%M") == "09:30"
    assert datetime.fromtimestamp(
        summer.start_time / 1000,
        tz=ZoneInfo("America/New_York"),
    ).strftime("%H:%M") == "09:30"


def test_rth_validation_rejects_misaligned_session_open() -> None:
    source_candle = candle_ending_before("2025-01-06T04:35:00-05:00")

    report = validate_candles(
        [source_candle],
        5,
        "America/New_York",
        "rth",
    )

    assert report.is_valid is False
    assert report.session_open_mismatch_dates == 1
