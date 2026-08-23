"""Command-line runner for the resilience-decay event study."""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from reversal_scanner_backtest.cli import filter_candles_for_session
from reversal_scanner_backtest.fragility_cli import (
    fingerprint,
    load_candles_streaming,
    repository_state,
)
from reversal_scanner_backtest.resilience_decay_study import (
    FIVE_SESSION_DRAWDOWN_THRESHOLD,
    MINIMUM_PREDICTIVE_COHORT_SESSIONS,
    ONE_SESSION_DRAWDOWN_THRESHOLD,
    ResilienceParameters,
    ResilienceReplayResult,
    ResilienceReplaySettings,
    build_resilience_replay,
    build_sensitivity_analysis,
    events_to_csv,
    observations_to_csv,
    summarize_resilience_replay,
)
from reversal_scanner_backtest.validation import dataset_sha256, validate_candles

RESILIENCE_BACKTEST_SCHEMA_VERSION = 1
RESEARCH_VERSION = "resilience-decay-v1"


def main(argv: Sequence[str] | None = None) -> None:
    """Run the no-lookahead replay and write reproducible artifacts."""

    args = parse_args(argv)
    settings = ResilienceReplaySettings(
        session_time_zone=args.session_timezone,
        bootstrap_runs=args.bootstrap_runs,
        bootstrap_seed=args.bootstrap_seed,
        bootstrap_block_sessions=args.bootstrap_block_sessions,
    )
    parameters = ResilienceParameters()
    settings.validate()
    parameters.validate()
    loaded = load_candles_streaming(
        args.input,
        args.source_timezone,
        args.source_timestamp_mode,
    )
    source_validation = validate_candles(
        loaded,
        expected_interval_minutes=5,
        session_time_zone=args.session_timezone,
        session_profile="unrestricted",
    )
    if not source_validation.is_valid:
        raise ValueError("; ".join(source_validation.errors))
    candles = filter_candles_for_session(
        loaded,
        args.session_timezone,
        "rth",
    )
    rth_validation = validate_candles(
        candles,
        expected_interval_minutes=5,
        session_time_zone=args.session_timezone,
        session_profile="rth",
    )
    if not rth_validation.is_valid:
        raise ValueError("; ".join(rth_validation.errors))
    if not candles:
        raise ValueError("no RTH candles remain after filtering")

    replay = build_resilience_replay(candles, parameters, settings)
    summary = summarize_resilience_replay(replay, settings)
    sensitivity = (
        []
        if args.skip_sensitivity
        else build_sensitivity_analysis(
            candles,
            settings,
            parameters,
            baseline_replay=replay,
        )
    )
    methodology = methodology_snapshot(parameters, settings)
    methodology_fingerprint = fingerprint(methodology)
    input_sha256 = dataset_sha256(args.input)
    run_id = (
        "resilience-decay-v1-"
        + fingerprint(
            {
                "inputSha256": input_sha256,
                "methodologyFingerprint": methodology_fingerprint,
            }
        )[:12]
    )
    payload: dict[str, object] = {
        "schemaVersion": RESILIENCE_BACKTEST_SCHEMA_VERSION,
        "runId": run_id,
        "createdAt": datetime.now(tz=UTC).isoformat(),
        "market": args.market,
        "input": {
            "path": str(args.input),
            "sha256": input_sha256,
            "sourceLabel": args.source_label,
            "sourceTimeZone": args.source_timezone,
            "sourceTimestampMode": args.source_timestamp_mode,
            "sourceValidation": source_validation.to_dict(),
            "rthValidation": rth_validation.to_dict(),
        },
        "repository": repository_state(),
        "range": {
            "start": iso_timestamp(candles[0].start_time),
            "end": iso_timestamp(candles[-1].end_time),
        },
        "candleCount": len(candles),
        "methodologyFingerprint": methodology_fingerprint,
        "methodology": methodology,
        "summary": summary,
        "sensitivity": sensitivity,
        "warnings": research_warnings(replay, summary, rth_validation.warnings),
        "limitations": [
            "threshold and weight variants are diagnostics, not optimizer-selected live replacements",
            "five-minute sensitivity can reveal missed paths but does not reconstruct sub-five-minute moves",
            "late-session complete-case exclusion can change the population of scored shocks",
            "session-block intervals reduce false precision but do not remove regime or vendor bias",
            "downside outcomes are event-study labels and contain no execution or option PnL model",
        ],
    }
    write_outputs(args.output_dir, payload, replay, sensitivity)
    print_headline(payload, args.output_dir)


def methodology_snapshot(
    parameters: ResilienceParameters,
    settings: ResilienceReplaySettings,
) -> dict[str, object]:
    """Return the full frozen contract needed to compare future runs."""

    return {
        "researchVersion": RESEARCH_VERSION,
        "liveParityParameters": parameters.to_dict(),
        "replay": {
            "sessionProfile": "rth",
            "sessionTimeZone": settings.session_time_zone,
            "inputCandleMinutes": 5,
            "observationPrice": "latest completed grid candle close",
            "sessionHigh": "cumulative high from completed five-minute candles",
            "troughPolicy": "checkpoint-visible and frozen after recovery",
            "lateEventPolicy": "complete case; missing checkpoints remain unscored",
            "startEligibilityGate": parameters.require_two_hour_eligible_start,
            "retainedCompletedShockLimit": parameters.maximum_completed_shocks,
            "classificationObservation": "one row after each session close",
        },
        "outcomes": {
            "oneSession": {
                "futureSessions": 1,
                "drawdownThreshold": ONE_SESSION_DRAWDOWN_THRESHOLD,
            },
            "fiveSessions": {
                "futureSessions": 5,
                "drawdownThreshold": FIVE_SESSION_DRAWDOWN_THRESHOLD,
            },
            "futureOnly": True,
            "missingFullHorizonIsNull": True,
        },
        "chronologicalSlices": {
            "developmentShare": 0.6,
            "validationShare": 0.2,
            "holdoutShare": 0.2,
            "parametersSelectedUsingHoldout": False,
        },
        "bootstrap": {
            "type": "circular moving block",
            "runs": settings.bootstrap_runs,
            "seed": settings.bootstrap_seed,
            "blockSessions": settings.bootstrap_block_sessions,
            "resamplingUnit": "consecutive session-date blocks",
        },
        "sensitivity": {
            "type": "one parameter at a time",
            "selectionPolicy": "report all variants; do not select a winner",
            "dimensions": [
                "observation interval",
                "shock threshold",
                "recent resilience floor",
                "decay delta threshold",
                "checkpoint weights",
            ],
        },
    }


def research_warnings(
    replay: ResilienceReplayResult,
    summary: dict[str, object],
    validation_warnings: list[str],
) -> list[str]:
    """Add explicit interpretation warnings derived from the run."""

    warnings = list(validation_warnings)
    event_coverage = summary["eventCoverage"]
    status_observations = summary["statusObservations"]
    assert isinstance(event_coverage, dict)
    assert isinstance(status_observations, dict)
    if int(event_coverage["scoredEventCount"]) < 8:
        warnings.append(
            "fewer than eight scored shocks were available; decay classification cannot be evaluated"
        )
    fading = status_observations.get("FADING")
    fading_observations = (
        0 if not isinstance(fading, dict) else int(fading["observations"])
    )
    if fading_observations == 0:
        warnings.append(
            "no FADING session observations were available; predictive separation is unidentifiable"
        )
    elif fading_observations < MINIMUM_PREDICTIVE_COHORT_SESSIONS:
        warnings.append(
            "FADING has fewer than "
            f"{MINIMUM_PREDICTIVE_COHORT_SESSIONS} independent sessions; "
            "predictive differences and intervals are suppressed"
        )
    if not replay.events:
        warnings.append("no qualifying shocks were found")
    return warnings


def write_outputs(
    output_dir: Path,
    payload: dict[str, object],
    replay: ResilienceReplayResult,
    sensitivity: list[dict[str, object]],
) -> None:
    """Write stable JSON, CSV, Markdown, and methodology outputs."""

    events_dir = output_dir / "events"
    reports_dir = output_dir / "reports"
    methodology_dir = output_dir / "methodology"
    for directory in (output_dir, events_dir, reports_dir, methodology_dir):
        directory.mkdir(parents=True, exist_ok=True)
    (output_dir / "resilience_decay_backtest.json").write_text(
        json.dumps(payload, indent=2) + "\n",
        encoding="utf-8",
    )
    (events_dir / "resilience_shocks.csv").write_text(
        events_to_csv(replay.events, replay.parameters),
        encoding="utf-8",
    )
    (events_dir / "resilience_session_observations.csv").write_text(
        observations_to_csv(replay.observations),
        encoding="utf-8",
    )
    (reports_dir / "resilience_decay_summary.md").write_text(
        render_summary_markdown(payload),
        encoding="utf-8",
    )
    (reports_dir / "sensitivity.csv").write_text(
        sensitivity_to_csv(sensitivity),
        encoding="utf-8",
    )
    (methodology_dir / "methodology_snapshot.json").write_text(
        json.dumps(
            {
                "schemaVersion": payload["schemaVersion"],
                "runId": payload["runId"],
                "methodologyFingerprint": payload["methodologyFingerprint"],
                "methodology": payload["methodology"],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def render_summary_markdown(payload: dict[str, object]) -> str:
    """Render the core methodological verdict without promotional language."""

    summary = payload["summary"]
    assert isinstance(summary, dict)
    coverage = summary["eventCoverage"]
    statuses = summary["statusObservations"]
    separation = summary["fadingVsResilient"]
    bootstrap = summary["movingBlockBootstrap"]
    assert isinstance(coverage, dict)
    assert isinstance(statuses, dict)
    assert isinstance(separation, dict)
    assert isinstance(bootstrap, dict)
    lines = [
        "# Resilience Decay Backtest Summary",
        "",
        f"Run: `{payload['runId']}`",
        "",
        "This is a diagnostic event study, not a trading backtest.",
        "",
        "## Coverage",
        "",
        f"- Sessions: {summary['sessionCount']}",
        f"- Shocks: {coverage['eventCount']}",
        f"- Scored shocks: {coverage['scoredEventCount']}",
        f"- Scored rate: {format_percent(coverage['scoredEventRate'])}",
        f"- Event-weighted mean score: {format_number(coverage['eventWeightedMeanScore'])}",
        f"- Session-weighted mean score: {format_number(coverage['sessionWeightedMeanScore'])}",
        "",
        "## Status prevalence",
        "",
        "| Status | Sessions | Share |",
        "| --- | ---: | ---: |",
    ]
    for status in ("INSUFFICIENT_DATA", "RESILIENT", "FADING", "FRAGILE"):
        item = statuses.get(status)
        if not isinstance(item, dict):
            continue
        lines.append(
            f"| {status} | {item['observations']} | {format_percent(item['share'])} |"
        )
    lines.extend(
        [
            "",
            "## FADING minus RESILIENT",
            "",
            "| Horizon | Drawdown-rate difference | Minimum-return difference |",
            "| --- | ---: | ---: |",
        ]
    )
    for horizon, label in (("oneSession", "1 session"), ("fiveSessions", "5 sessions")):
        item = separation[horizon]
        assert isinstance(item, dict)
        lines.append(
            f"| {label} | {format_percent(item['drawdownEventRateDifference'])} | "
            f"{format_percent(item['meanMinimumReturnDifference'])} |"
        )
    metrics = bootstrap["metrics"]
    assert isinstance(metrics, dict)
    lines.extend(
        [
            "",
            "## Session-block uncertainty",
            "",
            f"Runs: {bootstrap['runs']}; block sessions: {bootstrap['blockSessions']}.",
            "",
        ]
    )
    for name, interval in metrics.items():
        assert isinstance(interval, dict)
        lines.append(
            f"- {name}: {format_number(interval['estimate'])} "
            f"[{format_number(interval['lower95'])}, {format_number(interval['upper95'])}]"
        )
    warnings = payload["warnings"]
    assert isinstance(warnings, list)
    lines.extend(["", "## Warnings", ""])
    lines.extend(f"- {warning}" for warning in warnings)
    lines.extend(
        [
            "",
            "Do not promote parameters from this report unless holdout separation,",
            "clustered intervals, and sensitivity variants agree.",
            "",
        ]
    )
    return "\n".join(lines)


def sensitivity_to_csv(rows: list[dict[str, object]]) -> str:
    """Render compact one-at-a-time sensitivity comparisons."""

    fieldnames = [
        "name",
        "observation_interval_minutes",
        "shock_drop_threshold",
        "fading_recent_minimum",
        "fading_decay_delta_threshold",
        "require_two_hour_eligible_start",
        "event_count",
        "scored_event_rate",
        "event_weighted_mean_score",
        "session_weighted_mean_score",
        "fading_observations",
        "fading_share",
        "holdout_fading_share",
        "holdout_one_session_drawdown_rate_difference",
        "holdout_five_session_drawdown_rate_difference",
    ]
    output = io.StringIO()
    writer = csv.DictWriter(output, fieldnames=fieldnames)
    writer.writeheader()
    for row in rows:
        parameters = row["parameters"]
        slices = row["chronologicalSlices"]
        assert isinstance(parameters, dict)
        assert isinstance(slices, dict)
        holdout = slices.get("holdout", {})
        assert isinstance(holdout, dict)
        separation = holdout.get("fadingVsResilient", {})
        assert isinstance(separation, dict)
        one_session = separation.get("oneSession", {})
        five_sessions = separation.get("fiveSessions", {})
        assert isinstance(one_session, dict)
        assert isinstance(five_sessions, dict)
        writer.writerow(
            {
                "name": row["name"],
                "observation_interval_minutes": parameters[
                    "observationIntervalMinutes"
                ],
                "shock_drop_threshold": parameters["shockDropThreshold"],
                "fading_recent_minimum": parameters["fadingRecentMinimum"],
                "fading_decay_delta_threshold": parameters[
                    "fadingDecayDeltaThreshold"
                ],
                "require_two_hour_eligible_start": parameters[
                    "requireTwoHourEligibleStart"
                ],
                "event_count": row["eventCount"],
                "scored_event_rate": row["scoredEventRate"],
                "event_weighted_mean_score": row["eventWeightedMeanScore"],
                "session_weighted_mean_score": row[
                    "sessionWeightedMeanScore"
                ],
                "fading_observations": row["fadingObservations"],
                "fading_share": row["fadingShare"],
                "holdout_fading_share": holdout.get("fadingShare"),
                "holdout_one_session_drawdown_rate_difference": one_session.get(
                    "drawdownEventRateDifference"
                ),
                "holdout_five_session_drawdown_rate_difference": five_sessions.get(
                    "drawdownEventRateDifference"
                ),
            }
        )
    return output.getvalue()


def print_headline(payload: dict[str, object], output_dir: Path) -> None:
    """Print compact coverage and artifact paths."""

    summary = payload["summary"]
    assert isinstance(summary, dict)
    coverage = summary["eventCoverage"]
    statuses = summary["statusObservations"]
    assert isinstance(coverage, dict)
    assert isinstance(statuses, dict)
    fading = statuses.get("FADING", {})
    assert isinstance(fading, dict)
    print(
        f"Resilience decay sessions={summary['sessionCount']} "
        f"events={coverage['eventCount']} scored={coverage['scoredEventCount']} "
        f"run={payload['runId']}"
    )
    print(
        f"FADING observations={fading.get('observations', 0)} "
        f"share={format_percent(fading.get('share'))}"
    )
    print(f"Summary: {output_dir / 'reports' / 'resilience_decay_summary.md'}")
    print(f"Full JSON: {output_dir / 'resilience_decay_backtest.json'}")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse the stable resilience-decay research contract."""

    parser = argparse.ArgumentParser(
        description="Run the SP500 resilience-decay diagnostic event study.",
    )
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("backtest/resilience-decay-v1"),
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
    parser.add_argument("--bootstrap-runs", type=int, default=1_000)
    parser.add_argument("--bootstrap-seed", type=int, default=42)
    parser.add_argument("--bootstrap-block-sessions", type=int, default=5)
    parser.add_argument("--skip-sensitivity", action="store_true")
    return parser.parse_args(argv)


def iso_timestamp(timestamp: int) -> str:
    """Render one millisecond timestamp in UTC."""

    return datetime.fromtimestamp(timestamp / 1000, tz=UTC).isoformat()


def format_percent(value: object) -> str:
    """Render one optional decimal rate."""

    return "n/a" if value is None else f"{float(value) * 100:.2f}%"


def format_number(value: object) -> str:
    """Render one optional numeric statistic."""

    return "n/a" if value is None else f"{float(value):.4f}"


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"resilience decay backtest failed: {error}", file=sys.stderr)
        raise
