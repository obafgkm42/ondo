"""Canonical market-bars/v2 reader regression tests."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from reversal_scanner_backtest.cli import load_candles
from reversal_scanner_backtest.fragility_cli import (
    iter_candles_streaming,
    load_candles_streaming,
)
from reversal_scanner_backtest.validation import validate_candles


def test_json_and_ndjson_produce_identical_scanner_candles(tmp_path: Path) -> None:
    """Both canonical storage encodings preserve the domain candle exactly."""

    dataset = canonical_dataset()
    json_path = tmp_path / "bars.json"
    ndjson_path = tmp_path / "bars.ndjson"
    json_path.write_text(json.dumps(dataset), encoding="utf-8")
    metadata = {key: value for key, value in dataset.items() if key != "bars"}
    records = [
        {"recordType": "market-bars/v2-manifest", "dataset": metadata},
        *[
            {"recordType": "market-bars/v2-bar", "bar": bar}
            for bar in dataset["bars"]
        ],
    ]
    ndjson_path.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records),
        encoding="utf-8",
    )

    json_candles = load_candles(json_path)
    ndjson_candles = load_candles_streaming(ndjson_path)

    assert json_candles == ndjson_candles
    assert json_candles[0].start_time == 1_786_714_200_000
    assert json_candles[0].end_time == 1_786_714_499_999
    assert json_candles[0].volume == 42
    assert json_candles[0].trade_count == 7


def test_reader_rejects_missing_required_scanner_fields(tmp_path: Path) -> None:
    """Research never invents volume or trade count absent from canonical data."""

    dataset = canonical_dataset()
    dataset["bars"][0]["volume"] = None
    path = tmp_path / "bars.json"
    path.write_text(json.dumps(dataset), encoding="utf-8")

    with pytest.raises(ValueError, match="require measured volume"):
        load_candles(path)


def test_research_validation_owns_interval_checks(tmp_path: Path) -> None:
    """The existing research validator checks candle cadence after adaptation."""

    dataset = canonical_dataset()
    dataset["bars"][0]["endTimeExclusiveMs"] += 1
    path = tmp_path / "bars.json"
    path.write_text(json.dumps(dataset), encoding="utf-8")

    report = validate_candles(load_candles(path), 5, "UTC")

    assert report.invalid_duration_rows == 1
    assert not report.is_valid


def test_reader_rejects_unsupported_canonical_envelope(
    tmp_path: Path,
) -> None:
    """The adapter accepts only v2 UTC bars with exclusive end timestamps."""

    dataset = canonical_dataset()
    dataset["schemaVersion"] = "market-bars/v1"
    path = tmp_path / "bars.json"
    path.write_text(json.dumps(dataset), encoding="utf-8")
    with pytest.raises(ValueError, match="market-bars/v2 contract"):
        load_candles(path)

    dataset = canonical_dataset()
    dataset["barSpec"]["timestampTimeZone"] = "America/New_York"
    path.write_text(json.dumps(dataset), encoding="utf-8")
    with pytest.raises(ValueError, match="timestamp semantics"):
        load_candles(path)


def test_ndjson_detection_reads_the_complete_manifest_line(tmp_path: Path) -> None:
    """A large valid manifest is not misclassified as ordinary JSON."""

    dataset = canonical_dataset()
    dataset["producer"]["name"] = f"fixture-{'x' * (70 * 1024)}"
    metadata = {key: value for key, value in dataset.items() if key != "bars"}
    records = [
        {"recordType": "market-bars/v2-manifest", "dataset": metadata},
        {"recordType": "market-bars/v2-bar", "bar": dataset["bars"][0]},
    ]
    path = tmp_path / "large-manifest.ndjson"
    path.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records),
        encoding="utf-8",
    )

    assert load_candles_streaming(path)[0].trade_count == 7


def test_ndjson_stream_does_not_parse_future_rows_eagerly(tmp_path: Path) -> None:
    """A valid first row is yielded before a later malformed record is read."""

    dataset = canonical_dataset()
    metadata = {key: value for key, value in dataset.items() if key != "bars"}
    records = [
        {"recordType": "market-bars/v2-manifest", "dataset": metadata},
        {"recordType": "market-bars/v2-bar", "bar": dataset["bars"][0]},
        {"recordType": "unexpected"},
    ]
    path = tmp_path / "lazy.ndjson"
    path.write_text(
        "".join(f"{json.dumps(record)}\n" for record in records),
        encoding="utf-8",
    )

    candles = iter_candles_streaming(path)

    assert next(candles).trade_count == 7
    with pytest.raises(ValueError, match="line 3 is not a bar"):
        next(candles)


def canonical_dataset() -> dict[str, object]:
    """Return one minimal synthetic canonical dataset."""

    start_time = 1_786_714_200_000
    return {
        "schemaVersion": "market-bars/v2",
        "producer": {"name": "fixture", "version": "1"},
        "instrument": {"id": "fixture:index", "assetClass": "index"},
        "barSpec": {
            "intervalMs": 300_000,
            "timestampMeaning": "bar-start",
            "timestampTimeZone": "UTC",
            "endTimeSemantics": "exclusive",
        },
        "normalization": {
            "invalidRowPolicy": "reject-batch",
            "duplicatePolicy": "reject",
            "volumePolicy": "required-nonnegative",
        },
        "provenance": {
            "priceBasis": "trade",
            "adjustment": "raw",
            "volumeSemantics": "measured",
            "sources": {
                "fixture": {
                    "provider": "fixture",
                    "providerSymbol": "SYNTH",
                    "instrumentId": "fixture:index",
                    "fetchedAt": "2026-08-21T00:00:00Z",
                    "sourceTimeZone": "UTC",
                },
            },
        },
        "quality": {
            "inputRows": 1,
            "sourceRows": {"fixture": 1},
            "acceptedRows": 1,
            "invalidRows": 0,
            "duplicateRows": 0,
            "invalidVolumeRows": 0,
            "missingVolumeRows": 0,
            "zeroVolumeRows": 0,
            "gapCount": 0,
            "missingIntervals": 0,
            "firstStartTimeMs": start_time,
            "lastStartTimeMs": start_time,
        },
        "bars": [{
            "startTimeMs": start_time,
            "endTimeExclusiveMs": start_time + 300_000,
            "open": 100,
            "high": 102,
            "low": 99,
            "close": 101,
            "volume": 42,
            "tradeCount": 7,
            "wap": None,
            "priceSource": "fixture",
            "volumeSource": "fixture",
            "flags": [],
        }],
    }
