import { analyzeMarketFragility } from "./market-fragility";
import type {
  Candle,
  MarketFragilityIndicatorId,
  MarketFragilityIndicatorState,
  MarketFragilityLevel,
  MarketFragilityUnavailableReason,
} from "./types";

const STATE_PREFIX = "rth-shadow-acquisition-5m";
const STATE_VERSION = 1 as const;
const MEASUREMENT_VERSION = "market-fragility-price-only/v1" as const;
const MAX_OBSERVATIONS_PER_SESSION = 78;
const MAX_RETAINED_SESSIONS = 60;
export const MAX_RTH_SHADOW_STATE_BYTES = 8 * 1024 * 1024;
const PRICE_INDICATOR_IDS = new Set<MarketFragilityIndicatorId>([
  "session_loss",
  "vwap_repair_failure",
  "poor_close_location",
  "downside_tail_cluster",
]);

export interface RthShadowPriceIndicator {
  id: MarketFragilityIndicatorId;
  state: MarketFragilityIndicatorState;
  value: number | null;
  unavailableReason: MarketFragilityUnavailableReason | null;
}

export interface RthShadowObservation {
  candleEndTime: number;
  acquiredAt: number;
  close: number;
  level: MarketFragilityLevel;
  score: number | null;
  availablePriceIndicatorCount: number;
  priceIndicators: RthShadowPriceIndicator[];
  context: {
    status: "not_collected";
    fetchedAt: null;
    providerTimestamp: null;
    availableIndicatorCount: 0;
  };
}

export interface RthShadowObservationCandidate extends RthShadowObservation {
  sessionKey: string;
}

export interface RthShadowSession {
  sessionKey: string;
  observations: RthShadowObservation[];
}

export interface RthShadowAcquisitionState {
  version: 1;
  measurementVersion: typeof MEASUREMENT_VERSION;
  source: "hyperliquid";
  market: string;
  intervalMinutes: 5;
  sessions: RthShadowSession[];
}

export interface RthShadowAcquisitionUpdate {
  state: RthShadowAcquisitionState | null;
  changed: boolean;
  recordedObservationCount: number;
  ignoredObservationCount: number;
  recoveredCorruptState: boolean;
  serializedBytes: number;
}

/**
 * Build price-only observations from one already-fetched SP500 candle response.
 *
 * Each row keeps its actual acquisition time. Catch-up rows therefore remain
 * distinguishable from observations acquired at their five-minute boundary.
 */
export function buildRthShadowObservations(
  candles: readonly Candle[],
  acquiredAt: number,
): RthShadowObservationCandidate[] {
  const firstCandle = candles[0];
  if (firstCandle === undefined) {
    return [];
  }
  const sessionKey = new Date(firstCandle.startTime).toISOString().slice(0, 10);
  return candles.map((candle, index) => {
    const snapshot = analyzeMarketFragility(candles.slice(0, index + 1), [], {
      evaluatedAt: acquiredAt,
      sessionScope: "rth",
    });
    const priceIndicators = snapshot.indicators
      .filter((indicator) => PRICE_INDICATOR_IDS.has(indicator.id))
      .map((indicator) => ({
        id: indicator.id,
        state: indicator.state,
        value: indicator.value,
        unavailableReason: indicator.unavailableReason,
      }));
    return {
      sessionKey,
      candleEndTime: candle.endTime,
      acquiredAt,
      close: candle.close,
      level: snapshot.level,
      score: snapshot.score,
      availablePriceIndicatorCount: priceIndicators.filter(
        (indicator) => indicator.state !== "unavailable",
      ).length,
      priceIndicators,
      context: {
        status: "not_collected",
        fetchedAt: null,
        providerTimestamp: null,
        availableIndicatorCount: 0,
      },
    };
  });
}

/** Merge new rows into the bounded, independent five-minute state. */
export function mergeRthShadowAcquisitionState(
  previous: RthShadowAcquisitionState | null,
  market: string,
  candidates: readonly RthShadowObservationCandidate[],
): {
  state: RthShadowAcquisitionState;
  recordedObservationCount: number;
  ignoredObservationCount: number;
  serializedBytes: number;
} {
  const sessions = new Map(
    (previous?.sessions ?? []).map((session) => [
      session.sessionKey,
      { ...session, observations: [...session.observations] },
    ]),
  );
  let recordedObservationCount = 0;
  let ignoredObservationCount = 0;

  for (const candidate of [...candidates].sort(
    (left, right) => left.candleEndTime - right.candleEndTime,
  )) {
    const session = sessions.get(candidate.sessionKey) ?? {
      sessionKey: candidate.sessionKey,
      observations: [],
    };
    const latestTimestamp = session.observations.at(-1)?.candleEndTime ?? -1;
    if (candidate.candleEndTime <= latestTimestamp) {
      ignoredObservationCount += 1;
      continue;
    }
    session.observations.push(toStoredObservation(candidate));
    session.observations = session.observations.slice(
      -MAX_OBSERVATIONS_PER_SESSION,
    );
    sessions.set(candidate.sessionKey, session);
    recordedObservationCount += 1;
  }

  const state: RthShadowAcquisitionState = {
    version: STATE_VERSION,
    measurementVersion: MEASUREMENT_VERSION,
    source: "hyperliquid",
    market,
    intervalMinutes: 5,
    sessions: [...sessions.values()]
      .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey))
      .slice(-MAX_RETAINED_SESSIONS),
  };
  trimToByteCeiling(state);
  return {
    state,
    recordedObservationCount,
    ignoredObservationCount,
    serializedBytes: serializedByteLength(state),
  };
}

/** Persist one acquisition batch with one KV read and at most one KV write. */
export async function recordRthShadowAcquisition(
  storage: KVNamespace | undefined,
  market: string,
  acquiredAt: number,
  candles: readonly Candle[],
): Promise<RthShadowAcquisitionUpdate> {
  if (storage === undefined) {
    return {
      state: null,
      changed: false,
      recordedObservationCount: 0,
      ignoredObservationCount: 0,
      recoveredCorruptState: false,
      serializedBytes: 0,
    };
  }
  const key = rthShadowAcquisitionKey(market);
  const rawState = await storage.get(key);
  const previous = parseState(rawState, market);
  const merged = mergeRthShadowAcquisitionState(
    previous,
    market,
    buildRthShadowObservations(candles, acquiredAt),
  );
  const serialized = JSON.stringify(merged.state);
  const changed = serialized !== rawState;
  if (changed) {
    await storage.put(key, serialized);
  }
  return {
    ...merged,
    changed,
    recoveredCorruptState: rawState !== null && previous === null,
  };
}

/** Export a snapshot as self-describing NDJSON for private offline research. */
export function exportRthShadowAcquisition(
  state: RthShadowAcquisitionState,
): string {
  return state.sessions.flatMap((session) =>
    session.observations.map((observation) => JSON.stringify({
      schemaVersion: state.version,
      measurementVersion: state.measurementVersion,
      source: state.source,
      market: state.market,
      intervalMinutes: state.intervalMinutes,
      sessionKey: session.sessionKey,
      ...observation,
    })),
  ).join("\n");
}

export function rthShadowAcquisitionKey(market: string): string {
  return `${STATE_PREFIX}:v${STATE_VERSION}:${market}`;
}

function trimToByteCeiling(state: RthShadowAcquisitionState): void {
  while (
    state.sessions.length > 0 &&
    serializedByteLength(state) > MAX_RTH_SHADOW_STATE_BYTES
  ) {
    const oldest = state.sessions[0];
    if (oldest !== undefined && oldest.observations.length > 1) {
      oldest.observations.shift();
    } else {
      state.sessions.shift();
    }
  }
}

function serializedByteLength(state: RthShadowAcquisitionState): number {
  return new TextEncoder().encode(JSON.stringify(state)).byteLength;
}

function parseState(
  rawState: string | null,
  market: string,
): RthShadowAcquisitionState | null {
  if (rawState === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rawState);
    return isState(parsed, market) ? parsed : null;
  } catch {
    return null;
  }
}

function isState(
  value: unknown,
  market: string,
): value is RthShadowAcquisitionState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<RthShadowAcquisitionState>;
  return (
    candidate.version === STATE_VERSION &&
    candidate.measurementVersion === MEASUREMENT_VERSION &&
    candidate.source === "hyperliquid" &&
    candidate.market === market &&
    candidate.intervalMinutes === 5 &&
    Array.isArray(candidate.sessions) &&
    candidate.sessions.length <= MAX_RETAINED_SESSIONS &&
    candidate.sessions.every(isSession) &&
    serializedByteLength(candidate as RthShadowAcquisitionState) <=
      MAX_RTH_SHADOW_STATE_BYTES
  );
}

function isSession(value: unknown): value is RthShadowSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const session = value as Partial<RthShadowSession>;
  return (
    typeof session.sessionKey === "string" &&
    Array.isArray(session.observations) &&
    session.observations.length <= MAX_OBSERVATIONS_PER_SESSION &&
    session.observations.every(isObservation)
  );
}

function isObservation(value: unknown): value is RthShadowObservation {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const observation = value as Partial<RthShadowObservation>;
  return (
    Number.isFinite(observation.candleEndTime) &&
    Number.isFinite(observation.acquiredAt) &&
    Number.isFinite(observation.close) &&
    isFragilityLevel(observation.level) &&
    (observation.score === null || Number.isFinite(observation.score)) &&
    Number.isInteger(observation.availablePriceIndicatorCount) &&
    Array.isArray(observation.priceIndicators) &&
    observation.priceIndicators.length === PRICE_INDICATOR_IDS.size &&
    observation.priceIndicators.every(isPriceIndicator) &&
    new Set(
      observation.priceIndicators.map((indicator) => indicator.id),
    ).size === PRICE_INDICATOR_IDS.size &&
    observation.availablePriceIndicatorCount ===
      observation.priceIndicators.filter(
        (indicator) => indicator.state !== "unavailable",
      ).length &&
    observation.context?.status === "not_collected" &&
    observation.context.fetchedAt === null &&
    observation.context.providerTimestamp === null &&
    observation.context.availableIndicatorCount === 0
  );
}

function toStoredObservation(
  candidate: RthShadowObservationCandidate,
): RthShadowObservation {
  return {
    candleEndTime: candidate.candleEndTime,
    acquiredAt: candidate.acquiredAt,
    close: candidate.close,
    level: candidate.level,
    score: candidate.score,
    availablePriceIndicatorCount: candidate.availablePriceIndicatorCount,
    priceIndicators: candidate.priceIndicators,
    context: candidate.context,
  };
}

function isPriceIndicator(value: unknown): value is RthShadowPriceIndicator {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const indicator = value as Partial<RthShadowPriceIndicator>;
  return (
    indicator.id !== undefined &&
    PRICE_INDICATOR_IDS.has(indicator.id) &&
    (indicator.state === "healthy" ||
      indicator.state === "stressed" ||
      indicator.state === "unavailable") &&
    (indicator.value === null || Number.isFinite(indicator.value)) &&
    (indicator.unavailableReason === null ||
      typeof indicator.unavailableReason === "string")
  );
}

function isFragilityLevel(value: unknown): value is MarketFragilityLevel {
  return (
    value === "resilient" ||
    value === "fragile" ||
    value === "breaking" ||
    value === "panic" ||
    value === "unknown"
  );
}
