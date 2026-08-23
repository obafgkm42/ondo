import type { ReversalLocation } from "./types";

const LAST_SUCCESSFUL_CANDLE_PREFIX = "last-successful-candle";
const RATE_LIMIT_INCIDENT_PREFIX = "rate-limit-incident";
const SENT_SIGNAL_PREFIX = "sent-signal";
const RATE_LIMIT_INCIDENT_TTL_SECONDS = 6 * 60 * 60;
const RATE_LIMIT_INCIDENT_TTL_MS = RATE_LIMIT_INCIDENT_TTL_SECONDS * 1_000;
const SENT_SIGNAL_TTL_SECONDS = 7 * 24 * 60 * 60;
const inMemoryRateLimitIncidents = new Map<string, number>();

/**
 * Read the latest completed candle covered by a successful notification scan.
 */
export async function getLastSuccessfulCandleEnd(
  state: KVNamespace | undefined,
  market: string,
): Promise<number | null> {
  if (state === undefined) {
    return null;
  }
  const rawValue = await state.get(lastSuccessfulCandleKey(market));
  if (rawValue === null) {
    return null;
  }
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

/**
 * Persist the latest completed candle only after a scan finishes successfully.
 */
export async function setLastSuccessfulCandleEnd(
  state: KVNamespace | undefined,
  market: string,
  candleEndTime: number,
): Promise<void> {
  if (state === undefined) {
    return;
  }
  await state.put(
    lastSuccessfulCandleKey(market),
    String(candleEndTime),
  );
}

/**
 * Return whether this exact market, level, direction, and candle was sent.
 */
export async function wasSignalSent(
  state: KVNamespace | undefined,
  signal: ReversalLocation,
): Promise<boolean> {
  if (state === undefined) {
    return false;
  }
  return (await state.get(sentSignalKey(signal))) !== null;
}

/**
 * Mark an alert after Discord accepts it so retries do not resend it.
 */
export async function markSignalSent(
  state: KVNamespace | undefined,
  signal: ReversalLocation,
): Promise<void> {
  if (state === undefined) {
    return;
  }
  await state.put(sentSignalKey(signal), "1", {
    expirationTtl: SENT_SIGNAL_TTL_SECONDS,
  });
}

/**
 * Return whether a persistent Hyperliquid rate-limit incident is already open.
 */
export async function isRateLimitIncidentActive(
  state: KVNamespace | undefined,
  market: string,
): Promise<boolean> {
  const key = rateLimitIncidentKey(market);
  if (state === undefined) {
    const expiresAt = inMemoryRateLimitIncidents.get(key);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= Date.now()) {
      inMemoryRateLimitIncidents.delete(key);
      return false;
    }
    return true;
  }
  return (await state.get(key)) !== null;
}

/**
 * Open a rate-limit incident after Discord accepts the degradation notice.
 */
export async function markRateLimitIncidentActive(
  state: KVNamespace | undefined,
  market: string,
): Promise<void> {
  const key = rateLimitIncidentKey(market);
  if (state === undefined) {
    inMemoryRateLimitIncidents.set(
      key,
      Date.now() + RATE_LIMIT_INCIDENT_TTL_MS,
    );
    return;
  }
  await state.put(key, "1", {
    expirationTtl: RATE_LIMIT_INCIDENT_TTL_SECONDS,
  });
}

/**
 * Close a rate-limit incident after the next successful scheduled scan.
 */
export async function clearRateLimitIncident(
  state: KVNamespace | undefined,
  market: string,
): Promise<void> {
  const key = rateLimitIncidentKey(market);
  if (state === undefined) {
    inMemoryRateLimitIncidents.delete(key);
    return;
  }
  await state.delete(key);
}

function lastSuccessfulCandleKey(market: string): string {
  return `${LAST_SUCCESSFUL_CANDLE_PREFIX}:${market}`;
}

function rateLimitIncidentKey(market: string): string {
  return `${RATE_LIMIT_INCIDENT_PREFIX}:${market}`;
}

function sentSignalKey(signal: ReversalLocation): string {
  return [
    SENT_SIGNAL_PREFIX,
    signal.market,
    signal.level,
    signal.direction,
    signal.timestamp,
  ].join(":");
}
