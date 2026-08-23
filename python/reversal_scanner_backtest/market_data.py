"""Adapt canonical market-bars/v2 artifacts to the research candle model."""

from __future__ import annotations

import json
import math
from collections.abc import Iterator
from pathlib import Path
from typing import Literal

from reversal_scanner_backtest.models import Candle

CanonicalFormat = Literal["json", "ndjson"]


def detect_canonical_format(path: Path) -> CanonicalFormat | None:
    """Return the canonical storage format, or ``None`` for a legacy array."""

    with path.open("r", encoding="utf-8") as source:
        first_line = next((line.strip() for line in source if line.strip()), "")
    if not first_line.startswith("{"):
        return None
    try:
        first_value = json.loads(first_line)
    except json.JSONDecodeError:
        first_value = None
    if (
        isinstance(first_value, dict)
        and first_value.get("recordType") == "market-bars/v2-manifest"
    ):
        return "ndjson"
    return "json"


def canonical_candle_stream(path: Path) -> Iterator[Candle] | None:
    """Return a lazy canonical candle stream, or ``None`` for legacy input."""

    format_name = detect_canonical_format(path)
    if format_name is None:
        return None
    return _iter_canonical_candles(path, format_name)


def _iter_canonical_candles(
    path: Path,
    format_name: CanonicalFormat,
) -> Iterator[Candle]:
    """Yield domain candles without duplicating the shared contract validator."""

    if format_name == "json":
        dataset = _json_object(path.read_text(encoding="utf-8"), "dataset")
        _require_canonical_metadata(dataset)
        bars = dataset.get("bars")
        if not isinstance(bars, list):
            raise ValueError("market-bars/v2 bars must be an array")
        yield from (_canonical_row_to_candle(row) for row in bars)
        return

    with path.open("r", encoding="utf-8") as source:
        first_line = source.readline()
        if not first_line:
            raise ValueError("market-bars/v2 NDJSON is empty")
        manifest = _json_object(first_line, "NDJSON manifest")
        if manifest.get("recordType") != "market-bars/v2-manifest":
            raise ValueError("market-bars/v2 NDJSON must start with a manifest")
        _require_canonical_metadata(manifest.get("dataset"))

        for line_number, line in enumerate(source, start=2):
            if not line.strip():
                raise ValueError(
                    f"market-bars/v2 NDJSON line {line_number} is empty"
                )
            record = _json_object(line, f"NDJSON line {line_number}")
            if record.get("recordType") != "market-bars/v2-bar":
                raise ValueError(
                    f"market-bars/v2 NDJSON line {line_number} is not a bar"
                )
            yield _canonical_row_to_candle(record.get("bar"))


def _require_canonical_metadata(value: object) -> None:
    """Verify only the version and timestamp assumptions used by this adapter."""

    if not isinstance(value, dict) or value.get("schemaVersion") != "market-bars/v2":
        raise ValueError("input must use the market-bars/v2 contract")
    bar_spec = value.get("barSpec")
    if (
        not isinstance(bar_spec, dict)
        or bar_spec.get("timestampMeaning") != "bar-start"
        or bar_spec.get("timestampTimeZone") != "UTC"
        or bar_spec.get("endTimeSemantics") != "exclusive"
    ):
        raise ValueError("market-bars/v2 timestamp semantics are unsupported")


def _canonical_row_to_candle(row: object) -> Candle:
    """Convert one canonical exclusive-end row to the domain candle shape."""

    if not isinstance(row, dict):
        raise ValueError("every market-bars/v2 bar must be an object")
    volume = row.get("volume")
    if volume is None:
        raise ValueError("scanner candles require measured volume")
    trade_count = row.get("tradeCount")
    if trade_count is None:
        raise ValueError("scanner candles require trade count")

    start_time = _positive_integer(row.get("startTimeMs"), "startTimeMs")
    end_exclusive = _positive_integer(
        row.get("endTimeExclusiveMs"),
        "endTimeExclusiveMs",
    )
    return Candle(
        start_time=start_time,
        end_time=end_exclusive - 1,
        open=_finite_number(row.get("open"), "open"),
        high=_finite_number(row.get("high"), "high"),
        low=_finite_number(row.get("low"), "low"),
        close=_finite_number(row.get("close"), "close"),
        volume=_nonnegative_number(volume, "volume"),
        trade_count=_nonnegative_integer(trade_count, "tradeCount"),
    )


def _json_object(value: str, label: str) -> dict[str, object]:
    """Parse one JSON object with a source-labelled error."""

    try:
        parsed = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError(f"{label} is invalid JSON") from error
    if not isinstance(parsed, dict):
        raise ValueError(f"{label} must be an object")
    return parsed


def _positive_integer(value: object, label: str) -> int:
    """Return one positive integer without accepting booleans."""

    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"market-bars/v2 {label} must be a positive integer")
    return value


def _nonnegative_integer(value: object, label: str) -> int:
    """Return one nonnegative integer without accepting booleans."""

    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"market-bars/v2 {label} must be nonnegative")
    return value


def _nonnegative_number(value: object, label: str) -> float:
    """Return one finite nonnegative number."""

    parsed = _finite_number(value, label)
    if parsed < 0:
        raise ValueError(f"market-bars/v2 {label} must be nonnegative")
    return parsed


def _finite_number(value: object, label: str) -> float:
    """Return a finite JSON number without accepting strings or booleans."""

    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"market-bars/v2 {label} must be numeric")
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError(f"market-bars/v2 {label} must be finite")
    return parsed
