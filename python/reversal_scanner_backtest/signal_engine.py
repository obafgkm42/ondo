"""Frozen v1 signal engine ported from the Cloudflare TypeScript scanner."""

from __future__ import annotations

from dataclasses import dataclass

from reversal_scanner_backtest.models import (
    Candle,
    ReversalLocation,
    Direction,
    ScanResult,
    SignalPolicy,
)

MINIMUM_SESSION_CANDLES = 6
ATR_WINDOW = 12
RANGE_EXTREME_FRACTION = 0.2
MINIMUM_WICK_RATIO = 0.35
MINIMUM_BODY_RATIO = 0.45
MINIMUM_CLOSE_REJECTION = 0.65
VOLUME_SPIKE_MULTIPLIER = 1.2
BULLISH_MINIMUM_DISTANCE_FROM_VWAP_ATR = 0.8
BEARISH_MINIMUM_DISTANCE_FROM_VWAP_ATR = 1.25
MINIMUM_SESSION_RANGE_ATR = 3
MAXIMUM_POLICY_RISK_ATR = 2.25


@dataclass(frozen=True)
class AnalysisThresholds:
    """Signal qualification thresholds for watch and alert levels."""

    minimum_watch_price_r: float
    minimum_watch_confidence_score: float
    minimum_price_r: float
    minimum_confidence_score: float


FROZEN_SIGNAL_V1_THRESHOLDS = AnalysisThresholds(
    minimum_watch_price_r=2,
    minimum_watch_confidence_score=64,
    minimum_price_r=3.5,
    minimum_confidence_score=72,
)
FROZEN_SIGNAL_V1_MARKET = "xyz:SP500"


def analyze_frozen_signal_v1(
    candles_available_at_trigger: list[Candle],
    market: str = FROZEN_SIGNAL_V1_MARKET,
) -> ScanResult:
    """Evaluate the production frozen-v1 signal thresholds."""

    return analyze_session(market, candles_available_at_trigger, FROZEN_SIGNAL_V1_THRESHOLDS)


def analyze_session(
    market: str,
    candles: list[Candle],
    thresholds: AnalysisThresholds,
) -> ScanResult:
    """Find a fresh lookback-extreme rejection with bounded price risk."""

    if len(candles) < MINIMUM_SESSION_CANDLES:
        return _empty_result(market, candles, f"waiting for {MINIMUM_SESSION_CANDLES} completed lookback candles")

    latest = candles[-1]
    prior = candles[:-1]
    session_high = max(candle.high for candle in candles)
    session_low = min(candle.low for candle in candles)
    prior_high = max(candle.high for candle in prior)
    prior_low = min(candle.low for candle in prior)
    vwap = _calculate_vwap(candles)
    atr = _calculate_average_true_range(candles)

    candidates = [
        candidate
        for candidate in [
            _build_candidate("bullish", market, candles, latest, prior_high, prior_low, session_high, session_low, vwap, atr),
            _build_candidate("bearish", market, candles, latest, prior_high, prior_low, session_high, session_low, vwap, atr),
        ]
        if candidate is not None
    ]
    policy_qualified = [candidate for candidate in candidates if candidate.policy.watch_eligible]

    alert = _best_qualified_candidate(
        policy_qualified,
        thresholds.minimum_price_r,
        thresholds.minimum_confidence_score,
        "alert",
    )
    watch_candidate = _best_qualified_candidate(
        policy_qualified,
        thresholds.minimum_watch_price_r,
        thresholds.minimum_watch_confidence_score,
        "watch",
    )
    signal = alert.with_level("alert") if alert else None
    watch = None if signal or watch_candidate is None else watch_candidate.with_level("watch")

    return ScanResult(
        watch=watch,
        signal=signal,
        market=market,
        candle_count=len(candles),
        session_high=session_high,
        session_low=session_low,
        latest_price=latest.close,
        status=_scan_status(signal, watch, len(candidates), len(policy_qualified)),
    )


def _best_qualified_candidate(
    candidates: list[ReversalLocation],
    minimum_price_r: float,
    minimum_confidence_score: float,
    level: str,
) -> ReversalLocation | None:
    qualified = [
        candidate
        for candidate in candidates
        if candidate.price_risk_reward >= minimum_price_r
        and candidate.confidence_score >= minimum_confidence_score
        and (candidate.policy.watch_eligible if level == "watch" else candidate.policy.alert_eligible)
    ]
    qualified.sort(key=lambda candidate: (candidate.confidence_score, candidate.price_risk_reward), reverse=True)
    return qualified[0] if qualified else None


def _scan_status(
    signal: ReversalLocation | None,
    watch: ReversalLocation | None,
    candidate_count: int,
    policy_qualified_count: int,
) -> str:
    if signal is not None:
        return "qualified alert-level modern reversal-zone signal"
    if watch is not None:
        return "watch-level modern reversal-zone setup found; alert thresholds not yet met"
    if candidate_count > 0 and policy_qualified_count == 0:
        return "fresh rejection found, but regime policy kept it out of reversal-zone alerts"
    return "no fresh lookback extreme rejection passed watch or alert thresholds"


def _build_candidate(
    direction: Direction,
    market: str,
    candles: list[Candle],
    latest: Candle,
    prior_high: float,
    prior_low: float,
    session_high: float,
    session_low: float,
    vwap: float,
    atr: float,
) -> ReversalLocation | None:
    bullish = direction == "bullish"
    fresh_extreme = latest.low <= prior_low if bullish else latest.high >= prior_high
    if not fresh_extreme or not _is_rejection_candle(latest, direction):
        return None

    session_range = session_high - session_low
    if session_range <= 0 or atr <= 0:
        return None
    range_position = (latest.close - session_low) / session_range
    at_extreme = range_position <= RANGE_EXTREME_FRACTION if bullish else range_position >= 1 - RANGE_EXTREME_FRACTION
    if not at_extreme:
        return None

    stop_buffer = max(0.5, atr * 0.15)
    invalidation = latest.low - stop_buffer if bullish else latest.high + stop_buffer
    risk = abs(latest.close - invalidation)
    target = _choose_mean_reversion_target(direction, latest.close, vwap, session_high, session_low, candles)
    if target is None or risk <= 0:
        return None

    reward = abs(target - latest.close)
    price_risk_reward = reward / risk
    average_volume = _average([candle.volume for candle in candles[-13:-1]])
    volume_ratio = latest.volume / average_volume if average_volume > 0 else 1
    candle_range = latest.high - latest.low
    wick_ratio = _rejection_wick_ratio(latest, direction)
    extension_in_atr = max(0, prior_low - latest.low) / atr if bullish else max(0, latest.high - prior_high) / atr
    policy = _assess_regime_policy(direction, latest, session_high, session_low, vwap, atr, risk, candle_range, volume_ratio)

    confidence_score = 52
    reasons = [
        f"fresh lookback {'low' if bullish else 'high'} rejected",
        f"close remained in the outer {RANGE_EXTREME_FRACTION * 100}% of the observed range",
        f"invalidation is {risk:.1f} points away",
        f"mean-reversion target {target:.1f} offers {price_risk_reward:.1f}R in underlying price",
    ]
    if wick_ratio >= MINIMUM_WICK_RATIO:
        confidence_score += 8
        reasons.append(f"rejection wick is {wick_ratio * 100:.0f}% of candle range")
    if volume_ratio >= VOLUME_SPIKE_MULTIPLIER:
        confidence_score += 8
        reasons.append(f"volume is {volume_ratio:.1f}x the recent average")
    if extension_in_atr >= 0.15:
        confidence_score += 6
        reasons.append(f"new extreme extended {extension_in_atr:.1f} ATR beyond the prior extreme")
    confidence_score += min(16, round(price_risk_reward * 2))
    if candle_range >= atr * 1.2:
        confidence_score += 5
        reasons.append("reversal candle range is expanded versus recent ATR")

    entry_padding = max(0.5, atr * 0.1)
    return ReversalLocation(
        level="watch",
        direction=direction,
        market=market,
        price=latest.close,
        entry_low=latest.close - entry_padding,
        entry_high=latest.close + entry_padding,
        invalidation=invalidation,
        target=target,
        session_high=session_high,
        session_low=session_low,
        vwap=vwap,
        price_risk_reward=price_risk_reward,
        confidence_score=min(100, confidence_score),
        policy=policy,
        reasons=reasons,
        timestamp=latest.end_time,
    )


def _assess_regime_policy(
    direction: Direction,
    latest: Candle,
    session_high: float,
    session_low: float,
    vwap: float,
    atr: float,
    risk: float,
    candle_range: float,
    volume_ratio: float,
) -> SignalPolicy:
    session_range = session_high - session_low
    distance_from_vwap = abs(latest.close - vwap)
    session_range_in_atr = session_range / atr
    distance_from_vwap_in_atr = distance_from_vwap / atr
    risk_in_atr = risk / atr
    expanded_session = session_range_in_atr >= MINIMUM_SESSION_RANGE_ATR
    bounded_risk = risk_in_atr <= MAXIMUM_POLICY_RISK_ATR
    bullish = direction == "bullish"
    on_correct_side_of_vwap = latest.close < vwap if bullish else latest.close > vwap

    if bullish:
        away_from_vwap = distance_from_vwap_in_atr >= BULLISH_MINIMUM_DISTANCE_FROM_VWAP_ATR
        eligible = on_correct_side_of_vwap and bounded_risk and (expanded_session or away_from_vwap)
        return SignalPolicy(
            name="modern_reversal_zone_v1",
            role="bullish_reversal_zone",
            watch_eligible=eligible,
            alert_eligible=eligible,
            reasons=[
                "bullish-first policy: bottom reversals are the primary trade signal",
                f"distance from VWAP is {distance_from_vwap_in_atr:.1f} ATR",
                f"session range is {session_range_in_atr:.1f} ATR",
                f"risk is {risk_in_atr:.1f} ATR",
                "modern reversal-zone regime gate passed"
                if eligible
                else "held back because the reversal zone is not sufficiently displaced or risk is too wide",
            ],
        )

    away_from_vwap = distance_from_vwap_in_atr >= BEARISH_MINIMUM_DISTANCE_FROM_VWAP_ATR
    stress_candle = candle_range >= atr * 1.2 or volume_ratio >= VOLUME_SPIKE_MULTIPLIER
    eligible = on_correct_side_of_vwap and bounded_risk and expanded_session and away_from_vwap and stress_candle
    return SignalPolicy(
        name="modern_reversal_zone_v1",
        role="bearish_crash_monitor",
        watch_eligible=eligible,
        alert_eligible=eligible,
        reasons=[
            "bearish policy: retained only as a stricter crash/stress monitor",
            f"distance from VWAP is {distance_from_vwap_in_atr:.1f} ATR",
            f"session range is {session_range_in_atr:.1f} ATR",
            f"risk is {risk_in_atr:.1f} ATR",
            "bearish crash-monitor regime gate passed"
            if eligible
            else "held back because bearish reversals need expanded stress conditions",
        ],
    )


def _is_rejection_candle(candle: Candle, direction: Direction) -> bool:
    candle_range = candle.high - candle.low
    if candle_range <= 0:
        return False
    body_ratio = abs(candle.close - candle.open) / candle_range
    close_position = (candle.close - candle.low) / candle_range
    correct_color = candle.close > candle.open if direction == "bullish" else candle.close < candle.open
    rejected_close = close_position >= MINIMUM_CLOSE_REJECTION if direction == "bullish" else close_position <= 1 - MINIMUM_CLOSE_REJECTION
    return correct_color and rejected_close and (
        body_ratio >= MINIMUM_BODY_RATIO or _rejection_wick_ratio(candle, direction) >= MINIMUM_WICK_RATIO
    )


def _rejection_wick_ratio(candle: Candle, direction: Direction) -> float:
    candle_range = candle.high - candle.low
    if candle_range <= 0:
        return 0
    if direction == "bullish":
        return (min(candle.open, candle.close) - candle.low) / candle_range
    return (candle.high - max(candle.open, candle.close)) / candle_range


def _choose_mean_reversion_target(
    direction: Direction,
    price: float,
    vwap: float,
    session_high: float,
    session_low: float,
    candles: list[Candle],
) -> float | None:
    session_midpoint = (session_high + session_low) / 2
    opening_candles = candles[: min(6, len(candles))]
    opening_high = max(candle.high for candle in opening_candles)
    opening_low = min(candle.low for candle in opening_candles)
    if direction == "bullish":
        targets = sorted(target for target in [vwap, session_midpoint, opening_low, opening_high] if target > price)
    else:
        targets = sorted(
            (target for target in [vwap, session_midpoint, opening_high, opening_low] if target < price),
            reverse=True,
        )
    return targets[0] if targets else None


def _calculate_vwap(candles: list[Candle]) -> float:
    total_volume = sum(candle.volume for candle in candles)
    if total_volume <= 0:
        return _average([candle.close for candle in candles])
    return sum(((candle.high + candle.low + candle.close) / 3) * candle.volume for candle in candles) / total_volume


def _calculate_average_true_range(candles: list[Candle]) -> float:
    sample = candles[-(ATR_WINDOW + 1) :]
    true_ranges = []
    for index, candle in enumerate(sample[1:]):
        previous_close = sample[index].close if index < len(sample) else candle.open
        true_ranges.append(max(candle.high - candle.low, abs(candle.high - previous_close), abs(candle.low - previous_close)))
    return _average(true_ranges)


def _average(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0


def _empty_result(market: str, candles: list[Candle], status: str) -> ScanResult:
    return ScanResult(
        watch=None,
        signal=None,
        market=market,
        candle_count=len(candles),
        session_high=None,
        session_low=None,
        latest_price=candles[-1].close if candles else None,
        status=status,
    )
