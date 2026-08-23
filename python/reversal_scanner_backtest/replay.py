"""Replay settings that mirror the production scanner cadence."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal
from zoneinfo import ZoneInfo

from reversal_scanner_backtest.models import Candle, ReversalLocation

ReplayMode = Literal["live", "every-bar"]
NotificationStatus = Literal[
    "fresh",
    "outside_entry_zone",
    "invalidated_before_delivery",
    "target_reached_before_delivery",
    "no_delivery_bar",
]


@dataclass(frozen=True)
class DeliveryDecision:
    """Actionability state when a historical signal reaches the user."""

    observed_at: int
    observed_price: float
    status: NotificationStatus
    execution_candles: list[Candle]


@dataclass(frozen=True)
class ReplaySettings:
    """Configuration for selecting historical scanner invocations."""

    mode: ReplayMode = "live"
    regular_scan_minutes: int = 15
    final_hour_scan_minutes: int = 5
    request_lookback_hours: int = 18
    session_time_zone: str = "America/New_York"

    def validate(self) -> None:
        """Raise when a replay setting cannot represent the live scanner."""

        if self.regular_scan_minutes <= 0:
            raise ValueError("regular_scan_minutes must be positive")
        if self.final_hour_scan_minutes <= 0:
            raise ValueError("final_hour_scan_minutes must be positive")
        if self.request_lookback_hours <= 0:
            raise ValueError("request_lookback_hours must be positive")
        ZoneInfo(self.session_time_zone)


def should_evaluate_candle(candle: Candle, settings: ReplaySettings) -> bool:
    """Return whether production can evaluate this completed candle.

    Live requests occur at configured boundaries, but each request catches up
    every completed five-minute candle since the prior request. Event replay
    can therefore evaluate every candle while retaining the live fetch window.
    """

    return True


def is_request_boundary(candle: Candle, settings: ReplaySettings) -> bool:
    """Return whether the live Worker would issue a candle request."""

    if settings.mode == "every-bar":
        return True
    boundary = datetime.fromtimestamp(
        (candle.end_time + 1) / 1000,
        tz=ZoneInfo(settings.session_time_zone),
    )
    interval_minutes = (
        settings.final_hour_scan_minutes
        if boundary.hour == 15
        else settings.regular_scan_minutes
    )
    return boundary.minute % interval_minutes == 0


def available_history(
    session_candles: list[Candle],
    trigger_candle: Candle,
    settings: ReplaySettings,
) -> list[Candle]:
    """Return the candles the live fetch window would expose at a trigger."""

    if settings.mode == "every-bar":
        return list(session_candles)

    cutoff = trigger_candle.end_time - settings.request_lookback_hours * 60 * 60 * 1000
    return [candle for candle in session_candles if candle.end_time >= cutoff]


def build_delivery_decision(
    session_candles: list[Candle],
    signal_index: int,
    signal: ReversalLocation,
    settings: ReplaySettings,
) -> DeliveryDecision:
    """Revalidate a signal at its first production notification boundary."""

    observed_at = notification_delivery_time(
        session_candles[signal_index],
        settings,
    )
    delivery_index = next(
        (
            index
            for index in range(signal_index + 1, len(session_candles))
            if session_candles[index].start_time >= observed_at
        ),
        None,
    )
    if delivery_index is None:
        return DeliveryDecision(
            observed_at=observed_at,
            observed_price=session_candles[-1].close,
            status="no_delivery_bar",
            execution_candles=[],
        )

    observed_price = session_candles[delivery_index - 1].close
    pre_delivery = session_candles[signal_index + 1 : delivery_index]
    if any(
        _stop_touched(signal, candle)
        for candle in pre_delivery
    ):
        status: NotificationStatus = "invalidated_before_delivery"
    elif any(
        _target_touched(signal, candle)
        for candle in pre_delivery
    ):
        status = "target_reached_before_delivery"
    elif not signal.entry_low <= observed_price <= signal.entry_high:
        status = "outside_entry_zone"
    else:
        status = "fresh"
    return DeliveryDecision(
        observed_at=observed_at,
        observed_price=observed_price,
        status=status,
        execution_candles=session_candles[delivery_index:],
    )


def notification_delivery_time(
    signal_candle: Candle,
    settings: ReplaySettings,
) -> int:
    """Return the earliest request boundary that can see a completed candle."""

    completed_at = signal_candle.end_time + 1
    if settings.mode == "every-bar":
        return completed_at
    time_zone = ZoneInfo(settings.session_time_zone)
    candidate = datetime.fromtimestamp(
        completed_at / 1000,
        tz=time_zone,
    ).replace(second=0, microsecond=0)
    for _ in range(24 * 60):
        interval_minutes = (
            settings.final_hour_scan_minutes
            if candidate.hour == 15
            else settings.regular_scan_minutes
        )
        if candidate.minute % interval_minutes == 0:
            return int(candidate.timestamp() * 1000)
        candidate += timedelta(minutes=1)
    raise RuntimeError("unable to find a notification boundary")


def _stop_touched(
    signal: ReversalLocation,
    candle: Candle,
) -> bool:
    return (
        candle.low <= signal.invalidation
        if signal.direction == "bullish"
        else candle.high >= signal.invalidation
    )


def _target_touched(
    signal: ReversalLocation,
    candle: Candle,
) -> bool:
    return (
        candle.high >= signal.target
        if signal.direction == "bullish"
        else candle.low <= signal.target
    )
