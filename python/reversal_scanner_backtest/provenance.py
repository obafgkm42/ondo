"""Stable input fingerprints and source-version metadata for research runs."""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path


def fingerprint(value: object) -> str:
    """Return a deterministic SHA-256 for a JSON-compatible object."""

    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def repository_state() -> dict[str, object]:
    """Capture commit identity and dirtiness without requiring Git."""

    project_root = Path(__file__).resolve().parents[2]
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=project_root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        dirty = bool(
            subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=project_root,
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
        )
        return {"commit": commit, "workingTreeDirty": dirty}
    except (OSError, subprocess.CalledProcessError):
        return {"commit": None, "workingTreeDirty": None}


def dataset_sha256(path: Path) -> str:
    """Return a stable SHA-256 digest for a historical input file."""

    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
