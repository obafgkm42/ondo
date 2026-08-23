"""Offline reporting for bounded market-fragility shadow KV snapshots."""

from __future__ import annotations

import json
import math
import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, cast


MAX_RETAINED_SESSIONS = 60
MAX_OBSERVATIONS_PER_SESSION = 16
MINIMUM_DESCRIPTIVE_SESSIONS = 30

FragilityLevel = Literal[
    "resilient",
    "fragile",
    "breaking",
    "panic",
    "unknown",
]
BreakingStatus = Literal["BELOW_THRESHOLD", "PENDING", "CONFIRMED"]
Transition = Literal[
    "UNAVAILABLE",
    "STABLE",
    "NEW_BREAK",
    "ESCALATING",
    "PERSISTENT",
    "ROTATING",
    "IMPROVING",
    "RECOVERED",
    "RELAPSE",
]
IndicatorId = Literal[
    "session_loss",
    "vwap_repair_failure",
    "poor_close_location",
    "downside_tail_cluster",
    "mega_cap_breadth",
    "equity_cross_confirmation",
]
MechanismFamily = Literal[
    "price_damage",
    "repair_failure",
    "breadth",
    "cross_market_confirmation",
]

FRAGILITY_LEVELS: tuple[FragilityLevel, ...] = (
    "resilient",
    "fragile",
    "breaking",
    "panic",
    "unknown",
)
BREAKING_STATUSES: tuple[BreakingStatus, ...] = (
    "BELOW_THRESHOLD",
    "PENDING",
    "CONFIRMED",
)
TRANSITIONS: tuple[Transition, ...] = (
    "UNAVAILABLE",
    "STABLE",
    "NEW_BREAK",
    "ESCALATING",
    "PERSISTENT",
    "ROTATING",
    "IMPROVING",
    "RECOVERED",
    "RELAPSE",
)
INDICATOR_IDS: tuple[IndicatorId, ...] = (
    "session_loss",
    "vwap_repair_failure",
    "poor_close_location",
    "downside_tail_cluster",
    "mega_cap_breadth",
    "equity_cross_confirmation",
)
MECHANISM_FAMILIES: tuple[MechanismFamily, ...] = (
    "price_damage",
    "repair_failure",
    "breadth",
    "cross_market_confirmation",
)


@dataclass(frozen=True)
class ShadowObservation:
    """One normalized schema-v3 shadow observation."""

    timestamp: int
    price: float
    v1_level: FragilityLevel
    stressed_indicator_count: int
    available_indicator_count: int
    breaking_streak: int
    breaking_status: BreakingStatus
    breaking_started_at: int | None
    breaking_duration_minutes: int
    transition: Transition
    stressed_indicator_ids: tuple[IndicatorId, ...]
    persistent_indicator_ids: tuple[IndicatorId, ...]
    added_indicator_ids: tuple[IndicatorId, ...]
    recovered_indicator_ids: tuple[IndicatorId, ...]
    stressed_family_ids: tuple[MechanismFamily, ...]
    mechanism_history_available: bool

    @property
    def is_breaking(self) -> bool:
        """Return whether the frozen v1 label is BREAKING or PANIC."""

        return self.v1_level in {"breaking", "panic"}


@dataclass(frozen=True)
class ShadowSession:
    """One retained US-equity session."""

    session_key: str
    observations: tuple[ShadowObservation, ...]


@dataclass(frozen=True)
class ShadowState:
    """Validated snapshot plus its original on-disk schema version."""

    source_version: Literal[2, 3]
    market: str
    sessions: tuple[ShadowSession, ...]


def load_fragility_shadow_state(path: Path) -> ShadowState:
    """Load and validate one Wrangler-exported KV JSON value."""

    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ValueError(f"shadow state file does not exist: {path}") from None
    except json.JSONDecodeError as error:
        raise ValueError(
            f"shadow state is not valid JSON at line {error.lineno}, "
            f"column {error.colno}"
        ) from error
    return parse_fragility_shadow_state(raw)


def parse_fragility_shadow_state(raw: object) -> ShadowState:
    """Validate schema v3 or normalize the in-place legacy schema v2."""

    root = _require_object(raw, "state")
    source_version = _require_int(root, "version", "state", minimum=2)
    if source_version not in {2, 3}:
        raise ValueError(
            f"state.version must be 2 or 3, got {source_version}"
        )
    market = _require_nonempty_string(root, "market", "state")
    raw_sessions = _require_list(root, "sessions", "state")
    if not raw_sessions:
        raise ValueError("state.sessions must contain at least one session")
    if len(raw_sessions) > MAX_RETAINED_SESSIONS:
        raise ValueError(
            "state.sessions exceeds the bounded 60-session contract"
        )

    sessions: list[ShadowSession] = []
    seen_session_keys: set[str] = set()
    previous_timestamp: int | None = None
    for session_index, raw_session in enumerate(raw_sessions):
        session_path = f"state.sessions[{session_index}]"
        session_object = _require_object(raw_session, session_path)
        session_key = _require_nonempty_string(
            session_object,
            "sessionKey",
            session_path,
        )
        if session_key in seen_session_keys:
            raise ValueError(f"duplicate sessionKey: {session_key}")
        seen_session_keys.add(session_key)
        raw_observations = _require_list(
            session_object,
            "observations",
            session_path,
        )
        if not raw_observations:
            raise ValueError(f"{session_path}.observations must not be empty")
        if len(raw_observations) > MAX_OBSERVATIONS_PER_SESSION:
            raise ValueError(
                f"{session_path}.observations exceeds the bounded "
                "16-observation contract"
            )

        observations: list[ShadowObservation] = []
        for observation_index, raw_observation in enumerate(raw_observations):
            observation_path = (
                f"{session_path}.observations[{observation_index}]"
            )
            observation = _parse_observation(
                raw_observation,
                observation_path,
                source_version,
            )
            if (
                previous_timestamp is not None
                and observation.timestamp <= previous_timestamp
            ):
                raise ValueError(
                    f"{observation_path}.timestamp must be strictly later "
                    "than the preceding retained observation"
                )
            previous_timestamp = observation.timestamp
            observations.append(observation)
        sessions.append(
            ShadowSession(
                session_key=session_key,
                observations=tuple(observations),
            )
        )

    return ShadowState(
        source_version=cast(Literal[2, 3], source_version),
        market=market,
        sessions=tuple(sessions),
    )


def summarize_fragility_shadow(state: ShadowState) -> dict[str, object]:
    """Build observation- and session-weighted descriptive telemetry."""

    observations = [
        observation
        for session in state.sessions
        for observation in session.observations
    ]
    breaking_sessions = [
        session
        for session in state.sessions
        if any(observation.is_breaking for observation in session.observations)
    ]
    pending_sessions = [
        session
        for session in state.sessions
        if any(
            observation.breaking_status in {"PENDING", "CONFIRMED"}
            for observation in session.observations
        )
    ]
    confirmed_sessions = [
        session
        for session in state.sessions
        if any(
            observation.breaking_status == "CONFIRMED"
            for observation in session.observations
        )
    ]

    indicator_observations: Counter[str] = Counter()
    indicator_sessions: defaultdict[str, set[str]] = defaultdict(set)
    family_observations: Counter[str] = Counter()
    family_sessions: defaultdict[str, set[str]] = defaultdict(set)
    family_breadth: Counter[int] = Counter()
    duration_maxima: list[int] = []
    for session in breaking_sessions:
        evaluable_durations: list[int] = []
        for observation in session.observations:
            if not observation.is_breaking:
                continue
            family_breadth[len(observation.stressed_family_ids)] += 1
            for indicator_id in observation.stressed_indicator_ids:
                indicator_observations[indicator_id] += 1
                indicator_sessions[indicator_id].add(session.session_key)
            for family_id in observation.stressed_family_ids:
                family_observations[family_id] += 1
                family_sessions[family_id].add(session.session_key)
            if observation.mechanism_history_available:
                evaluable_durations.append(
                    observation.breaking_duration_minutes
                )
        if evaluable_durations:
            duration_maxima.append(max(evaluable_durations))

    level_counts = Counter(observation.v1_level for observation in observations)
    status_counts = Counter(
        observation.breaking_status for observation in observations
    )
    transition_counts = Counter(
        observation.transition for observation in observations
    )
    breaking_observation_count = sum(
        observation.is_breaking for observation in observations
    )
    history_available = sum(
        observation.mechanism_history_available
        for observation in observations
    )
    latest = observations[-1]
    breaking_session_count = len(breaking_sessions)

    return {
        "market": state.market,
        "sourceStateVersion": state.source_version,
        "normalizedStateVersion": 3,
        "window": {
            "retainedSessions": len(state.sessions),
            "retainedObservations": len(observations),
            "firstTimestamp": observations[0].timestamp,
            "firstTimestampUtc": _timestamp_iso(observations[0].timestamp),
            "lastTimestamp": latest.timestamp,
            "lastTimestampUtc": _timestamp_iso(latest.timestamp),
        },
        "levels": {
            level: level_counts[level] for level in FRAGILITY_LEVELS
        },
        "breaking": {
            "observations": breaking_observation_count,
            "sessions": breaking_session_count,
            "pendingCandidateSessions": len(pending_sessions),
            "confirmedSessions": len(confirmed_sessions),
            "confirmationRate": _safe_ratio(
                len(confirmed_sessions),
                len(pending_sessions),
            ),
            "statusObservations": {
                status: status_counts[status]
                for status in BREAKING_STATUSES
            },
        },
        "transitions": {
            "observationCounts": {
                transition: transition_counts[transition]
                for transition in TRANSITIONS
            },
            "worseningObservations": sum(
                transition_counts[transition]
                for transition in ("NEW_BREAK", "ESCALATING", "RELAPSE")
            ),
            "repairObservations": sum(
                transition_counts[transition]
                for transition in ("IMPROVING", "RECOVERED")
            ),
            "rotatingObservations": transition_counts["ROTATING"],
        },
        "mechanisms": {
            "denominatorBreakingObservations": breaking_observation_count,
            "denominatorBreakingSessions": breaking_session_count,
            "indicators": [
                {
                    "id": indicator_id,
                    "breakingObservationOccurrences": (
                        indicator_observations[indicator_id]
                    ),
                    "breakingSessionCount": len(
                        indicator_sessions[indicator_id]
                    ),
                    "breakingSessionPrevalence": _safe_ratio(
                        len(indicator_sessions[indicator_id]),
                        breaking_session_count,
                    ),
                }
                for indicator_id in INDICATOR_IDS
            ],
            "families": [
                {
                    "id": family_id,
                    "breakingObservationOccurrences": (
                        family_observations[family_id]
                    ),
                    "breakingSessionCount": len(family_sessions[family_id]),
                    "breakingSessionPrevalence": _safe_ratio(
                        len(family_sessions[family_id]),
                        breaking_session_count,
                    ),
                }
                for family_id in MECHANISM_FAMILIES
            ],
            "familyBreadthByBreakingObservation": {
                str(breadth): family_breadth[breadth]
                for breadth in range(len(MECHANISM_FAMILIES) + 1)
            },
        },
        "sessionMaxBreakingDurationMinutes": _distribution(duration_maxima),
        "latestObservation": {
            "timestamp": latest.timestamp,
            "timestampUtc": _timestamp_iso(latest.timestamp),
            "price": latest.price,
            "v1Level": latest.v1_level,
            "breakingStatus": latest.breaking_status,
            "breakingDurationMinutes": latest.breaking_duration_minutes,
            "transition": latest.transition,
            "stressedIndicatorIds": list(latest.stressed_indicator_ids),
            "stressedFamilyIds": list(latest.stressed_family_ids),
            "mechanismHistoryAvailable": (
                latest.mechanism_history_available
            ),
        },
        "dataQuality": {
            "mechanismHistoryAvailableObservations": history_available,
            "mechanismHistoryUnavailableObservations": (
                len(observations) - history_available
            ),
            "minimumTargetSessions": MINIMUM_DESCRIPTIVE_SESSIONS,
            "readyForDescriptiveReview": (
                len(state.sessions) >= MINIMUM_DESCRIPTIVE_SESSIONS
            ),
            "legacyStateMigrated": state.source_version == 2,
        },
        "limitations": [
            (
                "Descriptive shadow telemetry only; this report makes no "
                "alert, threshold, strategy, or trading inference."
            ),
            (
                "Repeated briefs within a session are not independent. "
                "Mechanism prevalence and duration summaries therefore use "
                "session-level denominators where possible."
            ),
            (
                "The KV state does not retain data-health exclusions, so this "
                "snapshot cannot estimate stale, gap, holiday, early-close, "
                "or overnight exclusion frequency. Exported Worker logs are "
                "required for that audit."
            ),
            (
                "The rolling KV window retains at most 60 sessions and 16 "
                "observations per session; it is not a complete historical "
                "archive."
            ),
        ],
    }


def render_fragility_shadow_markdown(payload: dict[str, object]) -> str:
    """Render the stable human-readable report artifact."""

    summary = cast(dict[str, object], payload["summary"])
    window = cast(dict[str, object], summary["window"])
    levels = cast(dict[str, int], summary["levels"])
    breaking = cast(dict[str, object], summary["breaking"])
    status_counts = cast(
        dict[str, int],
        breaking["statusObservations"],
    )
    transitions = cast(dict[str, object], summary["transitions"])
    transition_counts = cast(
        dict[str, int],
        transitions["observationCounts"],
    )
    mechanisms = cast(dict[str, object], summary["mechanisms"])
    duration = cast(
        dict[str, object],
        summary["sessionMaxBreakingDurationMinutes"],
    )
    latest = cast(dict[str, object], summary["latestObservation"])
    quality = cast(dict[str, object], summary["dataQuality"])
    lines = [
        "# Market Fragility Shadow Snapshot",
        "",
        f"Run `{payload['runId']}` · report schema {payload['schemaVersion']}",
        "",
        "## Scope",
        "",
        (
            "Descriptive shadow telemetry only. This report does not change "
            "the frozen classifier and makes no alert, threshold, strategy, "
            "or trading inference."
        ),
        "",
        f"- market: `{summary['market']}`",
        (
            f"- source state: v{summary['sourceStateVersion']} "
            f"(normalized to v{summary['normalizedStateVersion']})"
        ),
        (
            f"- retained window: {window['retainedSessions']} sessions / "
            f"{window['retainedObservations']} observations"
        ),
        f"- first observation: {window['firstTimestampUtc']}",
        f"- latest observation: {window['lastTimestampUtc']}",
        "",
        "## Retained Level Mix",
        "",
        "| frozen v1 level | observations |",
        "| --- | ---: |",
    ]
    lines.extend(
        f"| {level.upper()} | {levels[level]} |" for level in FRAGILITY_LEVELS
    )
    lines.extend(
        [
            "",
            "## BREAKING / PANIC Cluster",
            "",
            f"- breaking observations: {breaking['observations']}",
            f"- breaking sessions: {breaking['sessions']}",
            (
                f"- pending-candidate / confirmed sessions: "
                f"{breaking['pendingCandidateSessions']} / "
                f"{breaking['confirmedSessions']}"
            ),
            (
                "- retained-window confirmation rate: "
                f"{_format_percent(breaking['confirmationRate'])}"
            ),
            "",
            "| persistence status | observations |",
            "| --- | ---: |",
        ]
    )
    lines.extend(
        f"| {status} | {status_counts[status]} |"
        for status in BREAKING_STATUSES
    )
    lines.extend(
        [
            "",
            "| transition | observations |",
            "| --- | ---: |",
        ]
    )
    lines.extend(
        f"| {transition} | {transition_counts[transition]} |"
        for transition in TRANSITIONS
    )
    lines.extend(
        [
            "",
            "## Stressed Mechanisms",
            "",
            (
                "Occurrence counts use BREAKING/PANIC observations. Session "
                "prevalence counts each affected session once."
            ),
            "",
            (
                "| indicator | observation occurrences | breaking sessions | "
                "session prevalence |"
            ),
            "| --- | ---: | ---: | ---: |",
        ]
    )
    indicator_rows = cast(list[dict[str, object]], mechanisms["indicators"])
    for row in indicator_rows:
        lines.append(
            f"| {row['id']} | {row['breakingObservationOccurrences']} | "
            f"{row['breakingSessionCount']} | "
            f"{_format_percent(row['breakingSessionPrevalence'])} |"
        )
    lines.extend(
        [
            "",
            "| mechanism family | observation occurrences | breaking sessions | session prevalence |",
            "| --- | ---: | ---: | ---: |",
        ]
    )
    family_rows = cast(list[dict[str, object]], mechanisms["families"])
    for row in family_rows:
        lines.append(
            f"| {row['id']} | {row['breakingObservationOccurrences']} | "
            f"{row['breakingSessionCount']} | "
            f"{_format_percent(row['breakingSessionPrevalence'])} |"
        )
    lines.extend(
        [
            "",
            "## Session-level Duration",
            "",
            (
                "One maximum BREAKING/PANIC duration is retained per evaluable "
                "session. P90 uses the deterministic nearest-rank method."
            ),
            "",
            f"- evaluable sessions: {duration['count']}",
            (
                f"- min / median / mean: {_format_number(duration['min'])} / "
                f"{_format_number(duration['median'])} / "
                f"{_format_number(duration['mean'])} minutes"
            ),
            (
                f"- p90 / max: {_format_number(duration['p90'])} / "
                f"{_format_number(duration['max'])} minutes"
            ),
            "",
            "## Latest Observation",
            "",
            f"- time: {latest['timestampUtc']}",
            f"- v1 level / persistence: `{latest['v1Level']}` / `{latest['breakingStatus']}`",
            f"- transition: `{latest['transition']}`",
            f"- breaking duration: {latest['breakingDurationMinutes']} minutes",
            (
                "- stressed indicators: "
                f"{_format_ids(cast(list[str], latest['stressedIndicatorIds']))}"
            ),
            (
                "- stressed families: "
                f"{_format_ids(cast(list[str], latest['stressedFamilyIds']))}"
            ),
            "",
            "## Data Quality and Limits",
            "",
            (
                "- mechanism-history observations available / unavailable: "
                f"{quality['mechanismHistoryAvailableObservations']} / "
                f"{quality['mechanismHistoryUnavailableObservations']}"
            ),
            (
                f"- descriptive sample gate: {window['retainedSessions']} / "
                f"{quality['minimumTargetSessions']} sessions "
                f"({'READY' if quality['readyForDescriptiveReview'] else 'COLLECTING'})"
            ),
            "",
        ]
    )
    limitations = cast(list[str], summary["limitations"])
    lines.extend(f"- {limitation}" for limitation in limitations)
    return "\n".join(lines) + "\n"


def _parse_observation(
    raw: object,
    path: str,
    source_version: int,
) -> ShadowObservation:
    value = _require_object(raw, path)
    timestamp = _require_int(value, "timestamp", path, minimum=0)
    price = _require_number(value, "price", path, minimum_exclusive=0)
    v1_level = _require_enum(
        value,
        "v1Level",
        path,
        FRAGILITY_LEVELS if source_version == 3 else FRAGILITY_LEVELS[:-1],
    )
    stressed_count = _require_int(
        value,
        "stressedIndicatorCount",
        path,
        minimum=0,
        maximum=len(INDICATOR_IDS),
    )
    available_count = _require_int(
        value,
        "availableIndicatorCount",
        path,
        minimum=0,
        maximum=len(INDICATOR_IDS),
    )
    if stressed_count > available_count:
        raise ValueError(
            f"{path}.stressedIndicatorCount cannot exceed "
            "availableIndicatorCount"
        )
    breaking_streak = _require_int(
        value,
        "breakingStreak",
        path,
        minimum=0,
    )
    breaking_status = _require_enum(
        value,
        "breakingStatus",
        path,
        BREAKING_STATUSES,
    )

    if source_version == 2:
        return ShadowObservation(
            timestamp=timestamp,
            price=price,
            v1_level=cast(FragilityLevel, v1_level),
            stressed_indicator_count=stressed_count,
            available_indicator_count=available_count,
            breaking_streak=breaking_streak,
            breaking_status=cast(BreakingStatus, breaking_status),
            breaking_started_at=(
                None if breaking_status == "BELOW_THRESHOLD" else timestamp
            ),
            breaking_duration_minutes=0,
            transition="UNAVAILABLE",
            stressed_indicator_ids=(),
            persistent_indicator_ids=(),
            added_indicator_ids=(),
            recovered_indicator_ids=(),
            stressed_family_ids=(),
            mechanism_history_available=False,
        )

    breaking_started_raw = value.get("breakingStartedAt")
    if breaking_started_raw is None:
        breaking_started_at = None
    elif type(breaking_started_raw) is int and breaking_started_raw >= 0:
        breaking_started_at = breaking_started_raw
    else:
        raise ValueError(f"{path}.breakingStartedAt must be null or an integer")
    breaking_duration = _require_int(
        value,
        "breakingDurationMinutes",
        path,
        minimum=0,
    )
    transition = _require_enum(value, "transition", path, TRANSITIONS)
    stressed_ids = _require_enum_array(
        value,
        "stressedIndicatorIds",
        path,
        INDICATOR_IDS,
    )
    persistent_ids = _require_enum_array(
        value,
        "persistentIndicatorIds",
        path,
        INDICATOR_IDS,
    )
    added_ids = _require_enum_array(
        value,
        "addedIndicatorIds",
        path,
        INDICATOR_IDS,
    )
    recovered_ids = _require_enum_array(
        value,
        "recoveredIndicatorIds",
        path,
        INDICATOR_IDS,
    )
    family_ids = _require_enum_array(
        value,
        "stressedFamilyIds",
        path,
        MECHANISM_FAMILIES,
    )
    history_available = value.get("mechanismHistoryAvailable")
    if type(history_available) is not bool:
        raise ValueError(
            f"{path}.mechanismHistoryAvailable must be a boolean"
        )
    return ShadowObservation(
        timestamp=timestamp,
        price=price,
        v1_level=cast(FragilityLevel, v1_level),
        stressed_indicator_count=stressed_count,
        available_indicator_count=available_count,
        breaking_streak=breaking_streak,
        breaking_status=cast(BreakingStatus, breaking_status),
        breaking_started_at=breaking_started_at,
        breaking_duration_minutes=breaking_duration,
        transition=cast(Transition, transition),
        stressed_indicator_ids=cast(tuple[IndicatorId, ...], stressed_ids),
        persistent_indicator_ids=cast(
            tuple[IndicatorId, ...],
            persistent_ids,
        ),
        added_indicator_ids=cast(tuple[IndicatorId, ...], added_ids),
        recovered_indicator_ids=cast(
            tuple[IndicatorId, ...],
            recovered_ids,
        ),
        stressed_family_ids=cast(
            tuple[MechanismFamily, ...],
            family_ids,
        ),
        mechanism_history_available=history_available,
    )


def _require_object(value: object, path: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be a JSON object")
    if not all(isinstance(key, str) for key in value):
        raise ValueError(f"{path} must use string keys")
    return cast(dict[str, object], value)


def _require_list(
    value: dict[str, object],
    key: str,
    path: str,
) -> list[object]:
    candidate = value.get(key)
    if not isinstance(candidate, list):
        raise ValueError(f"{path}.{key} must be an array")
    return cast(list[object], candidate)


def _require_nonempty_string(
    value: dict[str, object],
    key: str,
    path: str,
) -> str:
    candidate = value.get(key)
    if not isinstance(candidate, str) or not candidate.strip():
        raise ValueError(f"{path}.{key} must be a non-empty string")
    return candidate


def _require_int(
    value: dict[str, object],
    key: str,
    path: str,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    candidate = value.get(key)
    if type(candidate) is not int:
        raise ValueError(f"{path}.{key} must be an integer")
    if minimum is not None and candidate < minimum:
        raise ValueError(f"{path}.{key} must be at least {minimum}")
    if maximum is not None and candidate > maximum:
        raise ValueError(f"{path}.{key} must be at most {maximum}")
    return candidate


def _require_number(
    value: dict[str, object],
    key: str,
    path: str,
    *,
    minimum_exclusive: float | None = None,
) -> float:
    candidate = value.get(key)
    if type(candidate) not in {int, float} or not math.isfinite(candidate):
        raise ValueError(f"{path}.{key} must be a finite number")
    number = float(candidate)
    if minimum_exclusive is not None and number <= minimum_exclusive:
        raise ValueError(
            f"{path}.{key} must be greater than {minimum_exclusive}"
        )
    return number


def _require_enum(
    value: dict[str, object],
    key: str,
    path: str,
    allowed: tuple[str, ...],
) -> str:
    candidate = value.get(key)
    if not isinstance(candidate, str) or candidate not in allowed:
        raise ValueError(
            f"{path}.{key} must be one of: {', '.join(allowed)}"
        )
    return candidate


def _require_enum_array(
    value: dict[str, object],
    key: str,
    path: str,
    allowed: tuple[str, ...],
) -> tuple[str, ...]:
    candidates = _require_list(value, key, path)
    if any(
        not isinstance(candidate, str) or candidate not in allowed
        for candidate in candidates
    ):
        raise ValueError(
            f"{path}.{key} entries must be one of: {', '.join(allowed)}"
        )
    result = cast(tuple[str, ...], tuple(candidates))
    if len(result) != len(set(result)):
        raise ValueError(f"{path}.{key} must not contain duplicates")
    return result


def _distribution(values: list[int]) -> dict[str, object]:
    if not values:
        return {
            "count": 0,
            "min": None,
            "mean": None,
            "median": None,
            "p90": None,
            "max": None,
            "percentileMethod": "nearest-rank",
        }
    ordered = sorted(values)
    p90_index = max(0, math.ceil(0.90 * len(ordered)) - 1)
    return {
        "count": len(ordered),
        "min": ordered[0],
        "mean": statistics.fmean(ordered),
        "median": statistics.median(ordered),
        "p90": ordered[p90_index],
        "max": ordered[-1],
        "percentileMethod": "nearest-rank",
    }


def _safe_ratio(numerator: int, denominator: int) -> float | None:
    return None if denominator == 0 else numerator / denominator


def _timestamp_iso(timestamp_ms: int) -> str:
    return datetime.fromtimestamp(timestamp_ms / 1_000, tz=UTC).isoformat()


def _format_percent(value: object) -> str:
    if not isinstance(value, (int, float)):
        return "n/a"
    return f"{value:.1%}"


def _format_number(value: object) -> str:
    if not isinstance(value, (int, float)):
        return "n/a"
    return f"{value:.1f}"


def _format_ids(values: list[str]) -> str:
    return ", ".join(f"`{value}`" for value in values) if values else "none"
