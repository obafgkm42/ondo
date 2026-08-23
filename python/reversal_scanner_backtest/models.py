"""Shared typed models for Python backtests."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

Direction = Literal["bullish", "bearish"]
SignalLevel = Literal["watch", "alert"]
PolicyRole = Literal["bullish_reversal_zone", "bearish_crash_monitor"]


@dataclass(frozen=True)
class Candle:
    """One completed OHLCV candle in the repo's millisecond timestamp shape."""

    start_time: int
    end_time: int
    open: float
    high: float
    low: float
    close: float
    volume: float
    trade_count: int

    @classmethod
    def from_dict(cls, row: dict[str, object]) -> "Candle":
        """Convert a JSON candle row from the existing TypeScript tools."""

        return cls(
            start_time=int(row["startTime"]),
            end_time=int(row["endTime"]),
            open=float(row["open"]),
            high=float(row["high"]),
            low=float(row["low"]),
            close=float(row["close"]),
            volume=float(row["volume"]),
            trade_count=int(row.get("tradeCount", 0)),
        )

    def to_dict(self) -> dict[str, object]:
        """Return the camelCase JSON shape used by the existing repo data."""

        return {
            "startTime": self.start_time,
            "endTime": self.end_time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "tradeCount": self.trade_count,
        }


@dataclass(frozen=True)
class SignalPolicy:
    """Regime policy decision attached to a candidate signal."""

    name: str
    role: PolicyRole
    alert_eligible: bool
    watch_eligible: bool
    reasons: list[str]

    def to_dict(self) -> dict[str, object]:
        """Return the TypeScript-compatible policy JSON shape."""

        return {
            "name": self.name,
            "role": self.role,
            "alertEligible": self.alert_eligible,
            "watchEligible": self.watch_eligible,
            "reasons": self.reasons,
        }


@dataclass(frozen=True)
class ReversalLocation:
    """Frozen signal location emitted by the Python scanner."""

    level: SignalLevel
    direction: Direction
    market: str
    price: float
    entry_low: float
    entry_high: float
    invalidation: float
    target: float
    session_high: float
    session_low: float
    vwap: float
    price_risk_reward: float
    confidence_score: float
    policy: SignalPolicy
    reasons: list[str]
    timestamp: int

    def with_level(self, level: SignalLevel) -> "ReversalLocation":
        """Return a copy with the selected alert/watch level."""

        data = asdict(self)
        data["level"] = level
        data["policy"] = self.policy
        return ReversalLocation(**data)

    def to_dict(self) -> dict[str, object]:
        """Return the TypeScript-compatible signal JSON shape."""

        return {
            "level": self.level,
            "direction": self.direction,
            "market": self.market,
            "price": self.price,
            "entryLow": self.entry_low,
            "entryHigh": self.entry_high,
            "invalidation": self.invalidation,
            "target": self.target,
            "sessionHigh": self.session_high,
            "sessionLow": self.session_low,
            "vwap": self.vwap,
            "priceRiskReward": self.price_risk_reward,
            "confidenceScore": self.confidence_score,
            "policy": self.policy.to_dict(),
            "reasons": self.reasons,
            "timestamp": self.timestamp,
        }


@dataclass(frozen=True)
class ScanResult:
    """Scanner output for one completed-candle evaluation."""

    watch: ReversalLocation | None
    signal: ReversalLocation | None
    market: str
    candle_count: int
    session_high: float | None
    session_low: float | None
    latest_price: float | None
    status: str

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-serializable scanner result."""

        return {
            "watch": self.watch.to_dict() if self.watch else None,
            "signal": self.signal.to_dict() if self.signal else None,
            "market": self.market,
            "candleCount": self.candle_count,
            "sessionHigh": self.session_high,
            "sessionLow": self.session_low,
            "latestPrice": self.latest_price,
            "status": self.status,
        }
