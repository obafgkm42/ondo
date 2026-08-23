"""Event-study backtest logic for frozen reversal signals."""

from __future__ import annotations

import csv
import io
import random
from collections.abc import Callable, Iterable
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from statistics import median
from typing import Literal
from zoneinfo import ZoneInfo

from reversal_scanner_backtest.models import Candle, ReversalLocation, Direction
from reversal_scanner_backtest.replay import DeliveryDecision

TouchOrderingMode = str
EntryMode = Literal["signal-close", "next-open"]
TOUCH_MODES: tuple[TouchOrderingMode, ...] = ("conservative", "optimistic", "ambiguous_excluded")
FIXED_STOP_WIDTHS = (10, 15, 20, 25)
SWEEP_TOLERANCE_MINUTES = (10, 15, 30)
WINDOW_DEFINITIONS: tuple[tuple[str, int | None], ...] = (("30m", 30), ("60m", 60), ("120m", 120), ("eod", None))
SESSION_TIME_ZONE = ZoneInfo("America/New_York")


@dataclass(frozen=True)
class ExecutionAssumptions:
    """Explicit fill and cost assumptions for trade-policy simulations."""

    entry_mode: EntryMode = "signal-close"
    slippage_points: float = 0
    round_trip_cost_points: float = 0
    enforce_entry_zone: bool = True

    def validate(self) -> None:
        """Raise when execution costs or entry mode are invalid."""

        if self.slippage_points < 0:
            raise ValueError("slippage_points must be non-negative")
        if self.round_trip_cost_points < 0:
            raise ValueError("round_trip_cost_points must be non-negative")


@dataclass(frozen=True)
class ExecutionEntry:
    """Resolved executable entry derived from a completed signal candle."""

    status: str
    price: float | None
    timestamp: int | None
    candles: list[Candle]


@dataclass(frozen=True)
class WindowMetrics:
    """Path metrics for one forward window."""

    eod_directional_points: float | None
    mfe_points: float | None
    mae_points: float | None
    max_future_high: float | None
    min_future_low: float | None
    hit10_mfe: bool
    hit15_mfe: bool
    hit20_mfe: bool
    hit30_mfe: bool
    hit20_eod: bool
    time_to_mfe20_minutes: float | None
    mfe_mae_ratio: float | None


@dataclass(frozen=True)
class TradeResult:
    """Simulated trade result under a specific stop or target policy."""

    points: float
    r: float | None
    exit_reason: str
    ambiguous: bool
    eod_runner_contribution: float | None = None
    exit_timestamp: int | None = None


@dataclass(frozen=True)
class StopOutStudy:
    """Diagnostics for stop-out and re-entry behavior after the signal."""

    initial_entry_price: float
    stopped_out: bool
    first_stop_out_time: str | None
    first_stop_out_loss_points: float | None
    points_after_stopout: float | None
    swept_then_reversed: bool
    time_from_stopout_to_reversal_minutes: float | None
    max_adverse_before_post_stop20_points: float | None
    wider_stop_would_improve: bool
    delayed_entry5m: TradeResult | None
    delayed_entry_after_confirmation: TradeResult | None
    reentry_after_stopout: TradeResult | None
    one_retry_policy: TradeResult | None
    two_retry_policy: TradeResult | None


@dataclass(frozen=True)
class ReversalEvent:
    """One frozen signal with all forward-path study metrics."""

    date: str
    timestamp: str
    weekday: int
    hour: int
    signal_level: str
    direction: Direction
    entry_price: float
    entry_low: float
    entry_high: float
    observed_at: str
    observed_price: float
    notification_latency_minutes: float
    notification_status: str
    execution_entry_price: float | None
    execution_entry_time: str | None
    execution_status: str
    execution_risk_points: float | None
    signal_high: float
    signal_low: float
    signal_close: float
    invalidation: float
    risk_points: float
    target: float
    target_points: float
    target_r: float | None
    eod_close: float | None
    eod_directional_points: float | None
    mfe_points: float | None
    mae_points: float | None
    max_future_high: float | None
    min_future_low: float | None
    hit10_mfe: bool
    hit15_mfe: bool
    hit20_mfe: bool
    hit30_mfe: bool
    hit20_eod: bool
    time_to_mfe20_minutes: float | None
    mfe_mae_ratio: float | None
    mae_before_mfe20_points: float | None
    swept_invalidation: bool
    sweep_depth_points: float | None
    sweep_depth_from_entry_points: float | None
    recovered_after_sweep: bool
    hit20_after_sweep: bool
    time_to_sweep_minutes: float | None
    time_from_sweep_to_recover_minutes: float | None
    time_from_sweep_to_mfe20_minutes: float | None
    confirmation_triggered: bool
    confirmation_entry_price: float | None
    confirmation_delay_minutes: float | None
    confirmation_mfe_points: float | None
    confirmation_mae_points: float | None
    confirmation_eod_points: float | None
    confirmation_hit20_mfe: bool
    confirmation_hit20_eod: bool
    second_sweep_triggered: bool
    second_sweep_entry_price: float | None
    second_sweep_delay_minutes: float | None
    second_sweep_mfe_points: float | None
    second_sweep_mae_points: float | None
    second_sweep_eod_points: float | None
    second_sweep_hit20_mfe: bool
    second_sweep_hit20_eod: bool
    distance_from_vwap_points: float
    atr_points: float
    session_range_in_atr: float | None
    opening_range_distance_points: float | None
    fresh_extreme_lookback_bucket: str
    risk_points_bucket: str
    target_r_bucket: str
    distance_from_vwap_bucket: str
    time_of_day_bucket: str
    day_type: str
    windows: dict[str, WindowMetrics] = field(default_factory=dict)
    current_stop: dict[TouchOrderingMode, TradeResult | None] = field(default_factory=dict)
    fixed_stops: dict[str, dict[TouchOrderingMode, TradeResult | None]] = field(default_factory=dict)
    sweep_tolerant_stops: dict[str, TradeResult | None] = field(default_factory=dict)
    fixed20_take_profit: dict[str, dict[TouchOrderingMode, TradeResult | None]] = field(default_factory=dict)
    partial20_runner: dict[str, dict[str, dict[TouchOrderingMode, TradeResult | None]]] = field(default_factory=dict)
    stop_out_study: StopOutStudy | None = None


@dataclass(frozen=True)
class TradeStats:
    """Aggregated trade performance stats."""

    trades: int
    ambiguous_trades: int
    ambiguous_rate: float | None
    win_rate: float | None
    avg_points: float | None
    median_points: float | None
    profit_factor: float | None
    average_r: float | None
    max_losing_streak: int
    expectancy: float | None
    hit20_rate: float | None
    eod_runner_contribution: float | None


@dataclass(frozen=True)
class SinglePositionSummary:
    """Execution results when only one conservative position may be open."""

    executable_signals: int
    selected_trades: int
    skipped_overlapping: int
    performance: TradeStats


@dataclass(frozen=True)
class StopOutSummary:
    """Aggregated stop-out and re-entry diagnostics."""

    stopped_out_rate: float | None
    swept_then_reversed_rate: float | None
    avg_points_after_stopout: float | None
    median_minutes_from_stopout_to_reversal: float | None
    median_max_adverse_before_post_stop20: float | None
    wider_stop_would_improve_rate: float | None
    reentry_after_stopout: TradeStats
    one_retry_policy: TradeStats
    two_retry_policy: TradeStats
    delayed_entry5m: TradeStats
    delayed_entry_after_confirmation: TradeStats


@dataclass(frozen=True)
class ReversalSummary:
    """High-level summary of reversal events."""

    signal_count: int
    execution_status_counts: dict[str, int]
    eod_win_rate: float | None
    eod_avg_points: float | None
    eod_median_points: float | None
    mfe_avg_points: float | None
    mfe_median_points: float | None
    mae_median_points: float | None
    mfe20_rate: float | None
    eod20_rate: float | None
    median_time_to_plus20: float | None
    median_mae_before_plus20: float | None
    swept_invalidation_rate: float | None
    recovered_after_sweep_rate: float | None
    hit20_after_sweep_rate: float | None
    current_stop_performance: dict[TouchOrderingMode, TradeStats]
    stop_out_study: StopOutSummary


@dataclass(frozen=True)
class MetricConfidenceInterval:
    """Point estimate and cluster-bootstrap confidence interval."""

    estimate: float | None
    lower_95: float | None
    upper_95: float | None


@dataclass(frozen=True)
class ClusterBootstrapSummary:
    """Uncertainty estimates sampled by session date rather than event."""

    runs: int
    seed: int
    cluster_count: int
    mfe20_rate: MetricConfidenceInterval
    eod_avg_points: MetricConfidenceInterval
    current_stop_avg_points: MetricConfidenceInterval
    current_stop_profit_factor: MetricConfidenceInterval


@dataclass(frozen=True)
class PlaceboSample:
    """Minimal event metrics required by the random placebo comparison."""

    hit20_mfe: bool
    hit20_eod: bool
    mfe_points: float | None
    mae_points: float | None
    current_stop: TradeResult | None


@dataclass(frozen=True)
class PlaceboCandidate:
    """Random-entry candidate with pre-trigger volatility features."""

    candle: Candle
    atr_points: float
    session_range_in_atr: float | None
    date: str


def set_backtest_session_time_zone(time_zone: str) -> None:
    """Set the timezone used for session grouping and hour buckets."""

    global SESSION_TIME_ZONE
    SESSION_TIME_ZONE = ZoneInfo(time_zone)


def build_candle_session_index(candles: list[Candle]) -> dict[int, tuple[list[Candle], int]]:
    """Index candles by session date for cheap forward-slice lookup."""

    sessions: dict[str, list[Candle]] = {}
    for candle in candles:
        sessions.setdefault(date_key(candle.end_time), []).append(candle)
    index: dict[int, tuple[list[Candle], int]] = {}
    for session in sessions.values():
        for position, candle in enumerate(session):
            index[candle.end_time] = (session, position)
    return index


def resolve_execution_entry(
    signal: ReversalLocation,
    same_day_future: list[Candle],
    assumptions: ExecutionAssumptions,
    notification_status: str = "fresh",
) -> ExecutionEntry:
    """Resolve a signal-close or next-bar-open fill without lookahead."""

    if notification_status != "fresh":
        return ExecutionEntry(
            status=f"notification_{notification_status}",
            price=None,
            timestamp=None,
            candles=same_day_future,
        )
    if assumptions.entry_mode == "signal-close":
        raw_price = signal.price
        timestamp = signal.timestamp
        execution_candles = same_day_future
    elif not same_day_future:
        return ExecutionEntry(
            status="no_next_session_bar",
            price=None,
            timestamp=None,
            candles=[],
        )
    else:
        first_candle = same_day_future[0]
        raw_price = first_candle.open
        timestamp = first_candle.start_time
        execution_candles = same_day_future

    if (
        assumptions.enforce_entry_zone
        and not signal.entry_low <= raw_price <= signal.entry_high
    ):
        return ExecutionEntry(
            status="outside_entry_zone_at_entry",
            price=None,
            timestamp=timestamp,
            candles=execution_candles,
        )
    if is_beyond_stop(signal.direction, raw_price, signal.invalidation):
        return ExecutionEntry(
            status="invalid_before_entry",
            price=None,
            timestamp=timestamp,
            candles=execution_candles,
        )
    if is_beyond_target(signal.direction, raw_price, signal.target):
        return ExecutionEntry(
            status="target_passed_before_entry",
            price=None,
            timestamp=timestamp,
            candles=execution_candles,
        )
    price = apply_entry_slippage(
        signal.direction,
        raw_price,
        assumptions.slippage_points,
    )
    if is_beyond_target(signal.direction, price, signal.target):
        return ExecutionEntry(
            status="target_passed_after_entry_slippage",
            price=None,
            timestamp=timestamp,
            candles=execution_candles,
        )
    return ExecutionEntry(
        status="filled",
        price=price,
        timestamp=timestamp,
        candles=execution_candles,
    )


def risk_for_stop(
    entry_price: float,
    stop: float,
    assumptions: ExecutionAssumptions,
) -> float:
    """Return actual point risk including exit slippage and round-trip cost."""

    return (
        abs(entry_price - stop)
        + assumptions.slippage_points
        + assumptions.round_trip_cost_points
    )


def build_reversal_event(
    signal: ReversalLocation,
    signal_candle: Candle,
    candles_available_at_signal: list[Candle],
    future_candles: list[Candle],
    execution_assumptions: ExecutionAssumptions | None = None,
    delivery_decision: DeliveryDecision | None = None,
) -> ReversalEvent:
    """Build path-based metrics for one frozen signal without lookahead."""

    assumptions = execution_assumptions or ExecutionAssumptions()
    assumptions.validate()
    session_date = date_key(signal.timestamp)
    same_day_future = [candle for candle in future_candles if date_key(candle.end_time) == session_date]
    delivery = delivery_decision or DeliveryDecision(
        observed_at=signal.timestamp + 1,
        observed_price=signal.price,
        status="fresh",
        execution_candles=same_day_future,
    )
    same_day_execution_candles = [
        candle
        for candle in delivery.execution_candles
        if date_key(candle.end_time) == session_date
    ]
    eod = same_day_future[-1] if same_day_future else None
    eod_close = eod.close if eod else None
    risk_points = abs(signal.price - signal.invalidation)
    atr_points = average_true_range(candles_available_at_signal)
    observed_session_range = (
        max(candle.high for candle in candles_available_at_signal)
        - min(candle.low for candle in candles_available_at_signal)
    )
    target_points = directional_points(signal.direction, signal.price, signal.target)
    base_metrics = metrics_for_window(signal.direction, signal.price, eod_close, same_day_future, signal.timestamp)
    sweep = second_sweep_analysis(signal, signal_candle, same_day_future)
    confirmation = confirmation_entry(signal, signal_candle, same_day_future, eod_close)
    second_sweep = second_sweep_entry(signal, signal_candle, same_day_future, eod_close)
    eastern = time_parts(signal.timestamp)
    execution = resolve_execution_entry(
        signal,
        same_day_execution_candles,
        assumptions,
        delivery.status,
    )
    execution_entry_price = execution.price
    execution_risk_points = (
        None
        if execution_entry_price is None
        else risk_for_stop(
            execution_entry_price,
            signal.invalidation,
            assumptions,
        )
    )
    fixed_stop_keys = ["current", *[f"{width}pt" for width in FIXED_STOP_WIDTHS]]
    current_stop: dict[TouchOrderingMode, TradeResult | None] = {
        mode: None for mode in TOUCH_MODES
    }
    fixed_stops: dict[str, dict[TouchOrderingMode, TradeResult | None]] = {}
    sweep_tolerant_stops: dict[str, TradeResult | None] = {}
    fixed20_take_profit: dict[
        str, dict[TouchOrderingMode, TradeResult | None]
    ] = {}
    partial20_runner: dict[
        str, dict[str, dict[TouchOrderingMode, TradeResult | None]]
    ] = {}
    stop_out: StopOutStudy | None = None
    if execution_entry_price is not None and execution_risk_points is not None:
        current_stop = {
            mode: simulate_stop_target(
                signal.direction,
                execution_entry_price,
                signal.invalidation,
                signal.target,
                execution.candles,
                eod_close,
                execution_risk_points,
                mode,
                assumptions,
            )
            for mode in TOUCH_MODES
        }
        fixed_stops = {
            f"{width}pt": {
                mode: simulate_stop_target(
                    signal.direction,
                    execution_entry_price,
                    target_price(signal.direction, execution_entry_price, -width),
                    None,
                    execution.candles,
                    eod_close,
                    risk_for_stop(
                        execution_entry_price,
                        target_price(signal.direction, execution_entry_price, -width),
                        assumptions,
                    ),
                    mode,
                    assumptions,
                )
                for mode in TOUCH_MODES
            }
            for width in FIXED_STOP_WIDTHS
        }
        sweep_tolerant_stops = {
            f"{minutes}m": simulate_sweep_tolerant_stop(
                signal.direction,
                execution_entry_price,
                signal.invalidation,
                signal_candle.close,
                execution.candles,
                eod_close,
                execution_risk_points,
                minutes,
                assumptions,
            )
            for minutes in SWEEP_TOLERANCE_MINUTES
        }
        fixed20_take_profit = {
            key: {
                mode: simulate_stop_target(
                    signal.direction,
                    execution_entry_price,
                    stop_for_key(
                        signal.direction,
                        execution_entry_price,
                        signal.invalidation,
                        key,
                    ),
                    target_price(signal.direction, execution_entry_price, 20),
                    execution.candles,
                    eod_close,
                    risk_for_stop(
                        execution_entry_price,
                        stop_for_key(
                            signal.direction,
                            execution_entry_price,
                            signal.invalidation,
                            key,
                        ),
                        assumptions,
                    ),
                    mode,
                    assumptions,
                )
                for mode in TOUCH_MODES
            }
            for key in fixed_stop_keys
        }
        partial20_runner = {
            key: {
                mode_name: {
                    mode: simulate_partial_runner(
                        signal.direction,
                        execution_entry_price,
                        stop_for_key(
                            signal.direction,
                            execution_entry_price,
                            signal.invalidation,
                            key,
                        ),
                        execution.candles,
                        eod_close,
                        risk_for_stop(
                            execution_entry_price,
                            stop_for_key(
                                signal.direction,
                                execution_entry_price,
                                signal.invalidation,
                                key,
                            ),
                            assumptions,
                        ),
                        mode,
                        mode_name == "breakevenAfter20",
                        assumptions,
                    )
                    for mode in TOUCH_MODES
                }
                for mode_name in ("noBreakeven", "breakevenAfter20")
            }
            for key in fixed_stop_keys
        }
        stop_out = build_stop_out_study(
            signal,
            signal_candle,
            execution_entry_price,
            execution.candles,
            eod_close,
            execution_risk_points,
            assumptions,
        )
    return ReversalEvent(
        date=session_date,
        timestamp=iso_timestamp(signal.timestamp),
        weekday=eastern["weekday"],
        hour=eastern["hour"],
        signal_level=signal.level,
        direction=signal.direction,
        entry_price=signal.price,
        entry_low=signal.entry_low,
        entry_high=signal.entry_high,
        observed_at=iso_timestamp(delivery.observed_at),
        observed_price=delivery.observed_price,
        notification_latency_minutes=minutes_between(
            signal.timestamp + 1,
            delivery.observed_at,
        ),
        notification_status=delivery.status,
        execution_entry_price=execution_entry_price,
        execution_entry_time=(
            None
            if execution.timestamp is None
            else iso_timestamp(execution.timestamp)
        ),
        execution_status=execution.status,
        execution_risk_points=execution_risk_points,
        signal_high=signal_candle.high,
        signal_low=signal_candle.low,
        signal_close=signal_candle.close,
        invalidation=signal.invalidation,
        risk_points=risk_points,
        target=signal.target,
        target_points=target_points,
        target_r=target_points / risk_points if risk_points > 0 else None,
        eod_close=eod_close,
        eod_directional_points=base_metrics.eod_directional_points,
        mfe_points=base_metrics.mfe_points,
        mae_points=base_metrics.mae_points,
        max_future_high=base_metrics.max_future_high,
        min_future_low=base_metrics.min_future_low,
        hit10_mfe=base_metrics.hit10_mfe,
        hit15_mfe=base_metrics.hit15_mfe,
        hit20_mfe=base_metrics.hit20_mfe,
        hit30_mfe=base_metrics.hit30_mfe,
        hit20_eod=base_metrics.hit20_eod,
        time_to_mfe20_minutes=base_metrics.time_to_mfe20_minutes,
        mfe_mae_ratio=base_metrics.mfe_mae_ratio,
        mae_before_mfe20_points=mae_before_mfe20(signal.direction, signal.price, same_day_future),
        distance_from_vwap_points=directional_points(signal.direction, signal.vwap, signal.price),
        atr_points=atr_points,
        session_range_in_atr=(
            None if atr_points <= 0 else observed_session_range / atr_points
        ),
        opening_range_distance_points=opening_range_distance(signal.direction, signal.price, candles_available_at_signal),
        fresh_extreme_lookback_bucket=fresh_extreme_lookback_bucket(signal.direction, signal_candle, candles_available_at_signal),
        risk_points_bucket=bucket_number(risk_points, [5, 10, 15, 20, 30]),
        target_r_bucket=">=6R" if signal.price_risk_reward >= 6 else "4-6R" if signal.price_risk_reward >= 4 else "<4R",
        distance_from_vwap_bucket=bucket_number(abs(signal.price - signal.vwap), [10, 20, 30, 50]),
        time_of_day_bucket=time_of_day_bucket(signal.timestamp),
        day_type=classify_day(candles_available_at_signal, same_day_future),
        windows={
            key: metrics_for_window(
                signal.direction,
                signal.price,
                eod_close,
                same_day_future if minutes is None else [c for c in same_day_future if c.end_time <= signal.timestamp + minutes * 60_000],
                signal.timestamp,
            )
            for key, minutes in WINDOW_DEFINITIONS
        },
        current_stop=current_stop,
        fixed_stops=fixed_stops,
        sweep_tolerant_stops=sweep_tolerant_stops,
        fixed20_take_profit=fixed20_take_profit,
        partial20_runner=partial20_runner,
        stop_out_study=stop_out,
        **sweep,
        **confirmation,
        **second_sweep,
    )


def summarize_reversal_events(events: list[ReversalEvent]) -> ReversalSummary:
    """Aggregate event-level reversal-zone evidence."""

    swept = [event for event in events if event.swept_invalidation]
    winners = [event for event in events if event.mae_before_mfe20_points is not None]
    return ReversalSummary(
        signal_count=len(events),
        execution_status_counts=count_values(event.execution_status for event in events),
        eod_win_rate=rate(events, lambda event: (event.eod_directional_points or 0) > 0),
        eod_avg_points=average_or_none(event.eod_directional_points for event in events),
        eod_median_points=median_or_none(event.eod_directional_points for event in events),
        mfe_avg_points=average_or_none(event.mfe_points for event in events),
        mfe_median_points=median_or_none(event.mfe_points for event in events),
        mae_median_points=median_or_none(event.mae_points for event in events),
        mfe20_rate=rate(events, lambda event: event.hit20_mfe),
        eod20_rate=rate(events, lambda event: event.hit20_eod),
        median_time_to_plus20=median_or_none(event.time_to_mfe20_minutes for event in events),
        median_mae_before_plus20=median_or_none(event.mae_before_mfe20_points for event in winners),
        swept_invalidation_rate=rate(events, lambda event: event.swept_invalidation),
        recovered_after_sweep_rate=None if not swept else rate(swept, lambda event: event.recovered_after_sweep),
        hit20_after_sweep_rate=None if not swept else rate(swept, lambda event: event.hit20_after_sweep),
        current_stop_performance=trade_stats_by_mode([event.current_stop for event in events]),
        stop_out_study=stop_out_summary(events),
    )


def summarize_events_by_direction(
    events: list[ReversalEvent],
) -> dict[Direction, ReversalSummary]:
    """Keep bullish trade signals separate from bearish crash monitoring."""

    return {
        direction: summarize_reversal_events(
            [event for event in events if event.direction == direction]
        )
        for direction in ("bullish", "bearish")
    }


def build_cluster_bootstrap_summary(
    events: list[ReversalEvent],
    runs: int,
    seed: int = 42,
) -> ClusterBootstrapSummary | None:
    """Estimate metric uncertainty by resampling whole session dates."""

    if not events or runs <= 0:
        return None
    clusters: dict[str, list[ReversalEvent]] = {}
    for event in events:
        clusters.setdefault(event.date, []).append(event)
    cluster_values = list(clusters.values())
    rng = random.Random(seed)
    distributions: dict[str, list[float]] = {
        "mfe20Rate": [],
        "eodAvgPoints": [],
        "currentStopAvgPoints": [],
        "currentStopProfitFactor": [],
    }
    for _ in range(runs):
        sampled = [
            event
            for cluster in rng.choices(cluster_values, k=len(cluster_values))
            for event in cluster
        ]
        current_stop = trade_stats(
            [event.current_stop.get("conservative") for event in sampled]
        )
        push_metric(
            distributions["mfe20Rate"],
            rate(sampled, lambda event: event.hit20_mfe),
        )
        push_metric(
            distributions["eodAvgPoints"],
            average_or_none(event.eod_directional_points for event in sampled),
        )
        push_metric(
            distributions["currentStopAvgPoints"],
            current_stop.avg_points,
        )
        push_metric(
            distributions["currentStopProfitFactor"],
            current_stop.profit_factor,
        )

    real_summary = summarize_reversal_events(events)
    real_current_stop = real_summary.current_stop_performance["conservative"]
    return ClusterBootstrapSummary(
        runs=runs,
        seed=seed,
        cluster_count=len(cluster_values),
        mfe20_rate=confidence_interval(
            real_summary.mfe20_rate,
            distributions["mfe20Rate"],
        ),
        eod_avg_points=confidence_interval(
            real_summary.eod_avg_points,
            distributions["eodAvgPoints"],
        ),
        current_stop_avg_points=confidence_interval(
            real_current_stop.avg_points,
            distributions["currentStopAvgPoints"],
        ),
        current_stop_profit_factor=confidence_interval(
            real_current_stop.profit_factor,
            distributions["currentStopProfitFactor"],
        ),
    )


def confidence_interval(
    estimate: float | None,
    distribution: list[float],
) -> MetricConfidenceInterval:
    """Build a central 95% interval from a bootstrap distribution."""

    sorted_values = sorted(distribution)
    return MetricConfidenceInterval(
        estimate=estimate,
        lower_95=quantile(sorted_values, 0.025),
        upper_95=quantile(sorted_values, 0.975),
    )


def build_placebo_comparison(
    candles: list[Candle],
    real_events: list[ReversalEvent],
    runs: int,
    execution_assumptions: ExecutionAssumptions | None = None,
) -> dict[str, dict[str, float | bool | None]] | None:
    """Compare real events against same-weekday/exact-time random entries."""

    if not real_events or runs <= 0:
        return None
    assumptions = execution_assumptions or ExecutionAssumptions()
    session_index = build_candle_session_index(candles)
    buckets = build_eligible_buckets(candles)
    eligible = [candidate for candidates in buckets.values() for candidate in candidates]
    candidate_pools = [
        matched_candidates(buckets, event) or eligible for event in real_events
    ]
    volatility_pool_sizes = [
        len(volatility_matched_candidates(buckets, event))
        for event in real_events
    ]
    rng = random.Random(42)
    distributions: dict[str, list[float]] = {
        "hit20MfeRate": [],
        "hit20EodRate": [],
        "medianMfePoints": [],
        "medianMaePoints": [],
        "currentStopAvgPoints": [],
        "currentStopProfitFactor": [],
    }

    for _ in range(runs):
        sampled: list[PlaceboSample] = []
        for event, candidates in zip(real_events, candidate_pools, strict=True):
            candidate = rng.choice(candidates)
            candle = candidate.candle
            session_info = session_index.get(candle.end_time)
            if session_info is None:
                continue
            session, position = session_info
            signal = fake_signal_from_event(event, candle)
            sampled.append(
                build_placebo_sample(
                    signal,
                    session[position + 1 :],
                    assumptions,
                    event.notification_latency_minutes,
                )
            )
        sample_metrics = summarize_placebo_samples(sampled)
        for key, value in sample_metrics.items():
            push_metric(distributions[key], value)

    real_summary = summarize_reversal_events(real_events)
    real_metrics = {
        "hit20MfeRate": real_summary.mfe20_rate,
        "hit20EodRate": real_summary.eod20_rate,
        "medianMfePoints": real_summary.mfe_median_points,
        "medianMaePoints": real_summary.mae_median_points,
        "currentStopAvgPoints": real_summary.current_stop_performance["conservative"].avg_points,
        "currentStopProfitFactor": real_summary.current_stop_performance["conservative"].profit_factor,
    }
    metrics = {
        key: compare_metric(
            real_value,
            distributions[key],
            higher_is_better=key != "medianMaePoints",
        )
        for key, real_value in real_metrics.items()
    }
    return {
        "_matching": {
            "eventCount": float(len(real_events)),
            "volatilityMatchedEventCount": float(
                len([size for size in volatility_pool_sizes if size >= 20])
            ),
            "timeOnlyFallbackEventCount": float(
                len([size for size in volatility_pool_sizes if size < 20])
            ),
            "minimumSelectedPoolSize": float(
                min((len(pool) for pool in candidate_pools), default=0)
            ),
        },
        **metrics,
    }


def build_placebo_sample(
    signal: ReversalLocation,
    future_candles: list[Candle],
    execution_assumptions: ExecutionAssumptions | None = None,
    notification_latency_minutes: float = 0,
) -> PlaceboSample:
    """Calculate only the event metrics consumed by placebo summaries."""

    eod_close = future_candles[-1].close if future_candles else None
    metrics = metrics_for_window(
        signal.direction,
        signal.price,
        eod_close,
        future_candles,
        signal.timestamp,
    )
    assumptions = execution_assumptions or ExecutionAssumptions()
    delivery = delivery_decision_for_latency(
        signal,
        future_candles,
        notification_latency_minutes,
    )
    execution = resolve_execution_entry(
        signal,
        delivery.execution_candles,
        assumptions,
        delivery.status,
    )
    if execution.price is None:
        current_stop = None
    else:
        risk_points = risk_for_stop(
            execution.price,
            signal.invalidation,
            assumptions,
        )
        current_stop = simulate_stop_target(
            signal.direction,
            execution.price,
            signal.invalidation,
            signal.target,
            execution.candles,
            eod_close,
            risk_points,
            "conservative",
            assumptions,
        )
    return PlaceboSample(
        hit20_mfe=metrics.hit20_mfe,
        hit20_eod=metrics.hit20_eod,
        mfe_points=metrics.mfe_points,
        mae_points=metrics.mae_points,
        current_stop=current_stop,
    )


def delivery_decision_for_latency(
    signal: ReversalLocation,
    future_candles: list[Candle],
    notification_latency_minutes: float,
) -> DeliveryDecision:
    """Apply a real event's delivery delay to one placebo signal."""

    observed_at = (
        signal.timestamp
        + 1
        + round(notification_latency_minutes * 60_000)
    )
    delivery_index = next(
        (
            index
            for index, candle in enumerate(future_candles)
            if candle.start_time >= observed_at
        ),
        None,
    )
    if delivery_index is None:
        return DeliveryDecision(
            observed_at=observed_at,
            observed_price=(
                future_candles[-1].close
                if future_candles
                else signal.price
            ),
            status="no_delivery_bar",
            execution_candles=[],
        )
    observed_price = (
        signal.price
        if delivery_index == 0
        else future_candles[delivery_index - 1].close
    )
    pre_delivery = future_candles[:delivery_index]
    if any(
        is_stop_touched(signal.direction, candle, signal.invalidation)
        for candle in pre_delivery
    ):
        status = "invalidated_before_delivery"
    elif any(
        is_target_touched(signal.direction, candle, signal.target)
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
        execution_candles=future_candles[delivery_index:],
    )


def summarize_placebo_samples(
    samples: list[PlaceboSample],
) -> dict[str, float | None]:
    """Aggregate the six metrics emitted by the placebo comparison."""

    current_stop = trade_stats([sample.current_stop for sample in samples])
    return {
        "hit20MfeRate": rate(samples, lambda sample: sample.hit20_mfe),
        "hit20EodRate": rate(samples, lambda sample: sample.hit20_eod),
        "medianMfePoints": median_or_none(sample.mfe_points for sample in samples),
        "medianMaePoints": median_or_none(sample.mae_points for sample in samples),
        "currentStopAvgPoints": current_stop.avg_points,
        "currentStopProfitFactor": current_stop.profit_factor,
    }


def reversal_events_to_csv(events: list[ReversalEvent]) -> str:
    """Flatten event rows into an inspection-friendly CSV."""

    columns = [
        "date",
        "timestamp",
        "signal_level",
        "direction",
        "entry_price",
        "entry_low",
        "entry_high",
        "observed_at",
        "observed_price",
        "notification_latency_minutes",
        "notification_status",
        "execution_entry_price",
        "execution_entry_time",
        "execution_status",
        "execution_risk_points",
        "invalidation",
        "risk_points",
        "target",
        "target_points",
        "target_r",
        "eod_close",
        "eod_directional_points",
        "mfe_points",
        "mae_points",
        "hit20_mfe",
        "hit20_eod",
        "swept_invalidation",
        "hit20_after_sweep",
        "stop_out_study.stopped_out",
        "stop_out_study.points_after_stopout",
        "stop_out_study.swept_then_reversed",
    ]
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(columns)
    for event in events:
        writer.writerow([value_by_path(event, column) for column in columns])
    return output.getvalue().rstrip("\n")


def event_to_dict(event: ReversalEvent) -> dict[str, object]:
    """Convert an event dataclass into JSON-compatible nested dictionaries."""

    return asdict(event)


def summary_to_dict(summary: ReversalSummary) -> dict[str, object]:
    """Convert a summary dataclass into JSON-compatible nested dictionaries."""

    return asdict(summary)


def render_reversal_summary_markdown(
    summary: ReversalSummary,
    placebo: dict[str, dict[str, float | bool | None]] | None,
    bootstrap: ClusterBootstrapSummary | None = None,
) -> str:
    """Render the high-level thesis checks for manual review."""

    lines = [
        "# Reversal Event Study Summary",
        "",
        f"Signal count: {summary.signal_count}",
        f"Execution status: {summary.execution_status_counts}",
        f"EOD win rate: {format_percent(summary.eod_win_rate)}",
        f"EOD avg points: {format_number(summary.eod_avg_points)}",
        f"MFE avg points: {format_number(summary.mfe_avg_points)}",
        f"MFE >= 20 rate: {format_percent(summary.mfe20_rate)}",
        f"EOD >= 20 rate: {format_percent(summary.eod20_rate)}",
        f"Swept invalidation rate: {format_percent(summary.swept_invalidation_rate)}",
        "",
        "## Current Stop Performance",
        trade_stats_table(summary.current_stop_performance),
        "",
        "## Stop-Out / Re-Entry Study",
        stop_out_study_lines(summary.stop_out_study),
        "",
        "## Random Placebo Comparison",
        placebo_table(placebo),
        "",
        "## Session-Cluster Bootstrap",
        bootstrap_table(bootstrap),
    ]
    return "\n".join(lines) + "\n"


def metrics_for_window(
    direction: Direction,
    entry_price: float,
    eod_close: float | None,
    candles: list[Candle],
    entry_time: int,
) -> WindowMetrics:
    """Calculate forward-path metrics for one window."""

    max_future_high = max((candle.high for candle in candles), default=None)
    min_future_low = min((candle.low for candle in candles), default=None)
    mfe_points = None if max_future_high is None or min_future_low is None else (
        max_future_high - entry_price if direction == "bullish" else entry_price - min_future_low
    )
    mae_points = None if max_future_high is None or min_future_low is None else (
        entry_price - min_future_low if direction == "bullish" else max_future_high - entry_price
    )
    eod_directional_points = None if eod_close is None else directional_points(direction, entry_price, eod_close)
    return WindowMetrics(
        eod_directional_points=eod_directional_points,
        mfe_points=mfe_points,
        mae_points=mae_points,
        max_future_high=max_future_high,
        min_future_low=min_future_low,
        hit10_mfe=(mfe_points or float("-inf")) >= 10,
        hit15_mfe=(mfe_points or float("-inf")) >= 15,
        hit20_mfe=(mfe_points or float("-inf")) >= 20,
        hit30_mfe=(mfe_points or float("-inf")) >= 30,
        hit20_eod=(eod_directional_points or float("-inf")) >= 20,
        time_to_mfe20_minutes=time_to_mfe(direction, entry_price, candles, entry_time, 20),
        mfe_mae_ratio=None if mae_points is None or mfe_points is None or mae_points <= 0 else mfe_points / mae_points,
    )


def second_sweep_analysis(signal: ReversalLocation, signal_candle: Candle, candles: list[Candle]) -> dict[str, object]:
    """Measure whether the invalidation sweep later reclaimed the entry."""

    sweep_index = first_index(candles, lambda candle: is_stop_touched(signal.direction, candle, signal.invalidation))
    if sweep_index < 0:
        return {
            "swept_invalidation": False,
            "sweep_depth_points": None,
            "sweep_depth_from_entry_points": None,
            "recovered_after_sweep": False,
            "hit20_after_sweep": False,
            "time_to_sweep_minutes": None,
            "time_from_sweep_to_recover_minutes": None,
            "time_from_sweep_to_mfe20_minutes": None,
        }
    after_sweep = candles[sweep_index:]
    recover_index = first_index(after_sweep, lambda candle: reclaims_entry(signal.direction, signal.price, candle))
    hit20_index = first_index(after_sweep, lambda candle: hit_mfe_target(signal.direction, signal.price, candle, 20))
    before_recovery = after_sweep if recover_index < 0 else after_sweep[: recover_index + 1]
    if signal.direction == "bullish":
        sweep_extreme = min([signal_candle.low, *[candle.low for candle in before_recovery]])
        sweep_depth = signal.invalidation - sweep_extreme
        sweep_depth_from_entry = signal.price - sweep_extreme
    else:
        sweep_extreme = max([signal_candle.high, *[candle.high for candle in before_recovery]])
        sweep_depth = sweep_extreme - signal.invalidation
        sweep_depth_from_entry = sweep_extreme - signal.price
    return {
        "swept_invalidation": True,
        "sweep_depth_points": sweep_depth,
        "sweep_depth_from_entry_points": sweep_depth_from_entry,
        "recovered_after_sweep": recover_index >= 0,
        "hit20_after_sweep": hit20_index >= 0,
        "time_to_sweep_minutes": minutes_between(signal.timestamp, candles[sweep_index].end_time),
        "time_from_sweep_to_recover_minutes": None if recover_index < 0 else minutes_between(candles[sweep_index].end_time, after_sweep[recover_index].end_time),
        "time_from_sweep_to_mfe20_minutes": None if hit20_index < 0 else minutes_between(candles[sweep_index].end_time, after_sweep[hit20_index].end_time),
    }


def confirmation_entry(
    signal: ReversalLocation,
    signal_candle: Candle,
    candles: list[Candle],
    eod_close: float | None,
) -> dict[str, object]:
    """Measure a breakout-confirmation entry after the signal candle."""

    trigger_index = first_index(candles, lambda candle: candle.high > signal_candle.high if signal.direction == "bullish" else candle.low < signal_candle.low)
    if trigger_index < 0:
        return empty_confirmation_entry()
    entry_price = signal_candle.high if signal.direction == "bullish" else signal_candle.low
    metrics = metrics_for_window(signal.direction, entry_price, eod_close, candles[trigger_index:], signal.timestamp)
    return {
        "confirmation_triggered": True,
        "confirmation_entry_price": entry_price,
        "confirmation_delay_minutes": minutes_between(signal.timestamp, candles[trigger_index].end_time),
        "confirmation_mfe_points": metrics.mfe_points,
        "confirmation_mae_points": metrics.mae_points,
        "confirmation_eod_points": metrics.eod_directional_points,
        "confirmation_hit20_mfe": metrics.hit20_mfe,
        "confirmation_hit20_eod": metrics.hit20_eod,
    }


def second_sweep_entry(
    signal: ReversalLocation,
    signal_candle: Candle,
    candles: list[Candle],
    eod_close: float | None,
) -> dict[str, object]:
    """Measure a re-entry after the invalidation sweep reclaims signal close."""

    sweep_index = first_index(candles, lambda candle: is_stop_touched(signal.direction, candle, signal.invalidation))
    if sweep_index < 0:
        return empty_second_sweep_entry()
    after_sweep = candles[sweep_index + 1 :]
    trigger_index = first_index(after_sweep, lambda candle: candle.high >= signal_candle.close if signal.direction == "bullish" else candle.low <= signal_candle.close)
    if trigger_index < 0:
        return empty_second_sweep_entry()
    entry_index = sweep_index + 1 + trigger_index
    metrics = metrics_for_window(signal.direction, signal_candle.close, eod_close, candles[entry_index:], signal.timestamp)
    return {
        "second_sweep_triggered": True,
        "second_sweep_entry_price": signal_candle.close,
        "second_sweep_delay_minutes": minutes_between(signal.timestamp, candles[entry_index].end_time),
        "second_sweep_mfe_points": metrics.mfe_points,
        "second_sweep_mae_points": metrics.mae_points,
        "second_sweep_eod_points": metrics.eod_directional_points,
        "second_sweep_hit20_mfe": metrics.hit20_mfe,
        "second_sweep_hit20_eod": metrics.hit20_eod,
    }


def build_stop_out_study(
    signal: ReversalLocation,
    signal_candle: Candle,
    entry_price: float,
    candles: list[Candle],
    eod_close: float | None,
    risk_points: float,
    assumptions: ExecutionAssumptions,
) -> StopOutStudy:
    """Build stop-out and re-entry diagnostics for a signal."""

    stop_index = first_index(candles, lambda candle: is_stop_touched(signal.direction, candle, signal.invalidation))
    delayed_entry5m = delayed_entry_after_candles(
        signal.direction,
        signal.invalidation,
        candles,
        eod_close,
        1,
        assumptions,
    )
    delayed_entry_after_confirmation = confirmation_trade(
        signal,
        signal_candle,
        candles,
        eod_close,
        assumptions,
    )
    immediate_policy = simulate_retry_policy(
        signal.direction,
        entry_price,
        signal.invalidation,
        candles,
        eod_close,
        risk_points,
        0,
        assumptions,
    )
    one_retry_policy = simulate_retry_policy(
        signal.direction,
        entry_price,
        signal.invalidation,
        candles,
        eod_close,
        risk_points,
        1,
        assumptions,
    )
    two_retry_policy = simulate_retry_policy(
        signal.direction,
        entry_price,
        signal.invalidation,
        candles,
        eod_close,
        risk_points,
        2,
        assumptions,
    )
    if stop_index < 0:
        return StopOutStudy(
            initial_entry_price=entry_price,
            stopped_out=False,
            first_stop_out_time=None,
            first_stop_out_loss_points=None,
            points_after_stopout=None,
            swept_then_reversed=False,
            time_from_stopout_to_reversal_minutes=None,
            max_adverse_before_post_stop20_points=None,
            wider_stop_would_improve=False,
            delayed_entry5m=delayed_entry5m,
            delayed_entry_after_confirmation=delayed_entry_after_confirmation,
            reentry_after_stopout=None,
            one_retry_policy=one_retry_policy,
            two_retry_policy=two_retry_policy,
        )

    after_stopout = candles[stop_index + 1 :]
    post_stop_hit20_index = first_index(
        after_stopout,
        lambda candle: hit_mfe_target(signal.direction, entry_price, candle, 20),
    )
    before_post_stop20 = after_stopout if post_stop_hit20_index < 0 else after_stopout[: post_stop_hit20_index + 1]
    stop_candle = candles[stop_index]
    return StopOutStudy(
        initial_entry_price=entry_price,
        stopped_out=True,
        first_stop_out_time=iso_timestamp(stop_candle.end_time),
        first_stop_out_loss_points=net_directional_points(
            signal.direction,
            entry_price,
            signal.invalidation,
            assumptions,
        ),
        points_after_stopout=None if eod_close is None else directional_points(signal.direction, signal.invalidation, eod_close),
        swept_then_reversed=post_stop_hit20_index >= 0,
        time_from_stopout_to_reversal_minutes=None if post_stop_hit20_index < 0 else minutes_between(stop_candle.end_time, after_stopout[post_stop_hit20_index].end_time),
        max_adverse_before_post_stop20_points=max_adverse_excursion(signal.direction, entry_price, before_post_stop20),
        wider_stop_would_improve=wider_stop_rescues_initial_stop(
            signal.direction,
            entry_price,
            signal.invalidation,
            candles,
            eod_close,
            immediate_policy,
            assumptions,
        ),
        delayed_entry5m=delayed_entry5m,
        delayed_entry_after_confirmation=delayed_entry_after_confirmation,
        reentry_after_stopout=reentry_trade_after_stopout(
            signal.direction,
            entry_price,
            signal.invalidation,
            after_stopout,
            eod_close,
            assumptions,
        ),
        one_retry_policy=one_retry_policy,
        two_retry_policy=two_retry_policy,
    )


def simulate_stop_target(
    direction: Direction,
    entry_price: float,
    stop: float,
    target: float | None,
    candles: list[Candle],
    eod_close: float | None,
    risk_points: float,
    mode: TouchOrderingMode,
    execution_assumptions: ExecutionAssumptions | None = None,
) -> TradeResult | None:
    """Simulate one stop/target policy with explicit same-candle assumptions."""

    assumptions = execution_assumptions or ExecutionAssumptions()
    for candle in candles:
        gap_stop_price = stop_gap_fill(direction, candle, stop)
        if gap_stop_price is not None:
            return trade_result(
                direction,
                entry_price,
                gap_stop_price,
                risk_points,
                "gap_stop",
                False,
                assumptions,
                candle.end_time,
            )
        stop_touched = is_stop_touched(direction, candle, stop)
        target_touched = target is not None and is_target_touched(direction, candle, target)
        if stop_touched and target_touched:
            if mode == "ambiguous_excluded":
                return TradeResult(
                    points=0,
                    r=None,
                    exit_reason="ambiguous",
                    ambiguous=True,
                    exit_timestamp=candle.end_time,
                )
            exit_price = stop if mode == "conservative" else target
            return trade_result(
                direction,
                entry_price,
                exit_price,
                risk_points,
                "same_candle_touch",
                True,
                assumptions,
                candle.end_time,
            )
        if stop_touched:
            return trade_result(
                direction,
                entry_price,
                stop,
                risk_points,
                "stop",
                False,
                assumptions,
                candle.end_time,
            )
        if target_touched and target is not None:
            return trade_result(
                direction,
                entry_price,
                target,
                risk_points,
                "target",
                False,
                assumptions,
                candle.end_time,
            )
    return (
        None
        if eod_close is None
        else trade_result(
            direction,
            entry_price,
            eod_close,
            risk_points,
            "eod",
            False,
            assumptions,
            candles[-1].end_time if candles else None,
        )
    )


def simulate_partial_runner(
    direction: Direction,
    entry_price: float,
    stop: float,
    candles: list[Candle],
    eod_close: float | None,
    risk_points: float,
    mode: TouchOrderingMode,
    move_stop_to_breakeven: bool,
    execution_assumptions: ExecutionAssumptions | None = None,
) -> TradeResult | None:
    """Take half at +20 and leave half to EOD, with optional breakeven stop."""

    assumptions = execution_assumptions or ExecutionAssumptions()
    target = target_price(direction, entry_price, 20)
    first_leg = simulate_stop_target(
        direction,
        entry_price,
        stop,
        target,
        candles,
        eod_close,
        risk_points,
        mode,
        assumptions,
    )
    if first_leg is None or first_leg.exit_reason not in {"target", "same_candle_touch"} or first_leg.points < 0:
        return first_leg
    target_index = first_index(candles, lambda candle: is_target_touched(direction, candle, target))
    if target_index < 0:
        return first_leg
    runner_stop = entry_price if move_stop_to_breakeven else stop
    runner = simulate_stop_target(
        direction,
        entry_price,
        runner_stop,
        None,
        candles[target_index + 1 :],
        eod_close,
        risk_points,
        mode,
        assumptions,
    )
    if runner is None:
        return first_leg
    total_points = first_leg.points * 0.5 + runner.points * 0.5
    return TradeResult(
        points=total_points,
        r=total_points / risk_points if risk_points > 0 else None,
        exit_reason=f"partial20_{runner.exit_reason}",
        ambiguous=first_leg.ambiguous or runner.ambiguous,
        eod_runner_contribution=runner.points * 0.5,
    )


def simulate_sweep_tolerant_stop(
    direction: Direction,
    entry_price: float,
    stop: float,
    reclaim_price: float,
    candles: list[Candle],
    eod_close: float | None,
    risk_points: float,
    tolerance_minutes: int,
    execution_assumptions: ExecutionAssumptions | None = None,
) -> TradeResult | None:
    """Allow an invalidation sweep if price reclaims quickly enough."""

    assumptions = execution_assumptions or ExecutionAssumptions()
    sweep_index = first_index(candles, lambda candle: is_stop_touched(direction, candle, stop))
    if sweep_index < 0:
        return None if eod_close is None else trade_result(direction, entry_price, eod_close, risk_points, "eod", False, assumptions)
    sweep_time = candles[sweep_index].end_time
    deadline = sweep_time + tolerance_minutes * 60_000
    reclaim_index = first_index(
        candles[sweep_index:],
        lambda candle: candle.end_time <= deadline and reclaims_entry(direction, reclaim_price, candle),
    )
    if reclaim_index < 0:
        gap_price = stop_gap_fill(direction, candles[sweep_index], stop)
        exit_price = stop if gap_price is None else gap_price
        return trade_result(direction, entry_price, exit_price, risk_points, "sweep_stop", False, assumptions)
    remaining = candles[sweep_index + reclaim_index + 1 :]
    return None if eod_close is None else trade_result(direction, entry_price, eod_close, risk_points, "sweep_tolerated_eod", False, assumptions) if not remaining else simulate_stop_target(
        direction,
        entry_price,
        stop,
        None,
        remaining,
        eod_close,
        risk_points,
        "conservative",
        assumptions,
    )


def delayed_entry_after_candles(
    direction: Direction,
    stop: float,
    candles: list[Candle],
    eod_close: float | None,
    delay_candles: int,
    execution_assumptions: ExecutionAssumptions | None = None,
) -> TradeResult | None:
    """Enter after a fixed candle delay using that candle's close."""

    assumptions = execution_assumptions or ExecutionAssumptions()
    if len(candles) < delay_candles:
        return None
    raw_entry_price = candles[delay_candles - 1].close
    if is_beyond_stop(direction, raw_entry_price, stop):
        return None
    entry_price = apply_entry_slippage(
        direction,
        raw_entry_price,
        assumptions.slippage_points,
    )
    risk_points = risk_for_stop(entry_price, stop, assumptions)
    result = simulate_stop_target(
        direction,
        entry_price,
        stop,
        target_price(direction, entry_price, 20),
        candles[delay_candles:],
        eod_close,
        risk_points,
        "conservative",
        assumptions,
    )
    if result is None:
        return None
    return TradeResult(result.points, result.points / risk_points if risk_points > 0 else None, f"delayed_{delay_candles * 5}m_{result.exit_reason}", result.ambiguous)


def confirmation_trade(
    signal: ReversalLocation,
    signal_candle: Candle,
    candles: list[Candle],
    eod_close: float | None,
    execution_assumptions: ExecutionAssumptions | None = None,
) -> TradeResult | None:
    """Simulate a confirmation trade from the signal candle high/low."""

    assumptions = execution_assumptions or ExecutionAssumptions()
    trigger_index = first_index(candles, lambda candle: candle.high > signal_candle.high if signal.direction == "bullish" else candle.low < signal_candle.low)
    if trigger_index < 0:
        return None
    raw_entry_price = signal_candle.high if signal.direction == "bullish" else signal_candle.low
    if is_beyond_stop(signal.direction, raw_entry_price, signal.invalidation):
        return None
    entry_price = apply_entry_slippage(
        signal.direction,
        raw_entry_price,
        assumptions.slippage_points,
    )
    risk_points = risk_for_stop(entry_price, signal.invalidation, assumptions)
    result = simulate_stop_target(
        signal.direction,
        entry_price,
        signal.invalidation,
        target_price(signal.direction, entry_price, 20),
        candles[trigger_index:],
        eod_close,
        risk_points,
        "conservative",
        assumptions,
    )
    if result is None:
        return None
    return TradeResult(result.points, result.points / risk_points if risk_points > 0 else None, f"confirmation_{result.exit_reason}", result.ambiguous)


def reentry_trade_after_stopout(
    direction: Direction,
    entry_price: float,
    stop: float,
    candles: list[Candle],
    eod_close: float | None,
    execution_assumptions: ExecutionAssumptions | None = None,
) -> TradeResult | None:
    """Re-enter at the original entry once price reclaims it after stop-out."""

    assumptions = execution_assumptions or ExecutionAssumptions()
    reentry_index = first_index(candles, lambda candle: reclaims_entry(direction, entry_price, candle))
    if reentry_index < 0:
        return None
    reentry_price = entry_price
    risk_points = risk_for_stop(reentry_price, stop, assumptions)
    result = simulate_stop_target(
        direction,
        reentry_price,
        stop,
        target_price(direction, reentry_price, 20),
        candles[reentry_index:],
        eod_close,
        risk_points,
        "conservative",
        assumptions,
    )
    if result is None:
        return None
    return TradeResult(result.points, result.r, f"reentry_{result.exit_reason}", result.ambiguous)


def simulate_retry_policy(
    direction: Direction,
    entry_price: float,
    stop: float,
    candles: list[Candle],
    eod_close: float | None,
    risk_points: float,
    retries: int,
    execution_assumptions: ExecutionAssumptions | None = None,
) -> TradeResult | None:
    """Retry after stop-out only when price reclaims the original entry."""

    assumptions = execution_assumptions or ExecutionAssumptions()
    start_index = 0
    attempts = 0
    results: list[TradeResult] = []
    while attempts <= retries:
        result = simulate_stop_target(
            direction,
            entry_price,
            stop,
            target_price(direction, entry_price, 20),
            candles[start_index:],
            eod_close,
            risk_points,
            "conservative",
            assumptions,
        )
        if result is None:
            break
        results.append(result)
        if result.exit_reason not in {"gap_stop", "stop", "same_candle_touch"}:
            break
        attempts += 1
        if attempts > retries:
            break
        stop_index = find_stop_index(direction, stop, candles, start_index)
        if stop_index < 0:
            break
        reentry_index = first_index(candles, lambda candle: reclaims_entry(direction, entry_price, candle), stop_index + 1)
        if reentry_index < 0:
            break
        start_index = reentry_index
    if not results:
        return None if eod_close is None else trade_result(direction, entry_price, eod_close, risk_points, "eod", False, assumptions)
    return combine_trade_results(results, "no_retry_policy" if retries == 0 else f"{retries}_retry_policy", risk_points)


def wider_stop_rescues_initial_stop(
    direction: Direction,
    entry_price: float,
    current_stop: float,
    candles: list[Candle],
    eod_close: float | None,
    current_policy: TradeResult | None,
    execution_assumptions: ExecutionAssumptions | None = None,
) -> bool:
    """Return whether a wider fixed stop improves a losing current-stop policy."""

    assumptions = execution_assumptions or ExecutionAssumptions()
    if current_policy is None or current_policy.points >= 0:
        return False
    for width in FIXED_STOP_WIDTHS:
        stop = entry_price - width if direction == "bullish" else entry_price + width
        if (direction == "bullish" and stop >= current_stop) or (direction == "bearish" and stop <= current_stop):
            continue
        result = simulate_stop_target(
            direction,
            entry_price,
            stop,
            target_price(direction, entry_price, 20),
            candles,
            eod_close,
            risk_for_stop(entry_price, stop, assumptions),
            "conservative",
            assumptions,
        )
        if result is not None and result.points > current_policy.points:
            return True
    return False


def trade_stats_by_mode(results: list[dict[TouchOrderingMode, TradeResult | None]]) -> dict[TouchOrderingMode, TradeStats]:
    """Aggregate trade stats by same-candle touch mode."""

    return {mode: trade_stats([result.get(mode) for result in results]) for mode in TOUCH_MODES}


def trade_stats(raw_results: list[TradeResult | None]) -> TradeStats:
    """Aggregate nullable trade results."""

    ambiguous = [result for result in raw_results if result is not None and result.ambiguous]
    clean = [result for result in raw_results if result is not None and not result.ambiguous]
    points = [result.points for result in clean]
    wins = [point for point in points if point > 0]
    losses = [point for point in points if point < 0]
    gross_loss = abs(sum(losses))
    return TradeStats(
        trades=len(clean),
        ambiguous_trades=len(ambiguous),
        ambiguous_rate=None if not raw_results else len(ambiguous) / len(raw_results),
        win_rate=None if not clean else len(wins) / len(clean),
        avg_points=average_or_none(points),
        median_points=median_or_none(points),
        profit_factor=None if gross_loss == 0 else sum(wins) / gross_loss,
        average_r=average_or_none(result.r for result in clean),
        max_losing_streak=max_losing_streak(points),
        expectancy=average_or_none(points),
        hit20_rate=None if not clean else len([point for point in points if point >= 20]) / len(clean),
        eod_runner_contribution=average_or_none(result.eod_runner_contribution for result in clean),
    )


def build_single_position_summary(
    events: list[ReversalEvent],
) -> SinglePositionSummary:
    """Keep the first executable signal while a prior position is active."""

    executable = [
        event
        for event in events
        if event.execution_entry_time is not None
        and event.current_stop.get("conservative") is not None
    ]
    ordered = sorted(
        executable,
        key=lambda event: event.execution_entry_time or "",
    )
    selected: list[TradeResult] = []
    active_until = -1
    skipped_overlapping = 0
    for event in ordered:
        entry_time = parse_iso_timestamp(event.execution_entry_time)
        result = event.current_stop["conservative"]
        if result is None:
            continue
        if entry_time <= active_until:
            skipped_overlapping += 1
            continue
        selected.append(result)
        active_until = result.exit_timestamp or entry_time
    return SinglePositionSummary(
        executable_signals=len(executable),
        selected_trades=len(selected),
        skipped_overlapping=skipped_overlapping,
        performance=trade_stats(selected),
    )


def render_single_position_markdown(
    summary: SinglePositionSummary,
) -> str:
    """Render a compact capital-constrained execution summary."""

    return "\n".join(
        [
            "# Single-Position Execution",
            "",
            "Conservative current-stop policy with at most one open position.",
            "",
            f"Executable signals: {summary.executable_signals}",
            f"Selected trades: {summary.selected_trades}",
            f"Skipped overlapping signals: {summary.skipped_overlapping}",
            f"Average points: {format_number(summary.performance.avg_points)}",
            f"Average R: {format_number(summary.performance.average_r)}",
            f"Profit factor: {format_number(summary.performance.profit_factor)}",
            f"Maximum losing streak: {summary.performance.max_losing_streak}",
        ]
    ) + "\n"


def stop_out_summary(events: list[ReversalEvent]) -> StopOutSummary:
    """Aggregate stop-out diagnostics."""

    studies = [event.stop_out_study for event in events if event.stop_out_study is not None]
    stopped = [study for study in studies if study.stopped_out]
    return StopOutSummary(
        stopped_out_rate=rate(studies, lambda study: study.stopped_out),
        swept_then_reversed_rate=None if not stopped else rate(stopped, lambda study: study.swept_then_reversed),
        avg_points_after_stopout=average_or_none(study.points_after_stopout for study in stopped),
        median_minutes_from_stopout_to_reversal=median_or_none(study.time_from_stopout_to_reversal_minutes for study in stopped),
        median_max_adverse_before_post_stop20=median_or_none(study.max_adverse_before_post_stop20_points for study in stopped),
        wider_stop_would_improve_rate=None if not stopped else rate(stopped, lambda study: study.wider_stop_would_improve),
        reentry_after_stopout=trade_stats([study.reentry_after_stopout for study in stopped]),
        one_retry_policy=trade_stats([study.one_retry_policy for study in studies]),
        two_retry_policy=trade_stats([study.two_retry_policy for study in studies]),
        delayed_entry5m=trade_stats([study.delayed_entry5m for study in studies]),
        delayed_entry_after_confirmation=trade_stats([study.delayed_entry_after_confirmation for study in studies]),
    )


def fake_signal_from_event(event: ReversalEvent, candle: Candle) -> ReversalLocation:
    """Create a placebo signal preserving the real event's direction/risk shape."""

    risk = max(event.risk_points, 0.5)
    invalidation = candle.close - risk if event.direction == "bullish" else candle.close + risk
    target_points = event.target_points if event.target_points > 0 else 20
    target = candle.close + target_points if event.direction == "bullish" else candle.close - target_points
    return ReversalLocation(
        level="alert",
        direction=event.direction,
        market="placebo",
        price=candle.close,
        entry_low=(
            candle.close - (event.entry_price - event.entry_low)
        ),
        entry_high=(
            candle.close + (event.entry_high - event.entry_price)
        ),
        invalidation=invalidation,
        target=target,
        session_high=candle.high,
        session_low=candle.low,
        vwap=candle.close,
        price_risk_reward=target_points / risk,
        confidence_score=100,
        policy=event_policy_stub(),
        reasons=["placebo matched by weekday and time bucket"],
        timestamp=candle.end_time,
    )


def event_policy_stub():
    """Create a simple policy object without importing TypeScript concepts."""

    from reversal_scanner_backtest.models import SignalPolicy

    return SignalPolicy(
        name="placebo",
        role="bullish_reversal_zone",
        alert_eligible=True,
        watch_eligible=True,
        reasons=[],
    )


def build_eligible_buckets(
    candles: list[Candle],
) -> dict[str, list[PlaceboCandidate]]:
    """Bucket candidates by time while retaining pre-trigger volatility."""

    sessions: dict[str, list[Candle]] = {}
    for candle in candles:
        sessions.setdefault(date_key(candle.end_time), []).append(candle)

    buckets: dict[str, list[PlaceboCandidate]] = {}
    for session_date, session in sessions.items():
        history: list[Candle] = []
        for candle in session:
            history.append(candle)
            if len(history) < 6:
                continue
            atr_points = average_true_range(history)
            session_range = max(item.high for item in history) - min(
                item.low for item in history
            )
            parts = time_parts(candle.end_time)
            key = f"{parts['weekday']}-{parts['minute_of_day']}"
            buckets.setdefault(key, []).append(
                PlaceboCandidate(
                    candle=candle,
                    atr_points=atr_points,
                    session_range_in_atr=(
                        None if atr_points <= 0 else session_range / atr_points
                    ),
                    date=session_date,
                )
            )
    return buckets


def matched_candidates(
    buckets: dict[str, list[PlaceboCandidate]],
    event: ReversalEvent,
) -> list[PlaceboCandidate]:
    """Match placebo candles by time, volatility, and observed session range."""

    parts = time_parts(parse_iso_millis(event.timestamp))
    key = f"{event.weekday}-{parts['minute_of_day']}"
    time_matched = time_matched_candidates(buckets, event, key)
    volatility_matched = volatility_matched_candidates(buckets, event)
    return volatility_matched if len(volatility_matched) >= 20 else time_matched


def time_matched_candidates(
    buckets: dict[str, list[PlaceboCandidate]],
    event: ReversalEvent,
    key: str | None = None,
) -> list[PlaceboCandidate]:
    """Return weekday/time-slot matches outside the real event date."""

    if key is None:
        parts = time_parts(parse_iso_millis(event.timestamp))
        key = f"{event.weekday}-{parts['minute_of_day']}"
    return [
        candidate
        for candidate in buckets.get(key, [])
        if candidate.date != event.date
    ]


def volatility_matched_candidates(
    buckets: dict[str, list[PlaceboCandidate]],
    event: ReversalEvent,
) -> list[PlaceboCandidate]:
    """Return time matches that also satisfy volatility constraints."""

    return [
        candidate
        for candidate in time_matched_candidates(buckets, event)
        if volatility_is_similar(candidate, event)
    ]


def volatility_is_similar(
    candidate: PlaceboCandidate,
    event: ReversalEvent,
) -> bool:
    """Return whether candidate volatility is close enough for a fair placebo."""

    if event.atr_points <= 0 or candidate.atr_points <= 0:
        return False
    atr_ratio = candidate.atr_points / event.atr_points
    if not 0.75 <= atr_ratio <= 1.25:
        return False
    if (
        event.session_range_in_atr is None
        or candidate.session_range_in_atr is None
    ):
        return False
    return abs(candidate.session_range_in_atr - event.session_range_in_atr) <= 0.75


def empty_confirmation_entry() -> dict[str, object]:
    """Return empty confirmation-entry metrics."""

    return {
        "confirmation_triggered": False,
        "confirmation_entry_price": None,
        "confirmation_delay_minutes": None,
        "confirmation_mfe_points": None,
        "confirmation_mae_points": None,
        "confirmation_eod_points": None,
        "confirmation_hit20_mfe": False,
        "confirmation_hit20_eod": False,
    }


def empty_second_sweep_entry() -> dict[str, object]:
    """Return empty second-sweep-entry metrics."""

    return {
        "second_sweep_triggered": False,
        "second_sweep_entry_price": None,
        "second_sweep_delay_minutes": None,
        "second_sweep_mfe_points": None,
        "second_sweep_mae_points": None,
        "second_sweep_eod_points": None,
        "second_sweep_hit20_mfe": False,
        "second_sweep_hit20_eod": False,
    }


def classify_day(candles_available: list[Candle], future_candles: list[Candle]) -> str:
    """Classify whether the session later trended or stayed mixed."""

    all_candles = [*candles_available, *future_candles]
    if len(all_candles) < 2:
        return "unknown"
    change = all_candles[-1].close - all_candles[0].open
    day_range = max(c.high for c in all_candles) - min(c.low for c in all_candles)
    if day_range <= 0:
        return "flat"
    if change / day_range >= 0.45:
        return "trend_up"
    if change / day_range <= -0.45:
        return "trend_down"
    return "mixed"


def mae_before_mfe20(direction: Direction, entry_price: float, candles: list[Candle]) -> float | None:
    """Measure adverse excursion before the first +20 MFE touch."""

    hit_index = first_index(candles, lambda candle: hit_mfe_target(direction, entry_price, candle, 20))
    if hit_index < 0:
        return None
    return max_adverse_excursion(direction, entry_price, candles[: hit_index + 1])


def time_to_mfe(direction: Direction, entry_price: float, candles: list[Candle], entry_time: int, points: float) -> float | None:
    """Return minutes until a forward candle reaches an MFE target."""

    index = first_index(candles, lambda candle: hit_mfe_target(direction, entry_price, candle, points))
    return None if index < 0 else minutes_between(entry_time, candles[index].end_time)


def opening_range_distance(direction: Direction, price: float, candles: list[Candle]) -> float | None:
    """Distance from the opening six-candle range boundary."""

    if not candles:
        return None
    opening = candles[: min(6, len(candles))]
    return price - min(c.low for c in opening) if direction == "bullish" else max(c.high for c in opening) - price


def fresh_extreme_lookback_bucket(direction: Direction, signal_candle: Candle, candles: list[Candle]) -> str:
    """Bucket how long the latest candle's fresh extreme survived lookback."""

    prior = candles[:-1]
    if not prior:
        return "none"
    if direction == "bullish":
        count = sum(1 for candle in reversed(prior) if candle.low >= signal_candle.low)
    else:
        count = sum(1 for candle in reversed(prior) if candle.high <= signal_candle.high)
    return bucket_number(count, [3, 6, 12, 24])


def time_of_day_bucket(timestamp: int) -> str:
    """Bucket a timestamp within the trading day."""

    minutes = minutes_since_midnight(timestamp)
    if minutes is None:
        return "unknown"
    if minutes < 9 * 60 + 30:
        return "premarket"
    if minutes < 10 * 60:
        return "first_30_minutes"
    if minutes < 15 * 60 + 30:
        return "midday"
    if minutes < 16 * 60:
        return "final_30_minutes"
    return "after_hours"


def bucket_number(value: float, thresholds: list[float]) -> str:
    """Return a compact threshold bucket label."""

    for threshold in thresholds:
        if value <= threshold:
            return f"<={threshold:g}"
    return f">{thresholds[-1]:g}"


def stop_for_key(direction: Direction, price: float, current_stop: float, key: str) -> float:
    """Resolve a current/fixed stop key into a stop price."""

    if key == "current":
        return current_stop
    width = float(key.removesuffix("pt"))
    return price - width if direction == "bullish" else price + width


def trade_result(
    direction: Direction,
    entry_price: float,
    exit_price: float,
    risk_points: float,
    exit_reason: str,
    ambiguous: bool,
    execution_assumptions: ExecutionAssumptions | None = None,
    exit_timestamp: int | None = None,
) -> TradeResult:
    """Build a trade result from entry and exit prices."""

    assumptions = execution_assumptions or ExecutionAssumptions()
    executable_exit_price = apply_exit_slippage(
        direction,
        exit_price,
        assumptions.slippage_points,
    )
    points = (
        directional_points(direction, entry_price, executable_exit_price)
        - assumptions.round_trip_cost_points
    )
    return TradeResult(
        points=points,
        r=points / risk_points if risk_points > 0 else None,
        exit_reason=exit_reason,
        ambiguous=ambiguous,
        exit_timestamp=exit_timestamp,
    )


def combine_trade_results(results: list[TradeResult], exit_reason: str, risk_points: float) -> TradeResult:
    """Combine retry attempts into one policy result."""

    points = sum(result.points for result in results)
    return TradeResult(
        points=points,
        r=points / risk_points if risk_points > 0 else None,
        exit_reason=exit_reason,
        ambiguous=any(result.ambiguous for result in results),
        exit_timestamp=max(
            (
                result.exit_timestamp
                for result in results
                if result.exit_timestamp is not None
            ),
            default=None,
        ),
    )


def find_stop_index(direction: Direction, stop: float, candles: list[Candle], start_index: int) -> int:
    """Find first stop touch from a start index."""

    return first_index(candles, lambda candle: is_stop_touched(direction, candle, stop), start_index)


def is_stop_touched(direction: Direction, candle: Candle, stop: float) -> bool:
    """Return whether a candle touched the stop."""

    return candle.low <= stop if direction == "bullish" else candle.high >= stop


def stop_gap_fill(
    direction: Direction,
    candle: Candle,
    stop: float,
) -> float | None:
    """Return a worse opening fill when price gaps through a stop."""

    if direction == "bullish" and candle.open < stop:
        return candle.open
    if direction == "bearish" and candle.open > stop:
        return candle.open
    return None


def is_beyond_stop(direction: Direction, price: float, stop: float) -> bool:
    """Return whether an entry price has already invalidated the setup."""

    return price <= stop if direction == "bullish" else price >= stop


def is_beyond_target(direction: Direction, price: float, target: float) -> bool:
    """Return whether an entry price has already passed the frozen target."""

    return price >= target if direction == "bullish" else price <= target


def is_target_touched(direction: Direction, candle: Candle, target: float) -> bool:
    """Return whether a candle touched the target."""

    return candle.high >= target if direction == "bullish" else candle.low <= target


def directional_points(direction: Direction, entry_price: float, exit_price: float) -> float:
    """Return points in the trade direction."""

    return exit_price - entry_price if direction == "bullish" else entry_price - exit_price


def apply_entry_slippage(
    direction: Direction,
    price: float,
    slippage_points: float,
) -> float:
    """Move an entry price against the strategy direction."""

    return price + slippage_points if direction == "bullish" else price - slippage_points


def apply_exit_slippage(
    direction: Direction,
    price: float,
    slippage_points: float,
) -> float:
    """Move an exit price against the strategy direction."""

    return price - slippage_points if direction == "bullish" else price + slippage_points


def net_directional_points(
    direction: Direction,
    entry_price: float,
    exit_price: float,
    assumptions: ExecutionAssumptions,
) -> float:
    """Return directional points after modeled exit slippage and cost."""

    executable_exit = apply_exit_slippage(
        direction,
        exit_price,
        assumptions.slippage_points,
    )
    return (
        directional_points(direction, entry_price, executable_exit)
        - assumptions.round_trip_cost_points
    )


def target_price(direction: Direction, entry_price: float, points: float) -> float:
    """Return target price at a directional point distance."""

    return entry_price + points if direction == "bullish" else entry_price - points


def reclaims_entry(direction: Direction, entry_price: float, candle: Candle) -> bool:
    """Return whether the candle reclaims the entry level."""

    return candle.high >= entry_price if direction == "bullish" else candle.low <= entry_price


def hit_mfe_target(direction: Direction, entry_price: float, candle: Candle, points: float) -> bool:
    """Return whether a candle reaches a directional MFE target."""

    return candle.high >= entry_price + points if direction == "bullish" else candle.low <= entry_price - points


def max_adverse_excursion(direction: Direction, entry_price: float, candles: list[Candle]) -> float | None:
    """Calculate worst adverse move over the supplied candles."""

    if not candles:
        return None
    return entry_price - min(c.low for c in candles) if direction == "bullish" else max(c.high for c in candles) - entry_price


def average_true_range(candles: list[Candle], window: int = 12) -> float:
    """Calculate the same trailing ATR definition used by the signal engine."""

    sample = candles[-(window + 1) :]
    if len(sample) < 2:
        return 0
    true_ranges = [
        max(
            candle.high - candle.low,
            abs(candle.high - sample[index].close),
            abs(candle.low - sample[index].close),
        )
        for index, candle in enumerate(sample[1:])
    ]
    return sum(true_ranges) / len(true_ranges)


def first_index(values: list[Candle], predicate: Callable[[Candle], bool], start: int = 0) -> int:
    """Return first index matching a predicate, or -1."""

    for index in range(start, len(values)):
        if predicate(values[index]):
            return index
    return -1


def rate(values: list[object], predicate: Callable[[object], bool]) -> float | None:
    """Return predicate hit rate for a list."""

    return None if not values else len([value for value in values if predicate(value)]) / len(values)


def count_values(values: Iterable[str]) -> dict[str, int]:
    """Count string values while preserving first-seen order."""

    counts: dict[str, int] = {}
    for value in values:
        counts[value] = counts.get(value, 0) + 1
    return counts


def average_or_none(values: Iterable[float | None]) -> float | None:
    """Average finite non-null values."""

    numbers = [value for value in values if isinstance(value, int | float)]
    return None if not numbers else sum(numbers) / len(numbers)


def median_or_none(values: Iterable[float | None]) -> float | None:
    """Median finite non-null values."""

    numbers = [value for value in values if isinstance(value, int | float)]
    return None if not numbers else float(median(numbers))


def max_losing_streak(points: list[float]) -> int:
    """Return the longest consecutive losing streak."""

    longest = 0
    current = 0
    for point in points:
        if point < 0:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


def push_metric(values: list[float], value: float | None) -> None:
    """Append a metric only when it is numeric."""

    if isinstance(value, int | float):
        values.append(float(value))


def compare_metric(
    real_value: float | None,
    distribution: list[float],
    higher_is_better: bool = True,
) -> dict[str, float | bool | None]:
    """Compare one real metric against a random distribution."""

    sorted_values = sorted(distribution)
    raw_percentile = (
        None
        if real_value is None or not sorted_values
        else len([value for value in sorted_values if value <= real_value])
        / len(sorted_values)
    )
    return {
        "realValue": real_value,
        "randomMedian": quantile(sorted_values, 0.5),
        "randomP25": quantile(sorted_values, 0.25),
        "randomP75": quantile(sorted_values, 0.75),
        "randomP95": quantile(sorted_values, 0.95),
        "higherIsBetter": higher_is_better,
        "rawPercentileRank": raw_percentile,
        "advantagePercentile": (
            None
            if raw_percentile is None
            else raw_percentile if higher_is_better else 1 - raw_percentile
        ),
    }


def quantile(sorted_values: list[float], probability: float) -> float | None:
    """Linear-interpolated quantile for sorted values."""

    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return sorted_values[0]
    index = (len(sorted_values) - 1) * probability
    lower = int(index)
    upper = min(lower + 1, len(sorted_values) - 1)
    weight = index - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


def value_by_path(value: object, path: str) -> object:
    """Read a dotted dataclass/dict path."""

    current = value
    for part in path.split("."):
        if current is None:
            return None
        if isinstance(current, dict):
            current = current.get(part)
        else:
            current = getattr(current, part)
    return current


def date_key(timestamp: int) -> str:
    """Return session date key in the configured timezone."""

    return datetime.fromtimestamp(timestamp / 1000, tz=SESSION_TIME_ZONE).strftime("%Y-%m-%d")


def time_parts(timestamp: int) -> dict[str, int]:
    """Return date/time parts in the configured session timezone."""

    dt = datetime.fromtimestamp(timestamp / 1000, tz=SESSION_TIME_ZONE)
    return {
        "weekday": (dt.weekday() + 1) % 7,
        "hour": dt.hour,
        "minute": dt.minute,
        "minute_of_day": dt.hour * 60 + dt.minute,
    }


def minutes_since_midnight(timestamp: int) -> int | None:
    """Return session-local minutes since midnight."""

    return time_parts(timestamp)["minute_of_day"]


def minutes_between(start: int, end: int) -> float:
    """Return whole-minute distance between millisecond timestamps."""

    return (end - start) / 60_000


def iso_timestamp(timestamp: int) -> str:
    """Return UTC ISO timestamp with millisecond precision."""

    return datetime.fromtimestamp(timestamp / 1000, tz=UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso_timestamp(value: str | None) -> int:
    """Parse one serialized UTC event timestamp into epoch milliseconds."""

    if value is None:
        raise ValueError("timestamp is required")
    return int(
        datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
        * 1000
    )


def parse_iso_millis(value: str) -> int:
    """Parse a UTC ISO timestamp into milliseconds."""

    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def format_percent(value: float | None) -> str:
    """Format a nullable rate."""

    return "n/a" if value is None else f"{value * 100:.2f}%"


def format_number(value: float | None) -> str:
    """Format a nullable number."""

    return "n/a" if value is None else f"{value:.2f}"


def as_number(value: float | bool | None) -> float | None:
    """Narrow a mixed placebo field to a numeric metric value."""

    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def trade_stats_table(stats_by_mode: dict[TouchOrderingMode, TradeStats]) -> str:
    """Render trade stats by touch mode."""

    lines = [
        "| mode | trades | avg points | profit factor | win rate | ambiguous |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for mode, stats in stats_by_mode.items():
        lines.append(f"| {mode} | {stats.trades} | {format_number(stats.avg_points)} | {format_number(stats.profit_factor)} | {format_percent(stats.win_rate)} | {stats.ambiguous_trades} |")
    return "\n".join(lines)


def stop_out_study_lines(summary: StopOutSummary) -> str:
    """Render stop-out diagnostics."""

    return "\n".join(
        [
            f"stopped_out_rate={format_percent(summary.stopped_out_rate)}",
            f"swept_then_reversed_rate={format_percent(summary.swept_then_reversed_rate)}",
            f"avg_points_after_stopout={format_number(summary.avg_points_after_stopout)}",
            "",
            "| policy | trades | avg points | profit factor | win rate | max losing streak |",
            "| --- | ---: | ---: | ---: | ---: | ---: |",
            stop_out_policy_row("reentry_after_stopout", summary.reentry_after_stopout),
            stop_out_policy_row("one_retry_policy", summary.one_retry_policy),
            stop_out_policy_row("two_retry_policy", summary.two_retry_policy),
            stop_out_policy_row("delayed_entry_5min", summary.delayed_entry5m),
            stop_out_policy_row("delayed_entry_after_confirmation", summary.delayed_entry_after_confirmation),
        ]
    )


def stop_out_policy_row(name: str, stats: TradeStats) -> str:
    """Render one stop-out policy row."""

    return f"| {name} | {stats.trades} | {format_number(stats.avg_points)} | {format_number(stats.profit_factor)} | {format_percent(stats.win_rate)} | {stats.max_losing_streak} |"


def placebo_table(
    placebo: dict[str, dict[str, float | bool | None]] | None,
) -> str:
    """Render placebo comparison metrics."""

    if placebo is None:
        return "No placebo comparison generated."
    matching = placebo.get("_matching", {})
    lines = [
        (
            "matching: "
            f"events={format_number(as_number(matching.get('eventCount')))} · "
            f"volatility matched={format_number(as_number(matching.get('volatilityMatchedEventCount')))} · "
            f"time-only fallback={format_number(as_number(matching.get('timeOnlyFallbackEventCount')))} · "
            f"minimum pool={format_number(as_number(matching.get('minimumSelectedPoolSize')))}"
        ),
        "",
        "| metric | real | random median | random p25 | random p75 | random p95 | advantage percentile | direction |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for metric, comparison in placebo.items():
        if metric.startswith("_"):
            continue
        lines.append(
            f"| {metric} | {format_number(as_number(comparison['realValue']))} | {format_number(as_number(comparison['randomMedian']))} | {format_number(as_number(comparison['randomP25']))} | {format_number(as_number(comparison['randomP75']))} | {format_number(as_number(comparison['randomP95']))} | {format_percent(as_number(comparison['advantagePercentile']))} | {'higher' if comparison['higherIsBetter'] else 'lower'} is better |"
        )
    return "\n".join(lines)


def bootstrap_table(summary: ClusterBootstrapSummary | None) -> str:
    """Render confidence intervals produced by session-cluster bootstrap."""

    if summary is None:
        return "No cluster bootstrap generated."
    lines = [
        f"runs={summary.runs} · seed={summary.seed} · session clusters={summary.cluster_count}",
        "",
        "| metric | estimate | lower 95% | upper 95% |",
        "| --- | ---: | ---: | ---: |",
    ]
    metrics = {
        "mfe20_rate": summary.mfe20_rate,
        "eod_avg_points": summary.eod_avg_points,
        "current_stop_avg_points": summary.current_stop_avg_points,
        "current_stop_profit_factor": summary.current_stop_profit_factor,
    }
    for name, interval in metrics.items():
        lines.append(
            f"| {name} | {format_number(interval.estimate)} | {format_number(interval.lower_95)} | {format_number(interval.upper_95)} |"
        )
    return "\n".join(lines)


def render_direction_summary_markdown(
    summaries: dict[Direction, ReversalSummary],
) -> str:
    """Render separate bullish and bearish strategy outcomes."""

    lines = [
        "# Direction Summary",
        "",
        "Bullish reversal trades and bearish crash-monitor events are separate tasks and must not be promoted from their combined result.",
        "",
        "| direction | events | MFE >= 20 | EOD avg | stop trades | stop avg | stop PF |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for direction, summary in summaries.items():
        stop = summary.current_stop_performance["conservative"]
        lines.append(
            f"| {direction} | {summary.signal_count} | {format_percent(summary.mfe20_rate)} | {format_number(summary.eod_avg_points)} | {stop.trades} | {format_number(stop.avg_points)} | {format_number(stop.profit_factor)} |"
        )
    return "\n".join(lines) + "\n"
