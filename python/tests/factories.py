"""Deterministic test data builders for the Python research package."""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from reversal_scanner_backtest.models import (
    Candle,
    Direction,
    ReversalLocation,
    SignalPolicy,
)


def candle(
    index: int,
    open_price: float,
    high: float,
    low: float,
    close: float,
    volume: float,
) -> Candle:
    """Build one deterministic five-minute candle from a numeric index."""

    return Candle(
        start_time=index * 300_000,
        end_time=index * 300_000 + 299_999,
        open=open_price,
        high=high,
        low=low,
        close=close,
        volume=volume,
        trade_count=10,
    )


def candle_at(
    value: str,
    open_price: float,
    high: float,
    low: float,
    close: float,
    volume: float,
) -> Candle:
    """Build one five-minute candle ending at an ISO-8601 timestamp."""

    end_time = int(
        datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    )
    return Candle(
        start_time=end_time - 299_999,
        end_time=end_time,
        open=open_price,
        high=high,
        low=low,
        close=close,
        volume=volume,
        trade_count=10,
    )


def candle_ending_before(value: str, volume: float = 100) -> Candle:
    """Build a five-minute candle ending one millisecond before a boundary."""

    boundary = datetime.fromisoformat(value).astimezone(ZoneInfo("UTC"))
    end_time = int(boundary.timestamp() * 1000) - 1
    return Candle(
        start_time=end_time - 299_999,
        end_time=end_time,
        open=100,
        high=101,
        low=99,
        close=100,
        volume=volume,
        trade_count=10,
    )


def signal_from_candle(
    signal_candle: Candle,
    direction: Direction,
    invalidation: float,
    target: float,
) -> ReversalLocation:
    """Build a canonical alert around a supplied signal candle."""

    return ReversalLocation(
        level="alert",
        direction=direction,
        market="SPX",
        price=signal_candle.close,
        entry_low=signal_candle.close - 0.5,
        entry_high=signal_candle.close + 0.5,
        invalidation=invalidation,
        target=target,
        session_high=120,
        session_low=90,
        vwap=105,
        price_risk_reward=4,
        confidence_score=80,
        policy=SignalPolicy(
            name="test",
            role="bullish_reversal_zone",
            alert_eligible=True,
            watch_eligible=True,
            reasons=[],
        ),
        reasons=[],
        timestamp=signal_candle.end_time,
    )


def reversal_signal(signal_candle: Candle) -> ReversalLocation:
    """Build a simple delivery-revalidation signal."""

    return ReversalLocation(
        level="alert",
        direction="bullish",
        market="SPX",
        price=100,
        entry_low=99,
        entry_high=101,
        invalidation=95,
        target=110,
        session_high=110,
        session_low=95,
        vwap=105,
        price_risk_reward=2,
        confidence_score=80,
        policy=SignalPolicy(
            name="test",
            role="bullish_reversal_zone",
            alert_eligible=True,
            watch_eligible=True,
            reasons=[],
        ),
        reasons=[],
        timestamp=signal_candle.end_time,
    )


def candles_from_closes(closes: list[float]) -> list[Candle]:
    """Build deterministic candles matching the TypeScript fixtures."""

    start = datetime.fromisoformat("2026-07-31T09:30:00-04:00")
    result: list[Candle] = []
    for index, close in enumerate(closes):
        open_price = close if index == 0 else closes[index - 1]
        start_time = int((start + timedelta(minutes=5 * index)).timestamp() * 1000)
        result.append(
            Candle(
                start_time=start_time,
                end_time=start_time + 299_999,
                open=open_price,
                high=max(open_price, close) + 0.05,
                low=min(open_price, close) - 0.05,
                close=close,
                volume=100,
                trade_count=10,
            )
        )
    return result


def session_candles(
    closes: list[float],
    session_date: str = "2025-01-06",
) -> list[Candle]:
    """Build one New York RTH session from 09:30 onward."""

    start = datetime.fromisoformat(f"{session_date}T09:30:00").replace(
        tzinfo=ZoneInfo("America/New_York")
    )
    result: list[Candle] = []
    for index, close in enumerate(closes):
        open_price = close if index == 0 else closes[index - 1]
        start_time = int((start + timedelta(minutes=index * 5)).timestamp() * 1000)
        result.append(
            Candle(
                start_time=start_time,
                end_time=start_time + 299_999,
                open=open_price,
                high=max(open_price, close) + 0.05,
                low=min(open_price, close) - 0.05,
                close=close,
                volume=100,
                trade_count=10,
            )
        )
    return result
