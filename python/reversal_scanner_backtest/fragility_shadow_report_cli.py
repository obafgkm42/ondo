"""CLI for an offline market-fragility KV snapshot report."""

from __future__ import annotations

import argparse
import hashlib
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from reversal_scanner_backtest.fragility_shadow_report import (
    load_fragility_shadow_state,
    render_fragility_shadow_markdown,
    summarize_fragility_shadow,
)


SCHEMA_VERSION = 1
DEFAULT_OUTPUT_DIR = Path("reports/generated/fragility-shadow")


def main(argv: Sequence[str] | None = None) -> None:
    """Read one local KV export and write JSON plus Markdown artifacts."""

    args = parse_args(argv)
    state = load_fragility_shadow_state(args.input_state)
    input_sha256 = file_sha256(args.input_state)
    payload: dict[str, object] = {
        "schemaVersion": SCHEMA_VERSION,
        "runId": f"fragility-shadow-{input_sha256[:8]}",
        "createdAt": datetime.now(tz=UTC).isoformat(),
        "input": {
            "path": str(args.input_state),
            "sha256": input_sha256,
        },
        "summary": summarize_fragility_shadow(state),
    }
    write_outputs(args.output_dir, payload)
    print_headline(payload, args.output_dir)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """Parse the deliberately offline report contract."""

    parser = argparse.ArgumentParser(
        description=(
            "Summarize one exported market-fragility shadow KV value "
            "without network access"
        )
    )
    parser.add_argument(
        "--input-state",
        required=True,
        type=Path,
        help="Path to the JSON value exported by `wrangler kv key get --text`",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Artifact directory (default: {DEFAULT_OUTPUT_DIR})",
    )
    return parser.parse_args(argv)


def write_outputs(output_dir: Path, payload: dict[str, object]) -> None:
    """Write stable machine- and human-readable artifacts."""

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "fragility_shadow_report.json").write_text(
        json.dumps(payload, indent=2) + "\n",
        encoding="utf-8",
    )
    (output_dir / "fragility_shadow_report.md").write_text(
        render_fragility_shadow_markdown(payload),
        encoding="utf-8",
    )


def print_headline(payload: dict[str, object], output_dir: Path) -> None:
    """Print a compact, non-promotional summary."""

    summary = payload["summary"]
    assert isinstance(summary, dict)
    window = summary["window"]
    breaking = summary["breaking"]
    quality = summary["dataQuality"]
    assert isinstance(window, dict)
    assert isinstance(breaking, dict)
    assert isinstance(quality, dict)
    sample_state = (
        "ready" if quality["readyForDescriptiveReview"] else "collecting"
    )
    print(
        f"Fragility shadow sessions={window['retainedSessions']} "
        f"breaking={breaking['sessions']} sample={sample_state} "
        f"output={output_dir}"
    )


def file_sha256(path: Path) -> str:
    """Return the SHA-256 digest of one exported KV value."""

    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


if __name__ == "__main__":
    main()
