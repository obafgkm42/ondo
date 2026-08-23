"""Regression tests for the train-only fragility-v2 evaluation."""

from __future__ import annotations

import csv
from datetime import UTC, datetime, timedelta
from pathlib import Path

from reversal_scanner_backtest.fragility_v2 import (
    FragilityV2Row,
    FragilityV2Settings,
    build_fragility_v2_evaluation,
    normalized_severity_margins,
)
from reversal_scanner_backtest.fragility_v2_cli import (
    load_fragility_v2_rows,
    render_fragility_v2_report,
)


def test_severity_margins_are_zero_at_frozen_thresholds() -> None:
    margins = normalized_severity_margins(-0.01, -0.35, 0.25, 2)

    assert margins == (0.0, 0.0, 0.0, 0.0)


def test_csv_loader_builds_only_causal_prior_count_and_streak(
    tmp_path: Path,
) -> None:
    source = tmp_path / "observations.csv"
    fieldnames = [
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
    ]
    with source.open("w", newline="", encoding="utf-8") as output:
        writer = csv.DictWriter(output, fieldnames=fieldnames)
        writer.writeheader()
        for index, count in enumerate((2, 3, 3)):
            writer.writerow(
                {
                    "timestamp": index + 1,
                    "session_date": "2025-01-06",
                    "session_time": f"{10 + index}:00",
                    "level": "fragile" if count == 2 else "breaking",
                    "stressed_indicator_count": count,
                    "session_loss_state": "stressed",
                    "session_loss_value": -0.02,
                    "vwap_repair_failure_state": "stressed",
                    "vwap_repair_failure_value": -0.7,
                    "poor_close_location_state": "stressed" if count >= 3 else "healthy",
                    "poor_close_location_value": 0.1,
                    "downside_tail_cluster_state": "healthy",
                    "downside_tail_cluster_value": 1,
                    "120m_drawdown_event": "False",
                    "5sessions_drawdown_event": "True",
                }
            )

    rows = load_fragility_v2_rows(source)

    assert [item.prior_stressed_indicator_count for item in rows] == [0, 2, 3]
    assert [item.failure_streak for item in rows] == [0, 1, 2]


def test_rolling_evaluation_emits_metrics_and_shadow_only_gate() -> None:
    rows = synthetic_rows()
    settings = FragilityV2Settings(
        context_months=12,
        test_months=3,
        bootstrap_runs=20,
        bootstrap_seed=7,
        bootstrap_block_sessions=2,
    )

    evaluation = build_fragility_v2_evaluation(rows, settings)

    assert evaluation["foldCount"] > 0
    combined = evaluation["combinedOutOfSample"]
    assert isinstance(combined, dict)
    intraday = combined["120m"]
    assert isinstance(intraday, dict)
    models = intraday["models"]
    assert isinstance(models, dict)
    assert set(models) == {
        "count_only",
        "weighted_flags",
        "continuous_dynamic",
    }
    candidate = models["continuous_dynamic"]
    assert isinstance(candidate, dict)
    calibrated = candidate["calibratedMetrics"]
    assert isinstance(calibrated, dict)
    assert isinstance(calibrated["brier"], float)
    gate = evaluation["promotionGate"]
    assert isinstance(gate, dict)
    assert gate["decision"] == "SHADOW_ONLY"
    checks = gate["checks"]
    assert isinstance(checks, list)
    check_names = {str(item["name"]) for item in checks}
    assert "120m_positive_brier_skill_vs_train_base_rate" in check_names
    assert "confirmed_breaking_has_higher_120m_risk" in check_names
    state_evaluation = evaluation["candidateStateEvaluation"]
    assert isinstance(state_evaluation, dict)
    confirmation = state_evaluation["breakingConfirmation"]
    assert isinstance(confirmation, dict)
    assert confirmation["outcomeAnchor"] == "next_due_brief"

    report = render_fragility_v2_report(
        {
            "runId": "synthetic",
            "schemaVersion": 1,
            "input": {
                "observationCount": len(rows),
                "sessionCount": len({item.session_date for item in rows}),
            },
            "evaluation": evaluation,
        }
    )
    assert "Brier loss is non-negative and lower is better" in report
    assert "negative BSS means the model loses" in report
    assert "BSS vs train base rate (positive is better)" in report
    assert "5-session drawdown rate" in report
    assert "PENDING → CONFIRMED BREAKING" in report

def synthetic_rows() -> list[FragilityV2Row]:
    """Create four years with repeated within-session causal observations."""

    rows: list[FragilityV2Row] = []
    timestamp = datetime(2020, 1, 2, 15, tzinfo=UTC)
    row_id = 0
    for session_index in range(4 * 12 * 5):
        session_date = timestamp.date().isoformat()
        stress_seed = session_index % 10
        previous_count = 0
        streak = 0
        for brief_index in range(2):
            severity = (stress_seed + brief_index) / 9
            count = min(4, int(severity * 5))
            streak = streak + 1 if count >= 3 else 0
            event_120m = stress_seed in {7, 8, 9}
            event_5sessions = stress_seed in {6, 7, 8, 9}
            rows.append(
                FragilityV2Row(
                    row_id=row_id,
                    timestamp=int(
                        (
                            timestamp
                            + timedelta(minutes=30 * brief_index)
                        ).timestamp()
                        * 1000
                    ),
                    session_date=session_date,
                    session_time="10:00" if brief_index == 0 else "10:30",
                    level=(
                        "panic"
                        if count >= 4
                        else "breaking"
                        if count == 3
                        else "fragile"
                        if count == 2
                        else "resilient"
                    ),
                    stressed_indicator_count=count,
                    indicator_flags=tuple(
                        1.0 if indicator_index < count else 0.0
                        for indicator_index in range(4)
                    ),
                    severity_margins=(severity, severity * 0.8, severity * 0.6, severity * 0.4),
                    prior_stressed_indicator_count=previous_count,
                    failure_streak=streak,
                    outcomes={
                        "120m": event_120m,
                        "5sessions": event_5sessions,
                    },
                )
            )
            row_id += 1
            previous_count = count
        timestamp += timedelta(days=3)
    return rows
