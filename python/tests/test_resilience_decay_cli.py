"""CLI artifact regression tests for resilience decay."""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from reversal_scanner_backtest.models import Candle
from reversal_scanner_backtest.resilience_decay_cli import main


def test_cli_writes_reproducible_audit_artifacts(tmp_path: Path) -> None:
    source = tmp_path / "candles.json"
    output_dir = tmp_path / "output"
    candles = session_candles("2025-01-06") + session_candles("2025-01-07")
    source.write_text(
        json.dumps([candle.to_dict() for candle in candles]),
        encoding="utf-8",
    )

    main(
        [
            "--input",
            str(source),
            "--output-dir",
            str(output_dir),
            "--bootstrap-runs",
            "0",
            "--skip-sensitivity",
        ]
    )

    payload = json.loads(
        (output_dir / "resilience_decay_backtest.json").read_text(
            encoding="utf-8"
        )
    )
    assert payload["schemaVersion"] == 1
    assert payload["methodology"]["replay"]["troughPolicy"] == (
        "checkpoint-visible and frozen after recovery"
    )
    assert payload["summary"]["sessionCount"] == 2
    assert (output_dir / "events" / "resilience_shocks.csv").exists()
    assert (
        output_dir / "events" / "resilience_session_observations.csv"
    ).exists()
    assert (
        output_dir / "reports" / "resilience_decay_summary.md"
    ).exists()
    assert (output_dir / "reports" / "sensitivity.csv").exists()
    assert (
        output_dir / "methodology" / "methodology_snapshot.json"
    ).exists()


def session_candles(session_date: str) -> list[Candle]:
    """Build a complete five-minute RTH session with one early shock."""

    boundary_closes = [100, 99, 99, 96, 97, 98, 99.5, 100, 100, 100, 100, 100, 100]
    closes = [close for close in boundary_closes for _repeat in range(6)]
    start = datetime.fromisoformat(f"{session_date}T09:30:00").replace(
        tzinfo=ZoneInfo("America/New_York")
    )
    candles: list[Candle] = []
    for index, close in enumerate(closes):
        previous = close if index == 0 else closes[index - 1]
        start_time = int((start + timedelta(minutes=index * 5)).timestamp() * 1000)
        candles.append(
            Candle(
                start_time=start_time,
                end_time=start_time + 299_999,
                open=previous,
                high=max(previous, close),
                low=min(previous, close),
                close=close,
                volume=100,
                trade_count=10,
            )
        )
    return candles
