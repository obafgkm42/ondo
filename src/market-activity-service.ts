import { fetchFifteenMinuteCandles } from "./hyperliquid";
import {
  aggregateRthVolumeSessions,
  calculateMarketActivitySnapshot,
  completedMarketActivitySessions,
  isMarketActivityBootstrapTime,
  selectCurrentRthVolumeSession,
} from "./market-activity";
import {
  loadMarketActivityState,
  mergeMarketActivityState,
  saveMarketActivityState,
  shouldBootstrapMarketActivity,
} from "./market-activity-state";
import type {
  Candle,
  MarketActivitySession,
  MarketActivitySnapshot,
} from "./types";

const INITIAL_BOOTSTRAP_LOOKBACK_DAYS = 18;
const RETRY_BOOTSTRAP_LOOKBACK_DAYS = 30;

export interface MarketActivityEvaluation {
  snapshot: MarketActivitySnapshot;
  historySessionCount: number;
  stateChanged: boolean;
  stateWritten: boolean;
  recoveredCorruptState: boolean;
  bootstrapAttempted: boolean;
  bootstrapLookbackDays: number | null;
  bootstrapSessionCount: number;
  bootstrapError: string | null;
  approximateCpuMs: number;
}

export interface MarketActivityEvaluationOptions {
  allowBootstrap: boolean;
  /** New Worker versions may prime durable history before the post-close window. */
  bootstrapImmediately?: boolean;
  /** Manual status paths can reuse durable history without mutating it. */
  persistState?: boolean;
  fetchBootstrapCandles?: (
    market: string,
    timestamp: Date,
    lookbackDays: number,
  ) => Promise<Candle[]>;
}

/**
 * Evaluate RVOL with one KV read, at most one write, and optional bootstrap I/O.
 *
 * Optional provider failures are returned as diagnostics and never escape into
 * the signal-delivery path.
 */
export async function evaluateMarketActivity(
  namespace: KVNamespace | undefined,
  market: string,
  fiveMinuteCandles: readonly Candle[],
  timestamp: Date,
  options: MarketActivityEvaluationOptions,
): Promise<MarketActivityEvaluation> {
  const loaded = await loadMarketActivityState(namespace, market);
  let approximateCpuMs = 0;
  let processingStartedAt = performance.now();
  const currentSessions = aggregateRthVolumeSessions(fiveMinuteCandles, 5);
  const currentSession = selectCurrentRthVolumeSession(
    currentSessions,
    timestamp,
  );
  const completedCurrentSessions = completedMarketActivitySessions(
    currentSessions,
  );
  let metricHistory = mergeMetricSessions(
    loaded.state.completedSessions,
    completedCurrentSessions,
  );
  let nextState = mergeMarketActivityState(
    loaded.state,
    completedCurrentSessions,
  );
  approximateCpuMs += elapsedMilliseconds(processingStartedAt);

  let bootstrapAttempted = false;
  let bootstrapLookbackDays: number | null = null;
  let bootstrapSessionCount = 0;
  let bootstrapError: string | null = null;
  if (
    options.allowBootstrap &&
    loaded.persistent &&
    (options.bootstrapImmediately === true ||
      isMarketActivityBootstrapTime(timestamp)) &&
    shouldBootstrapMarketActivity(nextState, timestamp)
  ) {
    bootstrapAttempted = true;
    bootstrapLookbackDays = nextState.bootstrapAttemptedAt === null
      ? INITIAL_BOOTSTRAP_LOOKBACK_DAYS
      : RETRY_BOOTSTRAP_LOOKBACK_DAYS;
    const fetchBootstrapCandles = options.fetchBootstrapCandles ??
      defaultFetchBootstrapCandles;
    try {
      const bootstrapCandles = await fetchBootstrapCandles(
        market,
        timestamp,
        bootstrapLookbackDays,
      );
      processingStartedAt = performance.now();
      const bootstrapSessions = completedMarketActivitySessions(
        aggregateRthVolumeSessions(bootstrapCandles, 15),
      );
      bootstrapSessionCount = bootstrapSessions.length;
      metricHistory = mergeMetricSessions(metricHistory, bootstrapSessions);
      nextState = mergeMarketActivityState(
        nextState,
        bootstrapSessions,
        timestamp.getTime(),
      );
      approximateCpuMs += elapsedMilliseconds(processingStartedAt);
    } catch (error) {
      bootstrapError = safeErrorName(error);
      nextState = mergeMarketActivityState(
        nextState,
        [],
        timestamp.getTime(),
      );
    }
  }

  processingStartedAt = performance.now();
  const snapshot = calculateMarketActivitySnapshot(
    market,
    currentSession,
    metricHistory,
    timestamp,
  );
  approximateCpuMs += elapsedMilliseconds(processingStartedAt);
  const save = await saveMarketActivityState(
    options.persistState === false ? undefined : namespace,
    market,
    loaded.rawState,
    nextState,
  );

  return {
    snapshot,
    historySessionCount: nextState.completedSessions.length,
    stateChanged: save.changed,
    stateWritten: save.written,
    recoveredCorruptState: loaded.recoveredCorruptState,
    bootstrapAttempted,
    bootstrapLookbackDays,
    bootstrapSessionCount,
    bootstrapError,
    approximateCpuMs,
  };
}

async function defaultFetchBootstrapCandles(
  market: string,
  timestamp: Date,
  lookbackDays: number,
): Promise<Candle[]> {
  return fetchFifteenMinuteCandles(market, timestamp, lookbackDays);
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function mergeMetricSessions(
  existingSessions: readonly MarketActivitySession[],
  candidateSessions: readonly MarketActivitySession[],
): MarketActivitySession[] {
  const sessionsByKey = new Map(
    existingSessions.map((session) => [session.sessionKey, session]),
  );
  for (const session of candidateSessions) {
    sessionsByKey.set(session.sessionKey, session);
  }
  return [...sessionsByKey.values()].sort((left, right) =>
    left.sessionKey.localeCompare(right.sessionKey)
  );
}
