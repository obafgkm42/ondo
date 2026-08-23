"""Command-line runner for Python scientific backtests."""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from dataclasses import asdict
from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from reversal_scanner_backtest.models import Candle
from reversal_scanner_backtest.market_data import canonical_candle_stream
from reversal_scanner_backtest.reversal_study import (
    ExecutionAssumptions,
    ReversalEvent,
    build_candle_session_index,
    build_cluster_bootstrap_summary,
    build_placebo_comparison,
    build_reversal_event,
    build_single_position_summary,
    date_key,
    event_to_dict,
    render_reversal_summary_markdown,
    render_single_position_markdown,
    render_direction_summary_markdown,
    reversal_events_to_csv,
    set_backtest_session_time_zone,
    summary_to_dict,
    summarize_reversal_events,
    summarize_events_by_direction,
)
from reversal_scanner_backtest.signal_engine import analyze_frozen_signal_v1
from reversal_scanner_backtest.replay import (
    ReplaySettings,
    available_history,
    build_delivery_decision,
    should_evaluate_candle,
)
from reversal_scanner_backtest.validation import (
    dataset_sha256,
    validate_candles,
)
from reversal_scanner_backtest.walk_forward import (
    build_walk_forward_summary,
    render_walk_forward_markdown,
)

BACKTEST_SCHEMA_VERSION = 3


def main(argv: Sequence[str] | None = None) -> None:
    """Run the frozen-v1 reversal event study from candle JSON."""

    args = parse_args(argv)
    set_backtest_session_time_zone(args.session_timezone)
    loaded_candles = load_candles(
        args.input,
        args.source_timezone,
        args.source_timestamp_mode,
    )
    validation = validate_candles(
        loaded_candles,
        args.expected_interval_minutes,
        args.session_timezone,
        args.session_profile,
    )
    if not validation.is_valid:
        raise ValueError("; ".join(validation.errors))
    candles = filter_candles_for_session(
        loaded_candles,
        args.session_timezone,
        args.session_profile,
    )
    replay_settings = ReplaySettings(
        mode=args.replay_mode,
        regular_scan_minutes=args.regular_scan_minutes,
        final_hour_scan_minutes=args.final_hour_scan_minutes,
        request_lookback_hours=args.request_lookback_hours,
        session_time_zone=args.session_timezone,
    )
    replay_settings.validate()
    execution_assumptions = ExecutionAssumptions(
        entry_mode=args.entry_mode,
        slippage_points=args.slippage_points,
        round_trip_cost_points=args.round_trip_cost_points,
        enforce_entry_zone=True,
    )
    execution_assumptions.validate()
    events = scan_reversal_events(
        candles,
        args.market,
        replay_settings,
        execution_assumptions,
        args.signal_scope,
    )
    summary = summarize_reversal_events(events)
    direction_summaries = summarize_events_by_direction(events)
    single_position = build_single_position_summary(events)
    bootstrap = build_cluster_bootstrap_summary(
        events,
        args.bootstrap_runs,
        args.bootstrap_seed,
    )
    placebo = build_placebo_comparison(
        candles,
        events,
        args.placebo_runs,
        execution_assumptions,
    )
    walk_forward = build_walk_forward_summary(
        events,
        args.walk_forward_train_months,
        args.walk_forward_test_months,
        (
            None
            if not candles
            else date.fromisoformat(date_key(candles[0].end_time))
        ),
        (
            None
            if not candles
            else date.fromisoformat(date_key(candles[-1].end_time))
        ),
    )

    output_dir = args.output_dir or args.output.parent
    events_dir = output_dir / "events"
    reports_dir = output_dir / "reports"
    events_dir.mkdir(parents=True, exist_ok=True)
    reports_dir.mkdir(parents=True, exist_ok=True)

    event_dicts = [event_to_dict(event) for event in events]
    payload = {
        "schemaVersion": BACKTEST_SCHEMA_VERSION,
        "market": args.market,
        "input": str(args.input),
        "datasetSha256": dataset_sha256(args.input),
        "sourceTimeZone": args.source_timezone,
        "sourceTimestampMode": args.source_timestamp_mode,
        "dataValidation": validation.to_dict(),
        "sessionTimeZone": args.session_timezone,
        "replay": {
            "mode": replay_settings.mode,
            "regularScanMinutes": replay_settings.regular_scan_minutes,
            "finalHourScanMinutes": replay_settings.final_hour_scan_minutes,
            "requestLookbackHours": replay_settings.request_lookback_hours,
            "signalScope": args.signal_scope,
            "sessionProfile": args.session_profile,
        },
        "execution": {
            "entryMode": execution_assumptions.entry_mode,
            "slippagePointsPerFill": execution_assumptions.slippage_points,
            "roundTripCostPoints": execution_assumptions.round_trip_cost_points,
            "gapStopsUseWorseOpeningPrice": True,
            "entryZoneEnforced": execution_assumptions.enforce_entry_zone,
        },
        "candleCount": len(candles),
        "range": None
        if not candles
        else {
            "start": candles[0].end_time,
            "end": candles[-1].end_time,
        },
        "summary": summary_to_dict(summary),
        "summaryByDirection": {
            direction: summary_to_dict(direction_summary)
            for direction, direction_summary in direction_summaries.items()
        },
        "singlePosition": asdict(single_position),
        "clusterBootstrap": None if bootstrap is None else asdict(bootstrap),
        "placebo": placebo,
        "walkForward": (
            None if walk_forward is None else walk_forward.to_dict()
        ),
        "events": event_dicts,
    }

    (events_dir / "reversal_event_study.csv").write_text(f"{reversal_events_to_csv(events)}\n", encoding="utf-8")
    (events_dir / "reversal_event_study.json").write_text(f"{json.dumps(event_dicts, indent=2)}\n", encoding="utf-8")
    (reports_dir / "reversal_summary.md").write_text(
        render_reversal_summary_markdown(summary, placebo, bootstrap),
        encoding="utf-8",
    )
    (reports_dir / "walk_forward_summary.md").write_text(
        render_walk_forward_markdown(walk_forward),
        encoding="utf-8",
    )
    (reports_dir / "direction_summary.md").write_text(
        render_direction_summary_markdown(direction_summaries),
        encoding="utf-8",
    )
    (reports_dir / "single_position_summary.md").write_text(
        render_single_position_markdown(single_position),
        encoding="utf-8",
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(f"{json.dumps(payload, indent=2)}\n", encoding="utf-8")

    print(f"Backtest {args.market} candles={len(candles)} signals={summary.signal_count}")
    for warning in validation.warnings:
        print(f"Data warning: {warning}")
    if args.source_timezone == "unspecified":
        print("Data warning: source timezone was not declared")
    print(
        " ".join(
            [
                f"mfe20={format_rate(summary.mfe20_rate)}",
                f"eod20={format_rate(summary.eod20_rate)}",
                f"swept={format_rate(summary.swept_invalidation_rate)}",
            ]
        )
    )
    print(f"Events CSV: {events_dir / 'reversal_event_study.csv'}")
    print(f"Summary: {reports_dir / 'reversal_summary.md'}")
    print(f"Walk-forward: {reports_dir / 'walk_forward_summary.md'}")
    print(
        "Single-position: "
        f"{reports_dir / 'single_position_summary.md'}"
    )
    print(f"Full JSON: {args.output}")


def scan_reversal_events(
    candles: list[Candle],
    market: str,
    replay_settings: ReplaySettings | None = None,
    execution_assumptions: ExecutionAssumptions | None = None,
    signal_scope: str = "alert",
) -> list[ReversalEvent]:
    """
    Replay the frozen signal one completed candle at a time.

    Only candles completed at or before the signal are passed into signal
    detection; forward candles are used only after a trigger has been selected.
    """

    settings = replay_settings or ReplaySettings(mode="every-bar")
    settings.validate()
    execution = execution_assumptions or ExecutionAssumptions()
    execution.validate()
    if signal_scope not in {"alert", "watch-and-alert"}:
        raise ValueError("signal_scope must be alert or watch-and-alert")
    sessions: dict[str, list[Candle]] = {}
    session_index = build_candle_session_index(candles)
    events = []
    for index, candle in enumerate(candles):
        session_key = date_key(candle.end_time)
        session = sessions.setdefault(session_key, [])
        session.append(candle)
        if not should_evaluate_candle(candle, settings):
            continue
        trigger_history = available_history(session, candle, settings)
        result = analyze_frozen_signal_v1(trigger_history, market)
        signal = (
            result.signal
            if signal_scope == "alert"
            else result.signal or result.watch
        )
        if signal is None or signal.timestamp != candle.end_time:
            continue
        indexed_session = session_index.get(candle.end_time)
        future_candles = candles[index + 1 :] if indexed_session is None else indexed_session[0][indexed_session[1] + 1 :]
        delivery_decision = (
            None
            if indexed_session is None
            else build_delivery_decision(
                indexed_session[0],
                indexed_session[1],
                signal,
                settings,
            )
        )
        events.append(
            build_reversal_event(
                signal,
                candle,
                trigger_history,
                future_candles,
                execution,
                delivery_decision,
            )
        )
    return events


def load_candles(
    path: Path,
    source_time_zone: str = "UTC",
    source_timestamp_mode: str = "utc-epoch",
) -> list[Candle]:
    """Load candles and optionally repair naive local epochs."""

    canonical = canonical_candle_stream(path)
    if canonical is not None:
        if source_timestamp_mode != "utc-epoch":
            raise ValueError("canonical market-bars/v2 timestamps are already UTC")
        return list(canonical)
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("input must be a JSON array of candle objects")
    candles = [Candle.from_dict(row) for row in raw]
    if source_timestamp_mode == "utc-epoch":
        return candles
    if source_timestamp_mode != "naive-local":
        raise ValueError(
            "source_timestamp_mode must be utc-epoch or naive-local"
        )
    time_zone = ZoneInfo(source_time_zone)
    return [
        reinterpret_naive_local_candle(candle, time_zone)
        for candle in candles
    ]


def reinterpret_naive_local_candle(
    candle: Candle,
    time_zone: ZoneInfo,
) -> Candle:
    """Apply an IANA zone to wall-clock values incorrectly stored as UTC."""

    duration = candle.end_time - candle.start_time
    naive_start = datetime.fromtimestamp(
        candle.start_time / 1000,
        tz=UTC,
    ).replace(tzinfo=None)
    start_time = int(
        naive_start.replace(tzinfo=time_zone).timestamp() * 1000
    )
    return Candle(
        start_time=start_time,
        end_time=start_time + duration,
        open=candle.open,
        high=candle.high,
        low=candle.low,
        close=candle.close,
        volume=candle.volume,
        trade_count=candle.trade_count,
    )


def filter_candles_for_session(
    candles: list[Candle],
    session_time_zone: str,
    session_profile: str,
) -> list[Candle]:
    """Keep only the declared session when replaying a cash-market proxy."""

    if session_profile == "unrestricted":
        return candles
    if session_profile != "rth":
        raise ValueError("session_profile must be unrestricted or rth")
    time_zone = ZoneInfo(session_time_zone)
    return [
        candle
        for candle in candles
        if is_rth_candle(candle, time_zone)
    ]


def is_rth_candle(candle: Candle, time_zone: ZoneInfo) -> bool:
    """Return whether a candle starts inside 09:30–16:00 local time."""

    local_start = datetime.fromtimestamp(
        candle.start_time / 1000,
        tz=time_zone,
    )
    minute_of_day = local_start.hour * 60 + local_start.minute
    return 9 * 60 + 30 <= minute_of_day < 16 * 60


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse command-line options."""

    parser = argparse.ArgumentParser(description="Run Python frozen-v1 reversal event study.")
    parser.add_argument("--input", required=True, type=Path, help="Path to candle JSON in the repo candle shape.")
    parser.add_argument("--output", type=Path, default=Path("backtest/reversal_backtest.json"), help="Full JSON output path.")
    parser.add_argument("--output-dir", type=Path, default=None, help="Directory for reports and event tables.")
    parser.add_argument("--market", default="SPX", help="Market label for the study.")
    parser.add_argument("--placebo-runs", type=int, default=1000, help="Matched random placebo runs.")
    parser.add_argument(
        "--bootstrap-runs",
        type=int,
        default=2000,
        help="Session-cluster bootstrap runs for 95%% confidence intervals.",
    )
    parser.add_argument(
        "--bootstrap-seed",
        type=int,
        default=42,
        help="Deterministic seed for session-cluster bootstrap.",
    )
    parser.add_argument(
        "--walk-forward-train-months",
        type=int,
        default=24,
        help="Calendar months in each rolling context window.",
    )
    parser.add_argument(
        "--walk-forward-test-months",
        type=int,
        default=6,
        help="Non-overlapping calendar months in each test window.",
    )
    parser.add_argument(
        "--replay-mode",
        choices=("live", "every-bar"),
        default="live",
        help=(
            "Use production catch-up semantics and lookback, or evaluate every "
            "completed candle with unrestricted session history."
        ),
    )
    parser.add_argument(
        "--regular-scan-minutes",
        type=int,
        default=15,
        help="Production scan interval outside the New York final hour.",
    )
    parser.add_argument(
        "--final-hour-scan-minutes",
        type=int,
        default=5,
        help="Production scan interval from 15:00 to 16:00 New York time.",
    )
    parser.add_argument(
        "--request-lookback-hours",
        type=int,
        default=18,
        help="Historical fetch window mirrored from the live candle request.",
    )
    parser.add_argument(
        "--expected-interval-minutes",
        type=int,
        default=5,
        help="Expected candle duration used by data validation.",
    )
    parser.add_argument(
        "--session-profile",
        choices=("unrestricted", "rth"),
        default="unrestricted",
        help=(
            "Use all source candles, or require a 09:30 New York open and "
            "replay only 09:30–16:00 cash-session candles."
        ),
    )
    parser.add_argument(
        "--entry-mode",
        choices=("next-open", "signal-close"),
        default="next-open",
        help="Executable entry model; signal-close remains available for legacy comparison.",
    )
    parser.add_argument(
        "--signal-scope",
        choices=("alert", "watch-and-alert"),
        default="alert",
        help="Evaluate strict alerts only or every live notification opportunity.",
    )
    parser.add_argument(
        "--slippage-points",
        type=float,
        default=0,
        help="Adverse slippage applied to both entry and exit fills.",
    )
    parser.add_argument(
        "--round-trip-cost-points",
        type=float,
        default=0,
        help="Additional round-trip cost deducted from each completed trade.",
    )
    parser.add_argument("--session-timezone", default="America/New_York", help="Session timezone for grouping.")
    parser.add_argument(
        "--source-timezone",
        default="unspecified",
        help="Provenance label for the timezone used to encode source timestamps.",
    )
    parser.add_argument(
        "--source-timestamp-mode",
        choices=("utc-epoch", "naive-local"),
        default="utc-epoch",
        help=(
            "Treat JSON epochs as real UTC, or reinterpret their displayed "
            "wall clock in --source-timezone for legacy naive-local files."
        ),
    )
    return parser.parse_args(argv)


def format_rate(value: float | None) -> str:
    """Format a nullable rate for console output."""

    return "n/a" if value is None else f"{value * 100:.2f}%"


if __name__ == "__main__":
    main()
