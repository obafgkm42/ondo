import {
  MARKET_ACTIVITY_INTERVAL_MINUTES,
  MARKET_ACTIVITY_MAX_HISTORY_SESSIONS,
  MARKET_ACTIVITY_SLOT_COUNT,
} from "./market-activity";
import type {
  MarketActivitySession,
  MarketActivityState,
} from "./types";
import { isStandardUsEquityRthSession } from "./us-market-calendar";

const MARKET_ACTIVITY_STATE_PREFIX = "market-activity:v1";
const MARKET_ACTIVITY_STATE_VERSION = 1 as const;
const MINIMUM_BOOTSTRAP_SESSIONS = 10;
const BOOTSTRAP_RETRY_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export interface LoadedMarketActivityState {
  state: MarketActivityState;
  rawState: string | null;
  persistent: boolean;
  recoveredCorruptState: boolean;
}

export interface SavedMarketActivityState {
  changed: boolean;
  written: boolean;
}

/** Load and validate the bounded activity history with one optional KV read. */
export async function loadMarketActivityState(
  namespace: KVNamespace | undefined,
  market: string,
): Promise<LoadedMarketActivityState> {
  if (namespace === undefined) {
    return {
      state: emptyMarketActivityState(market),
      rawState: null,
      persistent: false,
      recoveredCorruptState: false,
    };
  }
  const rawState = await namespace.get(marketActivityStateKey(market));
  if (rawState === null) {
    return {
      state: emptyMarketActivityState(market),
      rawState,
      persistent: true,
      recoveredCorruptState: false,
    };
  }
  const parsedState = parseMarketActivityState(rawState, market);
  return {
    state: parsedState ?? emptyMarketActivityState(market),
    rawState,
    persistent: true,
    recoveredCorruptState: parsedState === null,
  };
}

/**
 * Merge complete sessions and an optional bootstrap checkpoint without I/O.
 *
 * New observations replace the same session key, then the newest 60 sessions
 * are retained in chronological order.
 */
export function mergeMarketActivityState(
  state: MarketActivityState,
  sessions: readonly MarketActivitySession[],
  bootstrapAttemptedAt?: number,
): MarketActivityState {
  const sessionsByKey = new Map(
    state.completedSessions
      .filter(isEligibleMarketActivitySession)
      .map((session) => [session.sessionKey, session]),
  );
  for (const session of sessions) {
    if (isEligibleMarketActivitySession(session)) {
      sessionsByKey.set(session.sessionKey, {
        sessionKey: session.sessionKey,
        slotVolumes: [...session.slotVolumes],
      });
    }
  }
  const completedSessions = [...sessionsByKey.values()]
    .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey))
    .slice(-MARKET_ACTIVITY_MAX_HISTORY_SESSIONS);
  const nextBootstrapAttemptedAt =
    bootstrapAttemptedAt !== undefined &&
      Number.isFinite(bootstrapAttemptedAt) &&
      bootstrapAttemptedAt >= 0
      ? bootstrapAttemptedAt
      : state.bootstrapAttemptedAt;
  return {
    version: MARKET_ACTIVITY_STATE_VERSION,
    market: state.market,
    intervalMinutes: MARKET_ACTIVITY_INTERVAL_MINUTES,
    bootstrapAttemptedAt: nextBootstrapAttemptedAt,
    completedSessions,
  };
}

/** Persist a prepared state with no additional read and at most one write. */
export async function saveMarketActivityState(
  namespace: KVNamespace | undefined,
  market: string,
  loadedRawState: string | null,
  state: MarketActivityState,
): Promise<SavedMarketActivityState> {
  const serializedState = JSON.stringify(state);
  if (
    loadedRawState === null &&
    state.bootstrapAttemptedAt === null &&
    state.completedSessions.length === 0
  ) {
    return { changed: false, written: false };
  }
  const changed = serializedState !== loadedRawState;
  if (namespace === undefined || !changed) {
    return { changed, written: false };
  }
  await namespace.put(marketActivityStateKey(market), serializedState);
  return { changed: true, written: true };
}

/** Limit failed or underfilled bootstrap requests to one attempt per day. */
export function shouldBootstrapMarketActivity(
  state: MarketActivityState,
  timestamp: Date,
): boolean {
  if (state.completedSessions.length >= MINIMUM_BOOTSTRAP_SESSIONS) {
    return false;
  }
  return (
    state.bootstrapAttemptedAt === null ||
    timestamp.getTime() - state.bootstrapAttemptedAt >=
      BOOTSTRAP_RETRY_INTERVAL_MS
  );
}

/** Stable KV key for one provider market. */
export function marketActivityStateKey(market: string): string {
  return `${MARKET_ACTIVITY_STATE_PREFIX}:${market}`;
}

function emptyMarketActivityState(market: string): MarketActivityState {
  return {
    version: MARKET_ACTIVITY_STATE_VERSION,
    market,
    intervalMinutes: MARKET_ACTIVITY_INTERVAL_MINUTES,
    bootstrapAttemptedAt: null,
    completedSessions: [],
  };
}

function parseMarketActivityState(
  rawState: string,
  market: string,
): MarketActivityState | null {
  try {
    const parsed: unknown = JSON.parse(rawState);
    if (!isMarketActivityState(parsed, market)) {
      return null;
    }
    return mergeMarketActivityState(
      {
        ...parsed,
        completedSessions: [],
      },
      parsed.completedSessions,
    );
  } catch {
    return null;
  }
}

function isMarketActivityState(
  value: unknown,
  market: string,
): value is MarketActivityState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<MarketActivityState>;
  return (
    candidate.version === MARKET_ACTIVITY_STATE_VERSION &&
    candidate.market === market &&
    candidate.intervalMinutes === MARKET_ACTIVITY_INTERVAL_MINUTES &&
    (candidate.bootstrapAttemptedAt === null ||
      (typeof candidate.bootstrapAttemptedAt === "number" &&
        Number.isFinite(candidate.bootstrapAttemptedAt) &&
        candidate.bootstrapAttemptedAt >= 0)) &&
    Array.isArray(candidate.completedSessions) &&
    candidate.completedSessions.every(isStoredMarketActivitySession)
  );
}

function isEligibleMarketActivitySession(
  value: unknown,
): value is MarketActivitySession {
  return (
    isStoredMarketActivitySession(value) &&
    isStandardUsEquityRthSession(value.sessionKey)
  );
}

function isStoredMarketActivitySession(
  value: unknown,
): value is MarketActivitySession {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const session = value as Partial<MarketActivitySession>;
  return (
    typeof session.sessionKey === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(session.sessionKey) &&
    Array.isArray(session.slotVolumes) &&
    session.slotVolumes.length === MARKET_ACTIVITY_SLOT_COUNT &&
    session.slotVolumes.every(
      (volume) =>
        typeof volume === "number" &&
        Number.isFinite(volume) &&
        volume >= 0,
    )
  );
}
