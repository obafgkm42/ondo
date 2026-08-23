import type {
  MarketFragilityIndicatorId,
  MarketFragilitySnapshot,
} from "./types";

// Keep the physical key stable so the v3 schema migrates in place with the
// same one-read/one-write budget as v2.
const SHADOW_STATE_PREFIX = "market-fragility-v2-shadow";
const SHADOW_STATE_VERSION = 3 as const;
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
  | "RELAPSE";

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
  breakingDurationMinutes: number;
  transition: MarketFragilityTransition;
  stressedIndicatorIds: MarketFragilityIndicatorId[];
  persistentIndicatorIds: MarketFragilityIndicatorId[];
  addedIndicatorIds: MarketFragilityIndicatorId[];
  recoveredIndicatorIds: MarketFragilityIndicatorId[];
  stressedFamilyIds: MarketFragilityMechanismFamily[];
  mechanismHistoryAvailable: boolean;
}

export interface MarketFragilityShadowSession {
  sessionKey: string;
  observations: MarketFragilityShadowObservation[];
}

export interface MarketFragilityShadowState {
  version: 3;
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
): MarketFragilityShadowObservation {
  const breakingCandidate =
    snapshot.level === "breaking" || snapshot.level === "panic";
  const breakingStreak = breakingCandidate
    ? (isBreakingObservation(previous) ? previous?.breakingStreak ?? 0 : 0) + 1
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
  const previousStressedIds = previous?.mechanismHistoryAvailable === true
    ? previous.stressedIndicatorIds
    : [];
  const persistentIndicatorIds = intersection(
    stressedIndicatorIds,
    previousStressedIds,
  );
  const addedIndicatorIds = difference(
    stressedIndicatorIds,
    previousStressedIds,
  );
  const recoveredIndicatorIds = difference(
    previousStressedIds,
    stressedIndicatorIds,
  );
  const previousBreaking = isBreakingObservation(previous);
  const breakingStartedAt = breakingCandidate
    ? previousBreaking
      ? previous?.breakingStartedAt ?? previous?.timestamp ?? timestamp
      : timestamp
    : null;
  const breakingDurationMinutes = breakingStartedAt === null
    ? 0
    : Math.max(0, Math.floor((timestamp - breakingStartedAt) / 60_000));
  return {
    timestamp,
    price,
    v1Level: snapshot.level,
    stressedIndicatorCount: snapshot.stressedIndicatorCount,
    availableIndicatorCount: snapshot.availableIndicatorCount,
    breakingStreak,
    breakingStatus,
    breakingStartedAt,
    breakingDurationMinutes,
    transition: classifyTransition(
      snapshot,
      previous,
      breakingCandidate,
      hadEarlierBreaking,
      persistentIndicatorIds,
      addedIndicatorIds,
      recoveredIndicatorIds,
    ),
    stressedIndicatorIds,
    persistentIndicatorIds,
    addedIndicatorIds,
    recoveredIndicatorIds,
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
  persistentIndicatorIds: readonly MarketFragilityIndicatorId[],
  addedIndicatorIds: readonly MarketFragilityIndicatorId[],
  recoveredIndicatorIds: readonly MarketFragilityIndicatorId[],
): MarketFragilityTransition {
  if (previous === undefined) {
    return breakingCandidate ? "NEW_BREAK" : "STABLE";
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
    recoveredIndicatorIds.length > addedIndicatorIds.length
  ) {
    return "IMPROVING";
  }
  if (
    previous.mechanismHistoryAvailable &&
    persistentIndicatorIds.length === 0 &&
    addedIndicatorIds.length > 0 &&
    recoveredIndicatorIds.length > 0
  ) {
    return "ROTATING";
  }
  return "PERSISTENT";
}

function mechanismFamilies(
  indicatorIds: readonly MarketFragilityIndicatorId[],
): MarketFragilityMechanismFamily[] {
  return [...new Set(indicatorIds.map(mechanismFamily))];
}

function intersection(
  current: readonly MarketFragilityIndicatorId[],
  previous: readonly MarketFragilityIndicatorId[],
): MarketFragilityIndicatorId[] {
  const previousIds = new Set(previous);
  return current.filter((id) => previousIds.has(id));
}

function difference(
  left: readonly MarketFragilityIndicatorId[],
  right: readonly MarketFragilityIndicatorId[],
): MarketFragilityIndicatorId[] {
  const rightIds = new Set(right);
  return left.filter((id) => !rightIds.has(id));
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
  version: 2;
  market: string;
  sessions: Array<{
    sessionKey: string;
    observations: LegacyShadowObservation[];
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
          observation.breakingStatus === "BELOW_THRESHOLD"
            ? null
            : observation.timestamp,
        breakingDurationMinutes: 0,
        transition: "UNAVAILABLE",
        stressedIndicatorIds: [],
        persistentIndicatorIds: [],
        addedIndicatorIds: [],
        recoveredIndicatorIds: [],
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
    isIndicatorIdArray(candidate.stressedIndicatorIds) &&
    isIndicatorIdArray(candidate.persistentIndicatorIds) &&
    isIndicatorIdArray(candidate.addedIndicatorIds) &&
    isIndicatorIdArray(candidate.recoveredIndicatorIds) &&
    isMechanismFamilyArray(candidate.stressedFamilyIds) &&
    typeof candidate.mechanismHistoryAvailable === "boolean"
  );
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
    candidate.version === 2 &&
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
    value === "RELAPSE";
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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= 0;
}
