"""Command-line evaluation for the fragility-v2 shadow candidate."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from reversal_scanner_backtest.fragility_v2 import (
    CandidateLevel,
    FragilityV2Row,
    FragilityV2Settings,
    build_fragility_v2_evaluation,
    normalized_severity_margins,
)

SCHEMA_VERSION = 1


def main(argv: Sequence[str] | None = None) -> None:
    """Evaluate the v2 shadow candidate from a canonical v1 observation CSV."""

    args = parse_args(argv)
    settings = FragilityV2Settings(
        context_months=args.context_months,
        test_months=args.test_months,
        bootstrap_runs=args.bootstrap_runs,
        bootstrap_seed=args.bootstrap_seed,
        bootstrap_block_sessions=args.bootstrap_block_sessions,
    )
    rows = load_fragility_v2_rows(args.input_observations)
    evaluation = build_fragility_v2_evaluation(rows, settings)
    input_sha256 = file_sha256(args.input_observations)
    methodology = _methodology_metadata(evaluation)
    methodology_fingerprint = methodology["fingerprint"]
    assert isinstance(methodology_fingerprint, str)
    payload: dict[str, object] = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": (
            f"fragility-v2-{input_sha256[:8]}-"
            f"{methodology_fingerprint[:8]}"
        ),
        "createdAt": datetime.now(tz=UTC).isoformat(),
        "input": {
            "path": str(args.input_observations),
            "sha256": input_sha256,
            "observationCount": len(rows),
            "sessionCount": len({item.session_date for item in rows}),
        },
        "methodology": methodology,
        "evaluation": evaluation,
    }
    write_outputs(args.output_dir, payload)
    print_headline(payload, args.output_dir)


def load_fragility_v2_rows(path: Path) -> list[FragilityV2Row]:
    """Load and causally enrich canonical fragility observation rows."""

    rows: list[FragilityV2Row] = []
    previous_session: str | None = None
    previous_count = 0
    failure_streak = 0
    with path.open(newline="", encoding="utf-8") as source:
        reader = csv.DictReader(source)
        required = {
            "timestamp",
            "session_date",
            "session_time",
            "level",
            "stressed_indicator_count",
            "session_loss_state",
            "session_loss_value",
            "vwap_repair_failure_state",
            "vwap_repair_failure_value",
            "poor_close_location_state",
            "poor_close_location_value",
            "downside_tail_cluster_state",
            "downside_tail_cluster_value",
            "120m_drawdown_event",
            "5sessions_drawdown_event",
        }
        missing = required - set(reader.fieldnames or [])
        if missing:
            raise ValueError(
                "observation CSV is missing columns: " + ", ".join(sorted(missing))
            )
        for row_id, source_row in enumerate(reader):
            session_date = source_row["session_date"]
            stressed_count = int(source_row["stressed_indicator_count"])
            if session_date != previous_session:
                previous_count = 0
                failure_streak = 0
            failure_streak = failure_streak + 1 if stressed_count >= 3 else 0
            indicator_values = (
                float(source_row["session_loss_value"]),
                float(source_row["vwap_repair_failure_value"]),
                float(source_row["poor_close_location_value"]),
                float(source_row["downside_tail_cluster_value"]),
            )
            level = source_row["level"]
            if level not in {"resilient", "fragile", "breaking", "panic"}:
                raise ValueError(f"unsupported fragility level: {level}")
            rows.append(
                FragilityV2Row(
                    row_id=row_id,
                    timestamp=int(source_row["timestamp"]),
                    session_date=session_date,
                    session_time=source_row["session_time"],
                    level=cast(CandidateLevel, level),
                    stressed_indicator_count=stressed_count,
                    indicator_flags=tuple(
                        1.0 if source_row[f"{indicator_id}_state"] == "stressed" else 0.0
                        for indicator_id in (
                            "session_loss",
                            "vwap_repair_failure",
                            "poor_close_location",
                            "downside_tail_cluster",
                        )
                    ),
                    severity_margins=normalized_severity_margins(
                        *indicator_values
                    ),
                    prior_stressed_indicator_count=previous_count,
                    failure_streak=failure_streak,
                    outcomes={
                        "120m": _parse_optional_bool(
                            source_row["120m_drawdown_event"]
                        ),
                        "5sessions": _parse_optional_bool(
                            source_row["5sessions_drawdown_event"]
                        ),
                    },
                )
            )
            previous_session = session_date
            previous_count = stressed_count
    if not rows:
        raise ValueError("observation CSV contains no rows")
    return rows


def render_fragility_v2_report(payload: dict[str, object]) -> str:
    """Render the probability, phase, state, and promotion report."""

    evaluation = payload["evaluation"]
    input_metadata = payload["input"]
    assert isinstance(evaluation, dict)
    assert isinstance(input_metadata, dict)
    combined = evaluation["combinedOutOfSample"]
    state_evaluation = evaluation["candidateStateEvaluation"]
    promotion_gate = evaluation["promotionGate"]
    assert isinstance(combined, dict)
    assert isinstance(state_evaluation, dict)
    assert isinstance(promotion_gate, dict)
    lines = [
        "# SP500 Fragility v2 Shadow Evaluation",
        "",
        f"Run `{payload['runId']}` · schema {payload['schemaVersion']}",
        "",
        "## Scope",
        "",
        (
            "This is a train-only rolling-origin probability and state diagnostic. "
            "It does not change the frozen live classifier, alert mentions, colors, "
            "or reversal rules."
        ),
        "",
        f"- observations: {input_metadata['observationCount']}",
        f"- sessions: {input_metadata['sessionCount']}",
        f"- rolling folds: {evaluation['foldCount']}",
        f"- promotion decision: `{promotion_gate['decision']}`",
        "",
        "## Combined Out-of-Sample Probability Metrics",
        "",
        (
            "Brier loss is non-negative and lower is better. "
            "BSS = 1 - model Brier / base-rate Brier, so positive BSS is "
            "better; negative BSS means the model loses to the base-rate "
            "forecast. A candidate-minus-baseline Brier-loss difference uses "
            "the opposite sign: negative favors the candidate."
        ),
        "",
        (
            "| horizon | model | calibrated Brier loss (lower is better) | "
            "log loss | ROC AUC | PR AUC | ECE | "
            "BSS vs train base rate (positive is better) |"
        ),
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for horizon in ("120m", "5sessions"):
        horizon_summary = combined[horizon]
        assert isinstance(horizon_summary, dict)
        models = horizon_summary["models"]
        assert isinstance(models, dict)
        for model_name in (
            "count_only",
            "weighted_flags",
            "continuous_dynamic",
        ):
            model = models.get(model_name)
            if not isinstance(model, dict):
                continue
            metrics = model["calibratedMetrics"]
            assert isinstance(metrics, dict)
            lines.append(
                "| "
                f"{horizon} | {model_name} | {_format(metrics.get('brier'))} | "
                f"{_format(metrics.get('logLoss'))} | {_format(metrics.get('rocAuc'))} | "
                f"{_format(metrics.get('prAuc'))} | "
                f"{_format(metrics.get('expectedCalibrationError'))} | "
                f"{_format(model.get('brierSkillVsTrainingBaseRate'))} |"
            )
    lines.extend(
        [
            "",
            "## Candidate State and Phase",
            "",
            (
                "The candidate uses train-only risk cutpoints. BREAKING also "
                "requires causal WORSENING evidence from risk CUSUM or a two-brief "
                "repair-failure streak."
            ),
            "",
            "| state | observations | sessions | 120m drawdown rate | 5-session drawdown rate |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    by_level = state_evaluation.get("byLevel", {})
    assert isinstance(by_level, dict)
    for level in ("resilient", "fragile", "breaking", "panic"):
        summary = by_level.get(level)
        if not isinstance(summary, dict):
            continue
        lines.append(
            f"| {level.upper()} | {summary['observations']} | "
            f"{summary['sessions']} | {_format_percent(summary.get('120mDrawdownRate'))} | "
            f"{_format_percent(summary.get('5sessionDrawdownRate'))} |"
        )
    lines.extend(
        [
            "",
            "| phase | observations | sessions | 120m drawdown rate | 5-session drawdown rate |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    by_phase = state_evaluation.get("byPhase", {})
    assert isinstance(by_phase, dict)
    for phase in ("IMPROVING", "STABLE", "WORSENING"):
        summary = by_phase.get(phase)
        if not isinstance(summary, dict):
            continue
        lines.append(
            f"| {phase} | {summary['observations']} | {summary['sessions']} | "
            f"{_format_percent(summary.get('120mDrawdownRate'))} | "
            f"{_format_percent(summary.get('5sessionDrawdownRate'))} |"
        )
    breaking_difference = state_evaluation.get("breakingVsFragile120m")
    worsening_difference = state_evaluation.get(
        "highRiskWorseningVsNonWorsening120m"
    )
    unconditional_phase_difference = state_evaluation.get(
        "unconditionalWorseningVsStable120m"
    )
    if isinstance(breaking_difference, dict) and isinstance(
        worsening_difference,
        dict,
    ):
        lines.extend(
            [
                "",
                (
                    "- BREAKING minus FRAGILE 120m rate: "
                    f"{_format_percent(breaking_difference.get('estimate'))} "
                    "(95% block interval "
                    f"{_format_percent(breaking_difference.get('lower95'))} to "
                    f"{_format_percent(breaking_difference.get('upper95'))})"
                ),
                (
                    "- high-risk WORSENING minus high-risk non-WORSENING "
                    "120m rate: "
                    f"{_format_percent(worsening_difference.get('estimate'))} "
                    "(95% block interval "
                    f"{_format_percent(worsening_difference.get('lower95'))} to "
                    f"{_format_percent(worsening_difference.get('upper95'))})"
                ),
            ]
        )
    if isinstance(unconditional_phase_difference, dict):
        lines.append(
            "- unconditional WORSENING minus STABLE 120m rate: "
            f"{_format_percent(unconditional_phase_difference.get('estimate'))} "
            "(descriptive only)"
        )
    confirmation = state_evaluation.get("breakingConfirmation")
    if isinstance(confirmation, dict):
        lines.extend(
            [
                "",
                "### PENDING → CONFIRMED BREAKING",
                "",
                (
                    "The first existing v1 BREAKING or PANIC brief is PENDING. "
                    "It becomes CONFIRMED only when the next due brief also "
                    "remains v1 BREAKING or PANIC."
                ),
                "",
                f"- pending sessions: {confirmation.get('pendingSessions')}",
                (
                    "- evaluable pending sessions: "
                    f"{confirmation.get('evaluablePendingSessions')}"
                ),
                (
                    "- confirmed / transient sessions: "
                    f"{confirmation.get('confirmedSessions')} / "
                    f"{confirmation.get('transientSessions')}"
                ),
                (
                    "- confirmation rate: "
                    f"{_format_percent(confirmation.get('confirmationRate'))}"
                ),
                (
                    "- confirmed / transient 120m event rate: "
                    f"{_format_percent(confirmation.get('confirmed120mEventRate'))} / "
                    f"{_format_percent(confirmation.get('transient120mEventRate'))}"
                ),
                (
                    "- confirmed minus transient: "
                    f"{_format_percent(confirmation.get('eventRateDifference'))} "
                    "(95% block interval "
                    f"{_format_percent(confirmation.get('lower95'))} to "
                    f"{_format_percent(confirmation.get('upper95'))})"
                ),
                (
                    "- median confirmation delay: "
                    f"{_format(confirmation.get('medianConfirmationDelayMinutes'))} minutes"
                ),
            ]
        )
    persistence = state_evaluation.get("movingBlockPersistence")
    if isinstance(persistence, dict):
        lines.extend(
            [
                "",
                "### Legacy phase-conditioned persistence test",
                "",
                (
                    "A BREAKING observation is sustained when the next brief's "
                    "calibrated risk remains above its train-only BREAKING "
                    "cutpoint, regardless of whether risk is still accelerating."
                ),
                "",
                (
                    "- sustained sessions: "
                    f"{persistence.get('sustainedSessions')}"
                ),
                (
                    "- transient sessions: "
                    f"{persistence.get('transientSessions')}"
                ),
                (
                    "- 120m event-rate difference: "
                    f"{_format_percent(persistence.get('estimate'))} "
                    "(95% block interval "
                    f"{_format_percent(persistence.get('lower95'))} to "
                    f"{_format_percent(persistence.get('upper95'))})"
                ),
            ]
        )
    lines.extend(["", "## Promotion Gate", ""])
    checks = promotion_gate.get("checks", [])
    assert isinstance(checks, list)
    for check in checks:
        assert isinstance(check, dict)
        lines.append(
            f"- {'PASS' if check['passed'] else 'FAIL'} · {check['name']}: "
            f"`{json.dumps(check['evidence'], sort_keys=True)}`"
        )
    limitations = evaluation.get("limitations", [])
    if isinstance(limitations, list):
        lines.extend(["", "## Limitations", ""])
        lines.extend(f"- {item}" for item in limitations)
    return "\n".join(lines) + "\n"


def write_outputs(output_dir: Path, payload: dict[str, object]) -> None:
    """Write the stable JSON and Markdown v2 artifacts."""

    reports_dir = output_dir / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "fragility_v2_evaluation.json").write_text(
        json.dumps(payload, indent=2) + "\n",
        encoding="utf-8",
    )
    (reports_dir / "fragility_v2_report.md").write_text(
        render_fragility_v2_report(payload),
        encoding="utf-8",
    )
def print_headline(payload: dict[str, object], output_dir: Path) -> None:
    """Print the compact v2 decision and artifact path."""

    evaluation = payload["evaluation"]
    assert isinstance(evaluation, dict)
    promotion_gate = evaluation["promotionGate"]
    assert isinstance(promotion_gate, dict)
    print(
        f"Fragility v2 folds={evaluation['foldCount']} "
        f"decision={promotion_gate['decision']} output={output_dir}"
    )


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse reproducible fragility-v2 evaluation arguments."""

    parser = argparse.ArgumentParser(
        description="Evaluate the fragility-v2 shadow candidate"
    )
    parser.add_argument("--input-observations", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--context-months", type=int, default=24)
    parser.add_argument("--test-months", type=int, default=6)
    parser.add_argument("--bootstrap-runs", type=int, default=1_000)
    parser.add_argument("--bootstrap-seed", type=int, default=42)
    parser.add_argument("--bootstrap-block-sessions", type=int, default=5)
    return parser.parse_args(argv)


def file_sha256(path: Path) -> str:
    """Return the SHA-256 digest of one input artifact."""

    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _methodology_metadata(
    evaluation: dict[str, object],
) -> dict[str, object]:
    snapshot = {
        key: evaluation[key]
        for key in (
            "researchVersion",
            "settings",
            "featureContracts",
            "outcomeContracts",
            "stateContract",
        )
    }
    encoded = json.dumps(
        snapshot,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return {
        "fingerprint": hashlib.sha256(encoded).hexdigest(),
        "snapshot": snapshot,
    }


def _parse_optional_bool(value: str) -> bool | None:
    normalized = value.strip().lower()
    if normalized == "true":
        return True
    if normalized == "false":
        return False
    if normalized == "":
        return None
    raise ValueError(f"invalid boolean value: {value}")


def _format(value: object) -> str:
    return "n/a" if not isinstance(value, (float, int)) else f"{value:.6f}"


def _format_percent(value: object) -> str:
    return "n/a" if not isinstance(value, (float, int)) else f"{value:.2%}"


if __name__ == "__main__":
    main()
