"""Command-line runner for the frozen market-fragility event study."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from reversal_scanner_backtest.cli import (
    filter_candles_for_session,
    is_rth_candle,
    reinterpret_naive_local_candle,
)
from reversal_scanner_backtest.fragility_study import (
    OUTCOME_THRESHOLDS,
    PRICE_INDICATOR_IDS,
    SESSION_HORIZONS,
    FragilityObservation,
    FragilityReplaySettings,
    SessionPathSummary,
    add_session_horizon_outcomes,
    build_fragility_observations,
    build_fragility_rolling_stability,
    build_session_fragility_observations,
    build_session_path_summary,
    build_fragility_yearly_summary,
    frozen_fragility_thresholds,
    observations_to_csv,
    render_fragility_comparison_markdown,
    render_fragility_rolling_markdown,
    render_fragility_summary_markdown,
    summarize_fragility_observations,
    yearly_summary_to_csv,
)
from reversal_scanner_backtest.models import Candle
from reversal_scanner_backtest.market_data import canonical_candle_stream
from reversal_scanner_backtest.validation import (
    DatasetValidationReport,
    dataset_sha256,
    validate_candle_stream,
    validate_candles,
)

FRAGILITY_BACKTEST_SCHEMA_VERSION = 1
CLASSIFIER_VERSION = "fragility-price-only-v1"
JSON_READ_CHUNK_SIZE = 1024 * 1024
JSON_REFILL_THRESHOLD = 64 * 1024


@dataclass(frozen=True)
class StreamingReplayResult:
    """Bounded-memory replay result for one primary price source."""

    validation: DatasetValidationReport
    observations: list[FragilityObservation]
    candle_count: int
    first_timestamp: int
    last_timestamp: int


def main(argv: Sequence[str] | None = None) -> None:
    """Run the price-only fragility replay and write reproducible artifacts."""

    args = parse_args(argv)
    settings = FragilityReplaySettings(
        brief_interval_minutes=args.brief_interval_minutes,
        session_time_zone=args.session_timezone,
        bootstrap_runs=args.bootstrap_runs,
        bootstrap_seed=args.bootstrap_seed,
        bootstrap_block_sessions=args.bootstrap_block_sessions,
        walk_forward_train_months=args.walk_forward_train_months,
        walk_forward_test_months=args.walk_forward_test_months,
    )
    settings.validate()
    volume_metadata: dict[str, object] | None = None
    if args.volume_input is not None:
        loaded_candles = load_candles_streaming(
            args.input,
            args.source_timezone,
            args.source_timestamp_mode,
        )
        volume_candles = load_candles_streaming(
            args.volume_input,
            args.volume_source_timezone,
            args.volume_source_timestamp_mode,
        )
        loaded_candles, volume_coverage = apply_proxy_volume(
            loaded_candles,
            volume_candles,
        )
        volume_metadata = {
            "path": str(args.volume_input),
            "sha256": dataset_sha256(args.volume_input),
            "sourceLabel": args.volume_source_label,
            "sourceTimeZone": args.volume_source_timezone,
            "sourceTimestampMode": args.volume_source_timestamp_mode,
            "matchedPrimaryCandleRate": volume_coverage,
        }
        validation = validate_candles(
            loaded_candles,
            5,
            args.session_timezone,
            "rth",
        )
        if not validation.is_valid:
            raise ValueError("; ".join(validation.errors))
        candles = filter_candles_for_session(
            loaded_candles,
            args.session_timezone,
            "rth",
        )
        if not candles:
            raise ValueError("no RTH candles remain after filtering")
        observations = build_fragility_observations(candles, settings)
        candle_count = len(candles)
        first_timestamp = candles[0].start_time
        last_timestamp = candles[-1].end_time
        vwap_mode = determine_vwap_mode(
            loaded_candles,
            uses_proxy_volume=True,
        )
    else:
        replay = build_streaming_replay(
            args.input,
            args.source_timezone,
            args.source_timestamp_mode,
            settings,
        )
        validation = replay.validation
        observations = replay.observations
        candle_count = replay.candle_count
        first_timestamp = replay.first_timestamp
        last_timestamp = replay.last_timestamp
        vwap_mode = determine_vwap_mode_from_rate(
            (
                None
                if validation.zero_volume_rate is None
                else 1 - validation.zero_volume_rate
            ),
            uses_proxy_volume=False,
        )
    if not observations:
        raise ValueError("no scheduled fragility observations were produced")
    summary = summarize_fragility_observations(observations, settings)
    yearly = build_fragility_yearly_summary(observations)
    rolling = build_fragility_rolling_stability(
        observations,
        settings.walk_forward_train_months,
        settings.walk_forward_test_months,
    )
    warnings = list(validation.warnings)
    warnings.append(
        "historical breadth and SP500/XYZ100 context are absent; all states use four of six indicators"
    )
    if volume_metadata is not None:
        coverage = float(volume_metadata["matchedPrimaryCandleRate"])
        if coverage < 0.99:
            warnings.append(
                f"proxy volume matched {coverage:.2%} of primary candles"
            )
    methodology = methodology_snapshot(settings, vwap_mode)
    methodology_fingerprint = fingerprint(methodology)
    input_sha256 = dataset_sha256(args.input)
    run_id = (
        "fragility-v1-"
        + fingerprint(
            {
                "inputSha256": input_sha256,
                "methodologyFingerprint": methodology_fingerprint,
            }
        )[:12]
    )
    payload: dict[str, object] = {
        "schemaVersion": FRAGILITY_BACKTEST_SCHEMA_VERSION,
        "runId": run_id,
        "createdAt": datetime.now(tz=UTC).isoformat(),
        "market": args.market,
        "input": {
            "path": str(args.input),
            "sha256": input_sha256,
            "sourceLabel": args.source_label,
            "sourceTimeZone": args.source_timezone,
            "sourceTimestampMode": args.source_timestamp_mode,
            "validation": validation.to_dict(),
            "warnings": warnings,
        },
        "volumeSource": volume_metadata,
        "repository": repository_state(),
        "methodologyFingerprint": methodology_fingerprint,
        "methodology": methodology,
        "candleCount": candle_count,
        "range": {
            "start": _iso_timestamp(first_timestamp),
            "end": _iso_timestamp(last_timestamp),
        },
        "summary": summary,
        "yearlySummary": yearly,
        "rollingStability": rolling,
        "limitations": [
            "classifier output is ordinal and is not a calibrated crash probability",
            "this run is a diagnostic event study and contains no trade or option PnL assumptions",
            "breadth and cross-index indicators remain unavailable rather than backfilled with survivor-biased proxies",
            "five-session labels overlap; moving-block intervals reduce but do not eliminate serial-dependence risk",
        ],
    }
    write_outputs(args.output_dir, payload, observations, yearly, rolling)
    if args.compare_to is not None:
        baseline = json.loads(args.compare_to.read_text(encoding="utf-8"))
        comparison = render_fragility_comparison_markdown(
            baseline,
            payload,
        )
        reports_dir = args.output_dir / "reports"
        (reports_dir / "comparison.md").write_text(
            comparison,
            encoding="utf-8",
        )
    print_headline(payload, args.output_dir)


def apply_proxy_volume(
    primary_candles: list[Candle],
    volume_candles: list[Candle],
) -> tuple[list[Candle], float]:
    """Apply aligned proxy volumes without replacing primary index prices."""

    volume_by_start = {
        candle.start_time: candle.volume for candle in volume_candles
    }
    matched = 0
    merged: list[Candle] = []
    for candle in primary_candles:
        proxy_volume = volume_by_start.get(candle.start_time)
        if proxy_volume is None:
            merged.append(candle)
            continue
        matched += 1
        merged.append(replace(candle, volume=proxy_volume))
    coverage = 0.0 if not primary_candles else matched / len(primary_candles)
    return merged, coverage


def load_candles_streaming(
    path: Path,
    source_time_zone: str = "UTC",
    source_timestamp_mode: str = "utc-epoch",
) -> list[Candle]:
    """Load a top-level JSON candle array without retaining raw dict rows."""

    return list(
        iter_candles_streaming(
            path,
            source_time_zone,
            source_timestamp_mode,
        )
    )


def iter_candles_streaming(
    path: Path,
    source_time_zone: str = "UTC",
    source_timestamp_mode: str = "utc-epoch",
) -> Iterator[Candle]:
    """Yield normalized candles without retaining the source array."""

    if source_timestamp_mode not in {"utc-epoch", "naive-local"}:
        raise ValueError(
            "source_timestamp_mode must be utc-epoch or naive-local"
        )
    canonical = canonical_candle_stream(path)
    if canonical is not None:
        if source_timestamp_mode != "utc-epoch":
            raise ValueError("canonical market-bars/v2 timestamps are already UTC")
        yield from canonical
        return
    source_zone = ZoneInfo(source_time_zone)
    for row in iter_json_array(path):
        candle = Candle.from_dict(row)
        yield (
            candle
            if source_timestamp_mode == "utc-epoch"
            else reinterpret_naive_local_candle(candle, source_zone)
        )


def build_streaming_replay(
    path: Path,
    source_time_zone: str,
    source_timestamp_mode: str,
    settings: FragilityReplaySettings,
) -> StreamingReplayResult:
    """Validate twice-read JSON and retain only one RTH session at a time."""

    validation = validate_candle_stream(
        iter_candles_streaming(
            path,
            source_time_zone,
            source_timestamp_mode,
        ),
        expected_interval_minutes=5,
        session_time_zone=settings.session_time_zone,
        session_profile="rth",
    )
    if not validation.is_valid:
        raise ValueError("; ".join(validation.errors))

    time_zone = ZoneInfo(settings.session_time_zone)
    current_date: str | None = None
    current_session: list[Candle] = []
    observations: list[FragilityObservation] = []
    path_summaries: list[SessionPathSummary] = []
    candle_count = 0
    first_timestamp: int | None = None
    last_timestamp: int | None = None

    def finalize_session() -> None:
        if current_date is None or not current_session:
            return
        observations.extend(
            build_session_fragility_observations(
                current_date,
                current_session,
                settings,
            )
        )
        path_summaries.append(
            build_session_path_summary(current_date, current_session)
        )

    for candle in iter_candles_streaming(
        path,
        source_time_zone,
        source_timestamp_mode,
    ):
        if not is_rth_candle(candle, time_zone):
            continue
        session_date = datetime.fromtimestamp(
            candle.start_time / 1000,
            tz=time_zone,
        ).date().isoformat()
        if current_date is not None and session_date != current_date:
            finalize_session()
            current_session = []
        current_date = session_date
        current_session.append(candle)
        candle_count += 1
        first_timestamp = (
            candle.start_time
            if first_timestamp is None
            else first_timestamp
        )
        last_timestamp = candle.end_time
    finalize_session()

    if first_timestamp is None or last_timestamp is None:
        raise ValueError("no RTH candles remain after filtering")
    return StreamingReplayResult(
        validation=validation,
        observations=add_session_horizon_outcomes(
            observations,
            path_summaries,
        ),
        candle_count=candle_count,
        first_timestamp=first_timestamp,
        last_timestamp=last_timestamp,
    )


def iter_json_array(path: Path) -> Iterator[dict[str, object]]:
    """Yield dict rows from one JSON array with bounded parser memory."""

    decoder = json.JSONDecoder()
    with path.open("r", encoding="utf-8") as source:
        buffer = ""
        cursor = 0
        array_started = False
        reached_eof = False
        while True:
            if (
                not reached_eof
                and len(buffer) - cursor < JSON_REFILL_THRESHOLD
            ):
                # Retain an index into the current chunk instead of slicing the
                # remaining buffer after every row. On large JSON arrays those
                # repeated slices otherwise dominate the complete replay.
                buffer = buffer[cursor:]
                cursor = 0
                chunk = source.read(JSON_READ_CHUNK_SIZE)
                if chunk:
                    buffer += chunk
                else:
                    reached_eof = True

            while cursor < len(buffer) and buffer[cursor].isspace():
                cursor += 1
            if not array_started:
                if cursor >= len(buffer):
                    if not reached_eof:
                        continue
                    raise ValueError("input JSON is empty")
                if buffer[cursor] != "[":
                    raise ValueError("input must be a JSON array")
                cursor += 1
                array_started = True
                continue

            if cursor < len(buffer) and buffer[cursor] == ",":
                cursor += 1
                while cursor < len(buffer) and buffer[cursor].isspace():
                    cursor += 1
            if cursor < len(buffer) and buffer[cursor] == "]":
                return
            if cursor >= len(buffer):
                if reached_eof:
                    raise ValueError("input JSON array is truncated")
                continue
            try:
                value, end_index = decoder.raw_decode(buffer, cursor)
            except json.JSONDecodeError:
                if reached_eof:
                    raise ValueError("input JSON array is truncated") from None
                buffer = buffer[cursor:]
                cursor = 0
                chunk = source.read(JSON_READ_CHUNK_SIZE)
                if not chunk:
                    reached_eof = True
                    continue
                buffer += chunk
                continue
            if not isinstance(value, dict):
                raise ValueError("every candle row must be a JSON object")
            yield value
            cursor = end_index


def determine_vwap_mode(
    candles: list[Candle],
    uses_proxy_volume: bool,
) -> str:
    """Describe the effective VWAP calculation for methodology snapshots."""

    nonzero_volume_rate = (
        0.0
        if not candles
        else sum(candle.volume > 0 for candle in candles) / len(candles)
    )
    return determine_vwap_mode_from_rate(
        nonzero_volume_rate,
        uses_proxy_volume,
    )


def determine_vwap_mode_from_rate(
    nonzero_volume_rate: float | None,
    uses_proxy_volume: bool,
) -> str:
    """Describe VWAP from a precomputed nonzero-volume rate."""

    if not nonzero_volume_rate:
        return "close-mean-fallback"
    if uses_proxy_volume:
        return "proxy-volume-weighted-primary-typical-price"
    return "input-volume-weighted-typical-price"


def methodology_snapshot(
    settings: FragilityReplaySettings,
    vwap_mode: str,
) -> dict[str, object]:
    """Return all frozen rules needed to compare future classifier versions."""

    return {
        "classifierVersion": CLASSIFIER_VERSION,
        "thresholds": frozen_fragility_thresholds(),
        "availableIndicators": list(PRICE_INDICATOR_IDS),
        "unavailableIndicators": [
            "mega_cap_breadth",
            "equity_cross_confirmation",
        ],
        "vwapMode": vwap_mode,
        "replay": {
            "sessionProfile": "rth",
            "sessionTimeZone": settings.session_time_zone,
            "briefIntervalMinutes": settings.brief_interval_minutes,
            "observationPrice": "latest completed candle close",
            "firstEligibleBriefRequiresCandles": 6,
        },
        "outcomes": {
            "minuteHorizons": [30, 60, 120],
            "sessionHorizons": list(SESSION_HORIZONS.values()),
            "eventThresholds": OUTCOME_THRESHOLDS,
            "pathMinimumUsesFutureLowsOnly": True,
            "closeReturnUsesHorizonFinalClose": True,
            "missingFullHorizonIsNull": True,
        },
        "predictionRule": "FRAGILE, BREAKING, or PANIC",
        "bootstrap": {
            "type": "circular moving block",
            "runs": settings.bootstrap_runs,
            "seed": settings.bootstrap_seed,
            "blockSessions": settings.bootstrap_block_sessions,
        },
        "rollingStability": {
            "contextMonths": settings.walk_forward_train_months,
            "testMonths": settings.walk_forward_test_months,
            "parametersSelectedInsideFolds": False,
        },
    }


def fingerprint(value: object) -> str:
    """Return a deterministic SHA-256 for a JSON-compatible object."""

    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def repository_state() -> dict[str, object]:
    """Capture commit identity and dirtiness without requiring Git."""

    project_root = Path(__file__).resolve().parents[2]
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=project_root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=project_root,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
        )
        return {"commit": commit, "workingTreeDirty": dirty}
    except (OSError, subprocess.CalledProcessError):
        return {"commit": None, "workingTreeDirty": None}


def write_outputs(
    output_dir: Path,
    payload: dict[str, object],
    observations: list[FragilityObservation],
    yearly: list[dict[str, object]],
    rolling: dict[str, object] | None,
) -> None:
    """Write stable JSON, CSV, Markdown, and methodology artifacts."""

    events_dir = output_dir / "events"
    reports_dir = output_dir / "reports"
    methodology_dir = output_dir / "methodology"
    for directory in (output_dir, events_dir, reports_dir, methodology_dir):
        directory.mkdir(parents=True, exist_ok=True)
    (output_dir / "fragility_backtest.json").write_text(
        json.dumps(payload, indent=2) + "\n",
        encoding="utf-8",
    )
    (events_dir / "fragility_observations.csv").write_text(
        observations_to_csv(observations),
        encoding="utf-8",
    )
    (reports_dir / "fragility_summary.md").write_text(
        render_fragility_summary_markdown(payload),
        encoding="utf-8",
    )
    (reports_dir / "rolling_stability.md").write_text(
        render_fragility_rolling_markdown(rolling),
        encoding="utf-8",
    )
    (reports_dir / "yearly_summary.csv").write_text(
        yearly_summary_to_csv(yearly),
        encoding="utf-8",
    )
    (methodology_dir / "methodology_snapshot.json").write_text(
        json.dumps(
            {
                "schemaVersion": payload["schemaVersion"],
                "runId": payload["runId"],
                "methodologyFingerprint": payload[
                    "methodologyFingerprint"
                ],
                "methodology": payload["methodology"],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def print_headline(payload: dict[str, object], output_dir: Path) -> None:
    """Print compact reproducibility and diagnostic results."""

    summary = payload["summary"]
    assert isinstance(summary, dict)
    prediction = summary["fragilePlus"]
    assert isinstance(prediction, dict)
    intraday = prediction["120m"]
    swing = prediction["5sessions"]
    assert isinstance(intraday, dict)
    assert isinstance(swing, dict)
    print(
        f"Fragility backtest observations={summary['observationCount']} "
        f"sessions={summary['sessionCount']} run={payload['runId']}"
    )
    print(
        " ".join(
            [
                f"120m_precision={_format_rate(intraday['precision'])}",
                f"120m_recall={_format_rate(intraday['recall'])}",
                f"5session_precision={_format_rate(swing['precision'])}",
                f"5session_recall={_format_rate(swing['recall'])}",
            ]
        )
    )
    print(f"Summary: {output_dir / 'reports' / 'fragility_summary.md'}")
    print(f"Full JSON: {output_dir / 'fragility_backtest.json'}")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse the stable schema-v1 command-line contract."""

    parser = argparse.ArgumentParser(
        description="Run the frozen SP500 market-fragility event study.",
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("backtest/fragility"),
    )
    parser.add_argument("--market", default="SPX")
    parser.add_argument("--source-label", default="local-candle-json")
    parser.add_argument("--source-timezone", default="UTC")
    parser.add_argument(
        "--source-timestamp-mode",
        choices=("utc-epoch", "naive-local"),
        default="utc-epoch",
    )
    parser.add_argument("--session-timezone", default="America/New_York")
    parser.add_argument("--brief-interval-minutes", type=int, default=30)
    parser.add_argument("--bootstrap-runs", type=int, default=1000)
    parser.add_argument("--bootstrap-seed", type=int, default=42)
    parser.add_argument(
        "--bootstrap-block-sessions",
        type=int,
        default=5,
    )
    parser.add_argument(
        "--walk-forward-train-months",
        type=int,
        default=24,
    )
    parser.add_argument(
        "--walk-forward-test-months",
        type=int,
        default=6,
    )
    parser.add_argument("--volume-input", type=Path, default=None)
    parser.add_argument(
        "--volume-source-label",
        default="external-volume-proxy",
    )
    parser.add_argument("--volume-source-timezone", default="UTC")
    parser.add_argument(
        "--volume-source-timestamp-mode",
        choices=("utc-epoch", "naive-local"),
        default="utc-epoch",
    )
    parser.add_argument("--compare-to", type=Path, default=None)
    return parser.parse_args(argv)


def _iso_timestamp(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp / 1000, tz=UTC).isoformat()


def _format_rate(value: object) -> str:
    return "n/a" if value is None else f"{float(value) * 100:.2f}%"


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"fragility backtest failed: {error}", file=sys.stderr)
        raise
