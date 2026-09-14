import type {
  MarketFragilityIndicatorId,
  MarketFragilityIndicatorState,
  MarketFragilitySnapshot,
  MarketFragilityUnavailableReason,
} from "./types";
import { isFiniteNumber, isNonNegativeInteger } from "./runtime-validation";

// Keep the physical key stable so newer schemas migrate in place with the same
// one-read/one-write budget as earlier versions.
const SHADOW_STATE_PREFIX = "market-fragility-v2-shadow";
const SHADOW_STATE_VERSION = 4 as const;
const MEASUREMENT_VERSION = "market-fragility/v1" as const;
const MAX_RETAINED_SESSIONS = 60;
const MAX_OBSERVATIONS_PER_SESSION = 16;

export type MarketFragilityMechanismFamily =
  | "price_damage"
  | "repair_failure"
  | "breadth"
  | "cross_market_confirmation";

export type MarketFragilityTransition =
  | "UNAVAILABLE"
  | "STABLE"
  | "NEW_BREAK"
  | "ESCALATING"
  | "PERSISTENT"
  | "ROTATING"
  | "IMPROVING"
  | "RECOVERED"
  | "RELAPSE"
  | "NON_COMPARABLE";

export type MarketFragilityContinuityBreakReason =
  | "first_observation"
  | "missing_expected_brief"
  | "coverage_changed"
  | "measurement_changed"
  | "legacy_unknown";

export interface MarketFragilityIndicatorObservation {
  id: MarketFragilityIndicatorId;
  state: MarketFragilityIndicatorState | "unknown";
  unavailableReason: MarketFragilityUnavailableReason | "legacy_unknown" | null;
}

export type MarketFragilityBreakingStatus =
  | "BELOW_THRESHOLD"
  | "PENDING"
  | "CONFIRMED";

export interface MarketFragilityShadowObservation {
  timestamp: number;
  price: number;
  v1Level: MarketFragilitySnapshot["level"];
  stressedIndicatorCount: number;
  availableIndicatorCount: number;
  breakingStreak: number;
  breakingStatus: MarketFragilityBreakingStatus;
  breakingStartedAt: number | null;
  breakingElapsedMinutes: number;
  breakingObservedDurationMinutes: number;
  /** @deprecated Use breakingElapsedMinutes. */
  breakingDurationMinutes: number;
  transition: MarketFragilityTransition;
  measurementVersion: typeof MEASUREMENT_VERSION | "legacy_unknown";
  indicatorStates: MarketFragilityIndicatorObservation[];
  coverageComparable: boolean;
  continuousFromPrevious: boolean;
  continuityBreakReason: MarketFragilityContinuityBreakReason | null;
  stressedIndicatorIds: MarketFragilityIndicatorId[];
  persistentIndicatorIds: MarketFragilityIndicatorId[];
  addedIndicatorIds: MarketFragilityIndicatorId[];
  recoveredIndicatorIds: MarketFragilityIndicatorId[];
  lostCoverageIndicatorIds: MarketFragilityIndicatorId[];
  gainedCoverageIndicatorIds: MarketFragilityIndicatorId[];
  stressedFamilyIds: MarketFragilityMechanismFamily[];
  mechanismHistoryAvailable: boolean;
}

export interface MarketFragilityShadowSession {
  sessionKey: string;
  observations: MarketFragilityShadowObservation[];
}

export interface MarketFragilityShadowState {
  version: 4;
  market: string;
  sessions: MarketFragilityShadowSession[];
}

export interface MarketFragilityConfirmationMetrics {
  stateAvailable: boolean;
  retainedSessions: number;
  retainedObservations: number;
  pendingSessions: number;
  confirmedSessions: number;
  confirmationRate: number | null;
}

export interface MarketFragilityPersistenceBrief {
  observation: MarketFragilityShadowObservation;
  metrics: MarketFragilityConfirmationMetrics;
}

export interface MarketFragilityShadowUpdate {
  state: MarketFragilityShadowState | null;
  observation: MarketFragilityShadowObservation;
  metrics: MarketFragilityConfirmationMetrics;
  changed: boolean;
  ignoredReason: "duplicate" | "out_of_order" | null;
}

/**
 * Persist bounded, diagnostic-only v1 persistence rows for evaluation.
 * The shadow state never changes the frozen classifier or notification route.
 */
export async function recordMarketFragilityShadow(
  state: KVNamespace | undefined,
  market: string,
  sessionKey: string,
  timestamp: number,
  price: number,
  snapshot: MarketFragilitySnapshot,
  expectedBriefIntervalMinutes = 30,
): Promise<MarketFragilityShadowUpdate> {
  const rawState = await state?.get(shadowStateKey(market));
  const previousState = parseShadowState(rawState ?? null, market);
  const currentSession = previousState?.sessions.find(
    (session) => session.sessionKey === sessionKey,
  );
  const previousObservation = currentSession?.observations.at(-1);
  const latestStoredObservation = previousState?.sessions
    .at(-1)
    ?.observations.at(-1);
  const ignoredReason = observationIgnoredReason(
    latestStoredObservation,
    timestamp,
  );
  const proposedObservation = buildMarketFragilityShadowObservation(
    snapshot,
    timestamp,
    price,
    previousObservation,
    currentSession?.observations.some(isBreakingObservation) ?? false,
    expectedBriefIntervalMinutes,
  );
  const observation =
    ignoredReason === null
      ? proposedObservation
      : latestStoredObservation ?? proposedObservation;
  if (ignoredReason !== null || state === undefined) {
    return {
      state: previousState,
      observation,
      metrics: confirmationMetrics(previousState, state !== undefined),
      changed: false,
      ignoredReason,
    };
  }

  const sessions = previousState?.sessions ?? [];
  const nextSession: MarketFragilityShadowSession = {
    sessionKey,
    observations: [
      ...(currentSession?.observations ?? []),
      observation,
    ].slice(-MAX_OBSERVATIONS_PER_SESSION),
  };
  const nextSessions = [
    ...sessions.filter((session) => session.sessionKey !== sessionKey),
    nextSession,
  ].slice(-MAX_RETAINED_SESSIONS);
  const nextState: MarketFragilityShadowState = {
    version: SHADOW_STATE_VERSION,
    market,
    sessions: nextSessions,
  };
  await state.put(shadowStateKey(market), JSON.stringify(nextState));
  return {
    state: nextState,
    observation,
    metrics: confirmationMetrics(nextState, true),
    changed: true,
    ignoredReason: null,
  };
}

/** Build one forward-only transition row without reading future observations. */
export function buildMarketFragilityShadowObservation(
  snapshot: MarketFragilitySnapshot,
  timestamp: number,
  price: number,
  previous: MarketFragilityShadowObservation | undefined,
  hadEarlierBreaking = false,
  expectedBriefIntervalMinutes = 30,
): MarketFragilityShadowObservation {
  const indicatorStates = snapshot.indicators.map((indicator) => ({
    id: indicator.id,
    state: indicator.state,
    unavailableReason: indicator.unavailableReason,
  }));
  const comparison = compareObservations(
    previous,
    indicatorStates,
    timestamp,
    expectedBriefIntervalMinutes,
  );
  const breakingCandidate =
    snapshot.level === "breaking" || snapshot.level === "panic";
  const breakingStreak = breakingCandidate
    ? (isBreakingObservation(previous) && comparison.continuous
        ? previous?.breakingStreak ?? 0
        : 0) + 1
    : 0;
  const breakingStatus: MarketFragilityBreakingStatus =
    !breakingCandidate
      ? "BELOW_THRESHOLD"
      : breakingStreak >= 2
        ? "CONFIRMED"
        : "PENDING";
  const stressedIndicatorIds = snapshot.indicators
    .filter((indicator) => indicator.state === "stressed")
    .map((indicator) => indicator.id);
  const previousBreaking = isBreakingObservation(previous);
  const breakingStartedAt = breakingCandidate
    ? previousBreaking && comparison.continuous
      ? previous?.breakingStartedAt ?? previous?.timestamp ?? timestamp
      : timestamp
    : null;
  const breakingElapsedMinutes = breakingStartedAt === null
    ? 0
    : Math.max(0, Math.floor((timestamp - breakingStartedAt) / 60_000));
  const breakingObservedDurationMinutes =
    breakingCandidate && previousBreaking && comparison.continuous
      ? (previous?.breakingObservedDurationMinutes ?? 0) +
        Math.floor((timestamp - (previous?.timestamp ?? timestamp)) / 60_000)
      : 0;
  return {
    timestamp,
    price,
    v1Level: snapshot.level,
    stressedIndicatorCount: snapshot.stressedIndicatorCount,
    availableIndicatorCount: snapshot.availableIndicatorCount,
    breakingStreak,
    breakingStatus,
    breakingStartedAt,
    breakingElapsedMinutes,
    breakingObservedDurationMinutes,
    breakingDurationMinutes: breakingElapsedMinutes,
    transition: classifyTransition(
      snapshot,
      previous,
      breakingCandidate,
      hadEarlierBreaking,
      comparison,
    ),
    measurementVersion: MEASUREMENT_VERSION,
    indicatorStates,
    coverageComparable: comparison.coverageComparable,
    continuousFromPrevious: comparison.continuous,
    continuityBreakReason: comparison.breakReason,
    stressedIndicatorIds,
    persistentIndicatorIds: comparison.persistentIndicatorIds,
    addedIndicatorIds: comparison.addedIndicatorIds,
    recoveredIndicatorIds: comparison.recoveredIndicatorIds,
    lostCoverageIndicatorIds: comparison.lostCoverageIndicatorIds,
    gainedCoverageIndicatorIds: comparison.gainedCoverageIndicatorIds,
    stressedFamilyIds: mechanismFamilies(stressedIndicatorIds),
    mechanismHistoryAvailable: true,
  };
}

/** Group correlated indicators without changing the frozen six-item score. */
export function mechanismFamily(
  indicatorId: MarketFragilityIndicatorId,
): MarketFragilityMechanismFamily {
  switch (indicatorId) {
    case "session_loss":
    case "downside_tail_cluster":
      return "price_damage";
    case "vwap_repair_failure":
    case "poor_close_location":
      return "repair_failure";
    case "mega_cap_breadth":
      return "breadth";
    case "equity_cross_confirmation":
      return "cross_market_confirmation";
  }
}

function classifyTransition(
  snapshot: MarketFragilitySnapshot,
  previous: MarketFragilityShadowObservation | undefined,
  breakingCandidate: boolean,
  hadEarlierBreaking: boolean,
  comparison: ObservationComparison,
): MarketFragilityTransition {
  if (previous === undefined) {
    return breakingCandidate ? "NEW_BREAK" : "STABLE";
  }
  if (!comparison.continuous) {
    return "NON_COMPARABLE";
  }
  const previousBreaking = isBreakingObservation(previous);
  if (!breakingCandidate) {
    if (previousBreaking) {
      return snapshot.stressedIndicatorCount === 0
        ? "RECOVERED"
        : "IMPROVING";
    }
    return snapshot.stressedIndicatorCount < previous.stressedIndicatorCount
      ? "IMPROVING"
      : "STABLE";
  }
  if (!previousBreaking) {
    return hadEarlierBreaking ? "RELAPSE" : "NEW_BREAK";
  }
  if (
    snapshot.stressedIndicatorCount > previous.stressedIndicatorCount ||
    levelSeverity(snapshot.level) > levelSeverity(previous.v1Level)
  ) {
    return "ESCALATING";
  }
  if (
    snapshot.stressedIndicatorCount < previous.stressedIndicatorCount ||
    comparison.recoveredIndicatorIds.length >
      comparison.addedIndicatorIds.length
  ) {
    return "IMPROVING";
  }
  if (
    previous.mechanismHistoryAvailable &&
    comparison.persistentIndicatorIds.length === 0 &&
    comparison.addedIndicatorIds.length > 0 &&
    comparison.recoveredIndicatorIds.length > 0
  ) {
    return "ROTATING";
  }
  return "PERSISTENT";
}

interface ObservationComparison {
  coverageComparable: boolean;
  continuous: boolean;
  breakReason: MarketFragilityContinuityBreakReason | null;
  persistentIndicatorIds: MarketFragilityIndicatorId[];
  addedIndicatorIds: MarketFragilityIndicatorId[];
  recoveredIndicatorIds: MarketFragilityIndicatorId[];
  lostCoverageIndicatorIds: MarketFragilityIndicatorId[];
  gainedCoverageIndicatorIds: MarketFragilityIndicatorId[];
}

function compareObservations(
  previous: MarketFragilityShadowObservation | undefined,
  currentStates: readonly MarketFragilityIndicatorObservation[],
  timestamp: number,
  expectedBriefIntervalMinutes: number,
): ObservationComparison {
  if (previous === undefined) {
    return emptyComparison("first_observation");
  }
  if (
    !previous.mechanismHistoryAvailable ||
    previous.measurementVersion === "legacy_unknown"
  ) {
    return emptyComparison("legacy_unknown");
  }
  if (previous.measurementVersion !== MEASUREMENT_VERSION) {
    return emptyComparison("measurement_changed");
  }

  const previousById = new Map(
    previous.indicatorStates.map((indicator) => [indicator.id, indicator]),
  );
  const persistentIndicatorIds: MarketFragilityIndicatorId[] = [];
  const addedIndicatorIds: MarketFragilityIndicatorId[] = [];
  const recoveredIndicatorIds: MarketFragilityIndicatorId[] = [];
  const lostCoverageIndicatorIds: MarketFragilityIndicatorId[] = [];
  const gainedCoverageIndicatorIds: MarketFragilityIndicatorId[] = [];
  for (const current of currentStates) {
    const prior = previousById.get(current.id);
    if (prior === undefined || prior.state === "unknown") {
      continue;
    }
    if (prior.state !== "unavailable" && current.state === "unavailable") {
      lostCoverageIndicatorIds.push(current.id);
      continue;
    }
    if (prior.state === "unavailable" && current.state !== "unavailable") {
      gainedCoverageIndicatorIds.push(current.id);
      continue;
    }
    if (prior.state === "stressed" && current.state === "stressed") {
      persistentIndicatorIds.push(current.id);
    } else if (prior.state === "healthy" && current.state === "stressed") {
      addedIndicatorIds.push(current.id);
    } else if (prior.state === "stressed" && current.state === "healthy") {
      recoveredIndicatorIds.push(current.id);
    }
  }
  const coverageComparable =
    lostCoverageIndicatorIds.length === 0 &&
    gainedCoverageIndicatorIds.length === 0;
  const missingExpectedBrief =
    timestamp - previous.timestamp > expectedBriefIntervalMinutes * 60_000;
  return {
    coverageComparable,
    continuous: coverageComparable && !missingExpectedBrief,
    breakReason: !coverageComparable
      ? "coverage_changed"
      : missingExpectedBrief
        ? "missing_expected_brief"
        : null,
    persistentIndicatorIds,
    addedIndicatorIds,
    recoveredIndicatorIds,
    lostCoverageIndicatorIds,
    gainedCoverageIndicatorIds,
  };
}

function emptyComparison(
  breakReason: MarketFragilityContinuityBreakReason,
): ObservationComparison {
  return {
    coverageComparable: false,
    continuous: false,
    breakReason,
    persistentIndicatorIds: [],
    addedIndicatorIds: [],
    recoveredIndicatorIds: [],
    lostCoverageIndicatorIds: [],
    gainedCoverageIndicatorIds: [],
  };
}

function mechanismFamilies(
  indicatorIds: readonly MarketFragilityIndicatorId[],
): MarketFragilityMechanismFamily[] {
  return [...new Set(indicatorIds.map(mechanismFamily))];
}

function isBreakingObservation(
  observation: MarketFragilityShadowObservation | undefined,
): boolean {
  return observation?.v1Level === "breaking" ||
    observation?.v1Level === "panic";
}

function levelSeverity(level: MarketFragilitySnapshot["level"]): number {
  switch (level) {
    case "unknown":
      return -1;
    case "resilient":
      return 0;
    case "fragile":
      return 1;
    case "breaking":
      return 2;
    case "panic":
      return 3;
  }
}

/** Return the bounded prospective-state key for one market. */
export function shadowStateKey(market: string): string {
  return `${SHADOW_STATE_PREFIX}:${market}`;
}

function confirmationMetrics(
  state: MarketFragilityShadowState | null,
  stateAvailable: boolean,
): MarketFragilityConfirmationMetrics {
  const sessions = state?.sessions ?? [];
  const pendingSessions = sessions.filter((session) =>
    session.observations.some(
      (observation) =>
        observation.breakingStatus === "PENDING" ||
        observation.breakingStatus === "CONFIRMED",
    ),
  ).length;
  const confirmedSessions = sessions.filter((session) =>
    session.observations.some(
      (observation) => observation.breakingStatus === "CONFIRMED",
    ),
  ).length;
  return {
    stateAvailable,
    retainedSessions: sessions.length,
    retainedObservations: sessions.reduce(
      (total, session) => total + session.observations.length,
      0,
    ),
    pendingSessions,
    confirmedSessions,
    confirmationRate:
      pendingSessions === 0 ? null : confirmedSessions / pendingSessions,
  };
}

function observationIgnoredReason(
  previous: MarketFragilityShadowObservation | undefined,
  timestamp: number,
): MarketFragilityShadowUpdate["ignoredReason"] {
  if (previous === undefined) {
    return null;
  }
  if (timestamp === previous.timestamp) {
    return "duplicate";
  }
  return timestamp < previous.timestamp ? "out_of_order" : null;
}

function parseShadowState(
  rawState: string | null,
  market: string,
): MarketFragilityShadowState | null {
  if (rawState === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rawState);
    if (isShadowState(parsed, market)) {
      return parsed;
    }
    return isLegacyShadowState(parsed, market)
      ? migrateLegacyShadowState(parsed)
      : null;
  } catch {
    return null;
  }
}

interface LegacyShadowObservation {
  timestamp: number;
  price: number;
  v1Level: Exclude<MarketFragilitySnapshot["level"], "unknown">;
  stressedIndicatorCount: number;
  availableIndicatorCount: number;
  breakingStreak: number;
  breakingStatus: MarketFragilityBreakingStatus;
}

interface LegacyShadowState {
  version: 2 | 3;
  market: string;
  sessions: Array<{
    sessionKey: string;
    observations: Array<LegacyShadowObservation & {
      breakingStartedAt?: number | null;
      breakingDurationMinutes?: number;
      stressedIndicatorIds?: MarketFragilityIndicatorId[];
    }>;
  }>;
}

function migrateLegacyShadowState(
  state: LegacyShadowState,
): MarketFragilityShadowState {
  return {
    version: SHADOW_STATE_VERSION,
    market: state.market,
    sessions: state.sessions.map((session) => ({
      sessionKey: session.sessionKey,
      observations: session.observations.map((observation) => ({
        ...observation,
        breakingStartedAt:
          observation.breakingStartedAt ??
          (observation.breakingStatus === "BELOW_THRESHOLD"
            ? null
            : observation.timestamp),
        breakingElapsedMinutes: observation.breakingDurationMinutes ?? 0,
        breakingObservedDurationMinutes: 0,
        breakingDurationMinutes: observation.breakingDurationMinutes ?? 0,
        transition: "UNAVAILABLE",
        measurementVersion: "legacy_unknown",
        indicatorStates: indicatorIds().map((id) => ({
          id,
          state: observation.stressedIndicatorIds?.includes(id)
            ? "stressed" as const
            : "unknown" as const,
          unavailableReason: observation.stressedIndicatorIds?.includes(id)
            ? null
            : "legacy_unknown" as const,
        })),
        coverageComparable: false,
        continuousFromPrevious: false,
        continuityBreakReason: "legacy_unknown",
        stressedIndicatorIds: observation.stressedIndicatorIds ?? [],
        persistentIndicatorIds: [],
        addedIndicatorIds: [],
        recoveredIndicatorIds: [],
        lostCoverageIndicatorIds: [],
        gainedCoverageIndicatorIds: [],
        stressedFamilyIds: [],
        mechanismHistoryAvailable: false,
      })),
    })),
  };
}

function isShadowState(
  value: unknown,
  market: string,
): value is MarketFragilityShadowState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<MarketFragilityShadowState>;
  return (
    candidate.version === SHADOW_STATE_VERSION &&
    candidate.market === market &&
    Array.isArray(candidate.sessions) &&
    candidate.sessions.every(isShadowSession)
  );
}

function isShadowSession(value: unknown): value is MarketFragilityShadowSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<MarketFragilityShadowSession>;
  return (
    typeof candidate.sessionKey === "string" &&
    Array.isArray(candidate.observations) &&
    candidate.observations.every(isShadowObservation)
  );
}

function isShadowObservation(
  value: unknown,
): value is MarketFragilityShadowObservation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<MarketFragilityShadowObservation>;
  return (
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp) &&
    typeof candidate.price === "number" &&
    Number.isFinite(candidate.price) &&
    candidate.price > 0 &&
    (candidate.v1Level === "resilient" ||
      candidate.v1Level === "fragile" ||
      candidate.v1Level === "breaking" ||
      candidate.v1Level === "panic" ||
      candidate.v1Level === "unknown") &&
    typeof candidate.stressedIndicatorCount === "number" &&
    Number.isInteger(candidate.stressedIndicatorCount) &&
    candidate.stressedIndicatorCount >= 0 &&
    typeof candidate.availableIndicatorCount === "number" &&
    Number.isInteger(candidate.availableIndicatorCount) &&
    candidate.availableIndicatorCount >= 0 &&
    typeof candidate.breakingStreak === "number" &&
    Number.isInteger(candidate.breakingStreak) &&
    candidate.breakingStreak >= 0 &&
    (candidate.breakingStatus === "BELOW_THRESHOLD" ||
      candidate.breakingStatus === "PENDING" ||
      candidate.breakingStatus === "CONFIRMED") &&
    (candidate.breakingStartedAt === null ||
      isFiniteNumber(candidate.breakingStartedAt)) &&
    isNonNegativeInteger(candidate.breakingDurationMinutes) &&
    isTransition(candidate.transition) &&
    (candidate.measurementVersion === MEASUREMENT_VERSION ||
      candidate.measurementVersion === "legacy_unknown") &&
    isIndicatorObservationArray(candidate.indicatorStates) &&
    typeof candidate.coverageComparable === "boolean" &&
    typeof candidate.continuousFromPrevious === "boolean" &&
    isContinuityBreakReason(candidate.continuityBreakReason) &&
    isNonNegativeInteger(candidate.breakingElapsedMinutes) &&
    isNonNegativeInteger(candidate.breakingObservedDurationMinutes) &&
    isIndicatorIdArray(candidate.stressedIndicatorIds) &&
    isIndicatorIdArray(candidate.persistentIndicatorIds) &&
    isIndicatorIdArray(candidate.addedIndicatorIds) &&
    isIndicatorIdArray(candidate.recoveredIndicatorIds) &&
    isIndicatorIdArray(candidate.lostCoverageIndicatorIds) &&
    isIndicatorIdArray(candidate.gainedCoverageIndicatorIds) &&
    isMechanismFamilyArray(candidate.stressedFamilyIds) &&
    typeof candidate.mechanismHistoryAvailable === "boolean" &&
    indicatorContractMatches(candidate)
  );
}

function indicatorContractMatches(
  observation: Partial<MarketFragilityShadowObservation>,
): boolean {
  const indicatorStates = observation.indicatorStates;
  const stressedIndicatorIds = observation.stressedIndicatorIds;
  if (!isIndicatorObservationArray(indicatorStates) ||
    !isIndicatorIdArray(stressedIndicatorIds)) {
    return false;
  }
  const stressedFromStates = indicatorStates
    .filter((indicator) => indicator.state === "stressed")
    .map((indicator) => indicator.id);
  const availableFromStates = indicatorStates.filter(
    (indicator) => indicator.state === "healthy" ||
      indicator.state === "stressed",
  ).length;
  const hasUnknownState = indicatorStates.some(
    (indicator) => indicator.state === "unknown",
  );
  return stressedFromStates.length === observation.stressedIndicatorCount &&
    (hasUnknownState ||
      availableFromStates === observation.availableIndicatorCount) &&
    stressedFromStates.every((id) => stressedIndicatorIds.includes(id)) &&
    stressedIndicatorIds.every((id) => stressedFromStates.includes(id));
}

function isLegacyShadowState(
  value: unknown,
  market: string,
): value is LegacyShadowState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<LegacyShadowState>;
  return (
    (candidate.version === 2 || candidate.version === 3) &&
    candidate.market === market &&
    Array.isArray(candidate.sessions) &&
    candidate.sessions.every((session) =>
      typeof session === "object" &&
      session !== null &&
      typeof session.sessionKey === "string" &&
      Array.isArray(session.observations) &&
      session.observations.every(isLegacyObservation)
    )
  );
}

function isLegacyObservation(value: unknown): value is LegacyShadowObservation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<LegacyShadowObservation>;
  return (
    isFiniteNumber(candidate.timestamp) &&
    isFiniteNumber(candidate.price) &&
    Number(candidate.price) > 0 &&
    (candidate.v1Level === "resilient" ||
      candidate.v1Level === "fragile" ||
      candidate.v1Level === "breaking" ||
      candidate.v1Level === "panic") &&
    isNonNegativeInteger(candidate.stressedIndicatorCount) &&
    isNonNegativeInteger(candidate.availableIndicatorCount) &&
    isNonNegativeInteger(candidate.breakingStreak) &&
    (candidate.breakingStatus === "BELOW_THRESHOLD" ||
      candidate.breakingStatus === "PENDING" ||
      candidate.breakingStatus === "CONFIRMED")
  );
}

function isTransition(value: unknown): value is MarketFragilityTransition {
  return value === "UNAVAILABLE" || value === "STABLE" ||
    value === "NEW_BREAK" || value === "ESCALATING" ||
    value === "PERSISTENT" || value === "ROTATING" ||
    value === "IMPROVING" || value === "RECOVERED" ||
    value === "RELAPSE" || value === "NON_COMPARABLE";
}

function isContinuityBreakReason(
  value: unknown,
): value is MarketFragilityContinuityBreakReason | null {
  return value === null || value === "first_observation" ||
    value === "missing_expected_brief" || value === "coverage_changed" ||
    value === "measurement_changed" || value === "legacy_unknown";
}

function isIndicatorObservationArray(
  value: unknown,
): value is MarketFragilityIndicatorObservation[] {
  if (!Array.isArray(value) || value.length !== indicatorIds().length) {
    return false;
  }
  const valid = value.every((indicator) => {
      if (typeof indicator !== "object" || indicator === null) {
        return false;
      }
      const candidate = indicator as Partial<MarketFragilityIndicatorObservation>;
      if (!isIndicatorId(candidate.id)) {
        return false;
      }
      if (candidate.state === "healthy" || candidate.state === "stressed") {
        return candidate.unavailableReason === null;
      }
      if (candidate.state === "unavailable") {
        return isUnavailableReason(candidate.unavailableReason);
      }
      return candidate.state === "unknown" &&
        candidate.unavailableReason === "legacy_unknown";
    });
  return valid && new Set(value.map((indicator) => indicator.id)).size ===
    indicatorIds().length;
}

function isUnavailableReason(
  value: unknown,
): value is MarketFragilityUnavailableReason {
  return value === "insufficient_price_candles" ||
    value === "invalid_session_open" || value === "invalid_atr" ||
    value === "zero_session_range" ||
    value === "insufficient_return_history" ||
    value === "insufficient_asset_context" ||
    value === "missing_cross_asset_context";
}

function indicatorIds(): MarketFragilityIndicatorId[] {
  return [
    "session_loss",
    "vwap_repair_failure",
    "poor_close_location",
    "downside_tail_cluster",
    "mega_cap_breadth",
    "equity_cross_confirmation",
  ];
}

function isIndicatorIdArray(
  value: unknown,
): value is MarketFragilityIndicatorId[] {
  return Array.isArray(value) && value.every(isIndicatorId);
}

function isIndicatorId(value: unknown): value is MarketFragilityIndicatorId {
  return value === "session_loss" || value === "vwap_repair_failure" ||
    value === "poor_close_location" || value === "downside_tail_cluster" ||
    value === "mega_cap_breadth" ||
    value === "equity_cross_confirmation";
}

function isMechanismFamilyArray(
  value: unknown,
): value is MarketFragilityMechanismFamily[] {
  return Array.isArray(value) && value.every((family) =>
    family === "price_damage" || family === "repair_failure" ||
    family === "breadth" || family === "cross_market_confirmation"
  );
}
