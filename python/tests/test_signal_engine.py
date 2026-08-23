"""Regression tests for the Python research signal engine."""

from __future__ import annotations

from reversal_scanner_backtest.signal_engine import analyze_frozen_signal_v1

from factories import candle


def test_frozen_signal_uses_only_completed_candles() -> None:
    candles = [
        candle(0, 125, 130, 91.2, 126, 100),
        candle(1, 126, 129, 92, 125, 100),
        candle(2, 125, 128, 93, 124, 100),
        candle(3, 124, 127, 94, 123, 100),
        candle(4, 123, 126, 95, 122, 100),
        candle(5, 122, 125, 96, 121, 100),
        candle(6, 92.6, 93.1, 91.2, 92.5, 100),
        candle(7, 92.5, 93, 91.2, 92.4, 100),
        candle(8, 92.4, 92.9, 91.2, 92.3, 100),
        candle(9, 92.3, 92.8, 91.2, 92.2, 100),
        candle(10, 92.2, 92.7, 91.2, 92.1, 100),
        candle(11, 92.1, 92.6, 91.2, 92, 100),
        candle(12, 92, 92.5, 91.2, 91.9, 100),
        candle(13, 91.9, 92.4, 91.2, 91.8, 100),
        candle(14, 91.8, 92.3, 91.2, 91.7, 100),
        candle(15, 91.7, 92.2, 91.2, 91.6, 100),
        candle(16, 91.6, 92.1, 91.2, 91.5, 100),
        candle(17, 91.5, 92, 91.2, 91.4, 100),
        candle(18, 91.4, 91.9, 91.2, 91.3, 100),
        candle(19, 91.1, 92, 91, 91.8, 500),
    ]

    result = analyze_frozen_signal_v1(candles, "SPX")

    assert result.signal is not None
    assert result.signal.direction == "bullish"
    assert result.signal.price == 91.8
    assert "fresh lookback low rejected" in result.signal.reasons
