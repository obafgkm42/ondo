"""Tests for the offline fragility shadow snapshot report."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from reversal_scanner_backtest.fragility_shadow_report import (
    parse_fragility_shadow_state,
    render_fragility_shadow_markdown,
    summarize_fragility_shadow,
)
from reversal_scanner_backtest.fragility_shadow_report_cli import (
    main,
    parse_args,
)


def test_v3_summary_separates_observations_from_session_prevalence() -> None:
    state = parse_fragility_shadow_state(
        _state(
            [
                {
                    "sessionKey": "2026-08-20",
                    "observations": [
                        _observation(
                            1_755_700_200_000,
                            level="breaking",
                            status="PENDING",
                            transition="NEW_BREAK",
                            stressed_ids=[
                                "session_loss",
                                "vwap_repair_failure",
                            ],
                            family_ids=["price_damage", "repair_failure"],
                        ),
                        _observation(
                            1_755_702_000_000,
                            level="panic",
                            status="CONFIRMED",
                            transition="ESCALATING",
                            duration=30,
                            streak=2,
                            stressed_ids=[
                                "session_loss",
                                "vwap_repair_failure",
                                "mega_cap_breadth",
                            ],
                            family_ids=[
                                "price_damage",
                                "repair_failure",
                                "breadth",
                            ],
                        ),
                    ],
                },
                {
                    "sessionKey": "2026-08-21",
                    "observations": [
                        _observation(
                            1_755_786_600_000,
                            level="fragile",
                            status="BELOW_THRESHOLD",
                            transition="RECOVERED",
                            stressed_ids=[],
                            family_ids=[],
                        )
                    ],
                },
                {
                    "sessionKey": "2026-08-22",
                    "observations": [
                        _observation(
                            1_755_873_000_000,
                            level="breaking",
                            status="PENDING",
                            transition="RELAPSE",
                            stressed_ids=[
                                "downside_tail_cluster",
                                "equity_cross_confirmation",
                            ],
                            family_ids=[
                                "price_damage",
                                "cross_market_confirmation",
                            ],
                        )
                    ],
                },
            ]
        )
    )

    summary = summarize_fragility_shadow(state)

    assert summary["window"] == {
        "retainedSessions": 3,
        "retainedObservations": 4,
        "firstTimestamp": 1_755_700_200_000,
        "firstTimestampUtc": "2025-08-20T14:30:00+00:00",
        "lastTimestamp": 1_755_873_000_000,
        "lastTimestampUtc": "2025-08-22T14:30:00+00:00",
    }
    assert summary["breaking"] == {
        "observations": 3,
        "sessions": 2,
        "pendingCandidateSessions": 2,
        "confirmedSessions": 1,
        "confirmationRate": 0.5,
        "statusObservations": {
            "BELOW_THRESHOLD": 1,
            "PENDING": 2,
            "CONFIRMED": 1,
        },
    }
    indicators = {
        row["id"]: row for row in summary["mechanisms"]["indicators"]
    }
    assert indicators["session_loss"] == {
        "id": "session_loss",
        "breakingObservationOccurrences": 2,
        "breakingSessionCount": 1,
        "breakingSessionPrevalence": 0.5,
    }
    assert indicators["downside_tail_cluster"]["breakingSessionCount"] == 1
    assert summary["mechanisms"]["familyBreadthByBreakingObservation"] == {
        "0": 0,
        "1": 0,
        "2": 2,
        "3": 1,
        "4": 0,
    }
    assert summary["sessionMaxBreakingDurationMinutes"] == {
        "count": 2,
        "min": 0,
        "mean": 15.0,
        "median": 15.0,
        "p90": 30,
        "max": 30,
        "percentileMethod": "nearest-rank",
    }
    assert summary["dataQuality"]["readyForDescriptiveReview"] is False


def test_v2_state_is_normalized_without_inventing_mechanisms() -> None:
    raw = _state(
        [
            {
                "sessionKey": "2026-08-20",
                "observations": [
                    {
                        "timestamp": 1_755_700_200_000,
                        "price": 6500,
                        "v1Level": "breaking",
                        "stressedIndicatorCount": 3,
                        "availableIndicatorCount": 6,
                        "breakingStreak": 1,
                        "breakingStatus": "PENDING",
                    }
                ],
            }
        ],
        version=2,
    )

    state = parse_fragility_shadow_state(raw)
    observation = state.sessions[0].observations[0]
    summary = summarize_fragility_shadow(state)

    assert state.source_version == 2
    assert observation.breaking_started_at == observation.timestamp
    assert observation.transition == "UNAVAILABLE"
    assert observation.stressed_indicator_ids == ()
    assert observation.mechanism_history_available is False
    assert summary["sessionMaxBreakingDurationMinutes"]["count"] == 0
    assert summary["dataQuality"] == {
        "mechanismHistoryAvailableObservations": 0,
        "mechanismHistoryUnavailableObservations": 1,
        "minimumTargetSessions": 30,
        "readyForDescriptiveReview": False,
        "legacyStateMigrated": True,
    }


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (
            lambda raw: raw.update(version=4),
            "state.version must be 2 or 3",
        ),
        (
            lambda raw: raw["sessions"].append(raw["sessions"][0]),
            "duplicate sessionKey",
        ),
        (
            lambda raw: raw["sessions"][0].update(
                observations=raw["sessions"][0]["observations"] * 17
            ),
            "16-observation contract",
        ),
    ],
)
def test_parser_rejects_malformed_or_unbounded_state(
    mutation: object,
    message: str,
) -> None:
    raw = _state(
        [
            {
                "sessionKey": "2026-08-20",
                "observations": [_observation(1_755_700_200_000)],
            }
        ]
    )
    mutation(raw)  # type: ignore[operator]

    with pytest.raises(ValueError, match=message):
        parse_fragility_shadow_state(raw)


def test_cli_writes_json_and_markdown_artifacts(tmp_path: Path) -> None:
    input_path = tmp_path / "state.json"
    output_dir = tmp_path / "report"
    input_path.write_text(
        json.dumps(
            _state(
                [
                    {
                        "sessionKey": "2026-08-20",
                        "observations": [
                            _observation(1_755_700_200_000)
                        ],
                    }
                ]
            )
        ),
        encoding="utf-8",
    )

    main(
        [
            "--input-state",
            str(input_path),
            "--output-dir",
            str(output_dir),
        ]
    )

    payload = json.loads(
        (output_dir / "fragility_shadow_report.json").read_text(
            encoding="utf-8"
        )
    )
    markdown = (output_dir / "fragility_shadow_report.md").read_text(
        encoding="utf-8"
    )
    assert payload["schemaVersion"] == 1
    assert payload["runId"].startswith("fragility-shadow-")
    assert payload["summary"]["market"] == "xyz:SP500"
    assert "Descriptive shadow telemetry only" in markdown
    assert "Worker logs are required" in markdown


def test_cli_help_describes_offline_input(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as result:
        parse_args(["--help"])

    assert result.value.code == 0
    output = capsys.readouterr().out
    assert "without network access" in output
    assert "wrangler kv key" in output
    assert "get --text" in output


def test_markdown_handles_no_breaking_observations() -> None:
    state = parse_fragility_shadow_state(
        _state(
            [
                {
                    "sessionKey": "2026-08-20",
                    "observations": [
                        _observation(
                            1_755_700_200_000,
                            level="resilient",
                            stressed_ids=[],
                            family_ids=[],
                        )
                    ],
                }
            ]
        )
    )
    payload = {
        "schemaVersion": 1,
        "runId": "fragility-shadow-test",
        "summary": summarize_fragility_shadow(state),
    }

    markdown = render_fragility_shadow_markdown(payload)

    assert "retained-window confirmation rate: n/a" in markdown
    assert "evaluable sessions: 0" in markdown


def _state(sessions: list[dict[str, object]], version: int = 3) -> dict[str, object]:
    return {
        "version": version,
        "market": "xyz:SP500",
        "sessions": sessions,
    }


def _observation(
    timestamp: int,
    *,
    level: str = "breaking",
    status: str = "PENDING",
    transition: str = "NEW_BREAK",
    duration: int = 0,
    streak: int = 1,
    stressed_ids: list[str] | None = None,
    family_ids: list[str] | None = None,
) -> dict[str, object]:
    resolved_ids = (
        ["session_loss", "vwap_repair_failure"]
        if stressed_ids is None
        else stressed_ids
    )
    resolved_families = (
        ["price_damage", "repair_failure"]
        if family_ids is None
        else family_ids
    )
    return {
        "timestamp": timestamp,
        "price": 6500,
        "v1Level": level,
        "stressedIndicatorCount": len(resolved_ids),
        "availableIndicatorCount": 6,
        "breakingStreak": streak if level in {"breaking", "panic"} else 0,
        "breakingStatus": (
            status if level in {"breaking", "panic"} else "BELOW_THRESHOLD"
        ),
        "breakingStartedAt": (
            timestamp if level in {"breaking", "panic"} else None
        ),
        "breakingDurationMinutes": duration,
        "transition": transition,
        "stressedIndicatorIds": resolved_ids,
        "persistentIndicatorIds": resolved_ids if duration else [],
        "addedIndicatorIds": resolved_ids if duration == 0 else [],
        "recoveredIndicatorIds": [],
        "stressedFamilyIds": resolved_families,
        "mechanismHistoryAvailable": True,
    }
