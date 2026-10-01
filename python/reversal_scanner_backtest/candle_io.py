"""Shared candle loading and session normalization for offline studies."""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from reversal_scanner_backtest.market_data import canonical_candle_stream
from reversal_scanner_backtest.models import Candle

JSON_READ_CHUNK_SIZE = 1024 * 1024
JSON_REFILL_THRESHOLD = 64 * 1024


def load_candles(
    path: Path,
    source_time_zone: str = "UTC",
    source_timestamp_mode: str = "utc-epoch",
) -> list[Candle]:
    """Load candles and optionally repair naive local epochs."""

    canonical = canonical_candle_stream(path)
    if canonical is not None:
        if source_timestamp_mode != "utc-epoch":
            raise ValueError("canonical market-bars/v2 timestamps are already UTC")
        return list(canonical)
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        raise ValueError("input must be a JSON array of candle objects")  # noqa: TRY004 - preserve loader API
    candles = [Candle.from_dict(row) for row in raw]
    if source_timestamp_mode == "utc-epoch":
        return candles
    if source_timestamp_mode != "naive-local":
        raise ValueError("source_timestamp_mode must be utc-epoch or naive-local")
    time_zone = ZoneInfo(source_time_zone)
    return [reinterpret_naive_local_candle(candle, time_zone) for candle in candles]


def reinterpret_naive_local_candle(
    candle: Candle,
    time_zone: ZoneInfo,
) -> Candle:
    """Apply an IANA zone to wall-clock values incorrectly stored as UTC."""

    duration = candle.end_time - candle.start_time
    naive_start = datetime.fromtimestamp(
        candle.start_time / 1000,
        tz=UTC,
    ).replace(tzinfo=None)
    start_time = int(naive_start.replace(tzinfo=time_zone).timestamp() * 1000)
    return Candle(
        start_time=start_time,
        end_time=start_time + duration,
        open=candle.open,
        high=candle.high,
        low=candle.low,
        close=candle.close,
        volume=candle.volume,
        trade_count=candle.trade_count,
    )


def filter_candles_for_session(
    candles: list[Candle],
    session_time_zone: str,
    session_profile: str,
) -> list[Candle]:
    """Keep only the declared session when replaying a cash-market proxy."""

    if session_profile == "unrestricted":
        return candles
    if session_profile != "rth":
        raise ValueError("session_profile must be unrestricted or rth")
    time_zone = ZoneInfo(session_time_zone)
    return [candle for candle in candles if is_rth_candle(candle, time_zone)]


def is_rth_candle(candle: Candle, time_zone: ZoneInfo) -> bool:
    """Return whether a candle starts inside 09:30–16:00 local time."""

    local_start = datetime.fromtimestamp(
        candle.start_time / 1000,
        tz=time_zone,
    )
    minute_of_day = local_start.hour * 60 + local_start.minute
    return 9 * 60 + 30 <= minute_of_day < 16 * 60


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
        raise ValueError("source_timestamp_mode must be utc-epoch or naive-local")
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


def iter_json_array(path: Path) -> Iterator[dict[str, object]]:
    """Yield dict rows from one JSON array with bounded parser memory."""

    decoder = json.JSONDecoder()
    with path.open("r", encoding="utf-8") as source:
        buffer = ""
        cursor = 0
        array_started = False
        reached_eof = False
        while True:
            if not reached_eof and len(buffer) - cursor < JSON_REFILL_THRESHOLD:
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
                raise ValueError("every candle row must be a JSON object")  # noqa: TRY004 - preserve loader API
            yield value
            cursor = end_index
