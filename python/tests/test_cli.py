"""End-to-end smoke tests for the Python research command contracts."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from reversal_scanner_backtest.cli import (
    main as run_reversal_backtest,
    parse_args as parse_reversal_args,
)
from reversal_scanner_backtest.fragility_cli import (
    main as run_fragility_backtest,
    parse_args as parse_fragility_args,
)

from factories import session_candles


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_reversal_cli_help_renders(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as result:
        parse_reversal_args(["--help"])

    assert result.value.code == 0
    output = capsys.readouterr().out
    assert "Session-cluster bootstrap runs" in output
    assert "95%" in output


def test_fragility_cli_help_renders(capsys: pytest.CaptureFixture[str]) -> None:
    with pytest.raises(SystemExit) as result:
        parse_fragility_args(["--help"])

    assert result.value.code == 0
    assert "market-fragility event study" in capsys.readouterr().out


def test_reversal_cli_writes_smoke_artifacts(tmp_path: Path) -> None:
    output = tmp_path / "reversal_backtest.json"

    run_reversal_backtest(
        [
            "--input",
            str(PROJECT_ROOT / "tests/fixtures/synthetic-candles.json"),
            "--output",
            str(output),
            "--output-dir",
            str(tmp_path),
            "--replay-mode",
            "every-bar",
            "--source-timezone",
            "UTC",
            "--placebo-runs",
            "0",
            "--bootstrap-runs",
            "0",
        ]
    )

    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["schemaVersion"] == 3
    assert payload["candleCount"] == 12
    assert (tmp_path / "events/reversal_event_study.csv").is_file()
    assert (tmp_path / "reports/reversal_summary.md").is_file()


def test_fragility_cli_writes_smoke_artifacts(tmp_path: Path) -> None:
    source = tmp_path / "candles.json"
    source.write_text(
        json.dumps([item.to_dict() for item in session_candles([100] * 12)]),
        encoding="utf-8",
    )
    output_dir = tmp_path / "fragility"

    run_fragility_backtest(
        [
            "--input",
            str(source),
            "--output-dir",
            str(output_dir),
            "--bootstrap-runs",
            "0",
        ]
    )

    payload = json.loads(
        (output_dir / "fragility_backtest.json").read_text(encoding="utf-8")
    )
    assert payload["schemaVersion"] == 1
    assert payload["candleCount"] == 12
    assert (output_dir / "events/fragility_observations.csv").is_file()
    assert (output_dir / "reports/fragility_summary.md").is_file()
