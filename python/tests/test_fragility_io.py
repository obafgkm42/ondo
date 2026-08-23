"""Fragility input, proxy-volume, and streaming regression tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import reversal_scanner_backtest.fragility_cli as fragility_cli
from reversal_scanner_backtest.fragility_cli import (
    apply_proxy_volume,
    build_streaming_replay,
    load_candles_streaming,
)
from reversal_scanner_backtest.fragility_study import (
    FragilityReplaySettings,
    build_fragility_observations,
)
from reversal_scanner_backtest.models import Candle

from factories import session_candles


def test_aligned_proxy_volume_preserves_primary_prices() -> None:
    primary = session_candles([100, 101])
    proxy = [
        Candle(
            start_time=item.start_time,
            end_time=item.end_time,
            open=10,
            high=11,
            low=9,
            close=10,
            volume=1_000 + index,
            trade_count=10,
        )
        for index, item in enumerate(primary)
    ]

    merged, coverage = apply_proxy_volume(primary, proxy)

    assert coverage == 1
    assert [item.close for item in merged] == [100, 101]
    assert [item.volume for item in merged] == [1000, 1001]


def test_streaming_loader_matches_repo_candle_shape(tmp_path: Path) -> None:
    source = tmp_path / "candles.json"
    expected = session_candles([100, 101])
    source.write_text(
        json.dumps([item.to_dict() for item in expected]),
        encoding="utf-8",
    )

    loaded = load_candles_streaming(source)

    assert loaded == expected


def test_streaming_loader_preserves_rows_across_small_chunks(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "candles.json"
    expected = session_candles([100 + index / 10 for index in range(20)])
    source.write_text(
        json.dumps(
            [item.to_dict() for item in expected],
            indent=2,
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(fragility_cli, "JSON_READ_CHUNK_SIZE", 97)
    monkeypatch.setattr(fragility_cli, "JSON_REFILL_THRESHOLD", 23)

    loaded = load_candles_streaming(source)

    assert loaded == expected


def test_streaming_replay_matches_in_memory_replay(tmp_path: Path) -> None:
    source = tmp_path / "candles.json"
    settings = FragilityReplaySettings(bootstrap_runs=0)
    candles = session_candles([100] * 12, "2025-01-06") + session_candles(
        [100, 100, 100, 100, 100, 100, 99.8, 99.4, 99, 99, 99, 99],
        "2025-01-07",
    )
    source.write_text(
        json.dumps([item.to_dict() for item in candles]),
        encoding="utf-8",
    )

    replay = build_streaming_replay(
        source,
        source_time_zone="UTC",
        source_timestamp_mode="utc-epoch",
        settings=settings,
    )

    assert replay.validation.is_valid
    assert replay.candle_count == len(candles)
    assert replay.first_timestamp == candles[0].start_time
    assert replay.last_timestamp == candles[-1].end_time
    assert replay.observations == build_fragility_observations(candles, settings)
