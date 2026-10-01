import { recordMarketFragilityShadow } from "./market-fragility-shadow";
import type { MarketFragilityShadowUpdate } from "./market-fragility-shadow";
import {
  calculateResilienceMetrics,
  updateResilienceDecayStateBatch,
} from "./resilience-decay";
import type { ResilienceDecayUpdate } from "./resilience-decay";
import { recordRthShadowAcquisition } from "./rth-shadow-acquisition";
import {
  isRthClose,
  isTwoHourCheckpointEligible,
  selectAnalysisSession,
} from "./market-hours";
import type {
  Candle,
  MarketFragilitySnapshot,
  ScannerConfig,
  ResiliencePriceSnapshot,
} from "./types";
import { safeErrorName } from "./runtime-validation";

const RESILIENCE_SNAPSHOT_INTERVAL_MS = 30 * 60 * 1_000;
const RESILIENCE_SHADOW_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1_000;
const RESILIENCE_SHADOW_STATE_PREFIX = "resilience-decay-shadow-5m";

export async function maybeRecordMarketFragilityShadow(
  config: ScannerConfig,
  collectionDue: boolean,
  sessionKind: ReturnType<typeof selectAnalysisSession>["kind"],
  sessionCandles: readonly Candle[],
  fragility: MarketFragilitySnapshot,
): Promise<MarketFragilityShadowUpdate | null> {
  if (
    config.fragilityPersistenceMode === "off" ||
    !collectionDue ||
    config.hyperliquidCoin !== "xyz:SP500" ||
    sessionKind !== "rth"
  ) {
    return null;
  }
  const firstCandle = sessionCandles[0];
  const latestCandle = sessionCandles.at(-1);
  if (firstCandle === undefined || latestCandle === undefined) {
    return null;
  }
  try {
    const update = await recordMarketFragilityShadow(
      config.scannerState,
      config.hyperliquidCoin,
      new Date(firstCandle.startTime).toISOString().slice(0, 10),
      latestCandle.endTime,
      latestCandle.close,
      fragility,
      config.briefIntervalMinutes,
    );
    console.log(
      JSON.stringify({
        status: "market_fragility_persistence_shadow",
        market: config.hyperliquidCoin,
        changed: update.changed,
        ignoredReason: update.ignoredReason,
        v1Level: update.observation.v1Level,
        breakingStreak: update.observation.breakingStreak,
        breakingStatus: update.observation.breakingStatus,
        transition: update.observation.transition,
        breakingElapsedMinutes: update.observation.breakingElapsedMinutes,
        breakingObservedDurationMinutes:
          update.observation.breakingObservedDurationMinutes,
        coverageComparable: update.observation.coverageComparable,
        continuousFromPrevious: update.observation.continuousFromPrevious,
        continuityBreakReason: update.observation.continuityBreakReason,
        stressedIndicatorIds: update.observation.stressedIndicatorIds,
        lostCoverageIndicatorIds:
          update.observation.lostCoverageIndicatorIds,
        gainedCoverageIndicatorIds:
          update.observation.gainedCoverageIndicatorIds,
        unavailableIndicators: update.observation.indicatorStates
          .filter((indicator) => indicator.state === "unavailable")
          .map((indicator) => ({
            id: indicator.id,
            reason: indicator.unavailableReason,
          })),
        stressedFamilyIds: update.observation.stressedFamilyIds,
        stressedIndicatorCount:
          update.observation.stressedIndicatorCount,
        retainedSessionCount: update.state?.sessions.length ?? 0,
        pendingSessions: update.metrics.pendingSessions,
        confirmedSessions: update.metrics.confirmedSessions,
        confirmationRate: update.metrics.confirmationRate,
      }),
    );
    return update;
  } catch (error) {
    console.warn(
      JSON.stringify({
        status: "market_fragility_persistence_shadow_degraded",
        market: config.hyperliquidCoin,
        reason: safeErrorName(error),
        effect: "shadow telemetry omitted; frozen classifier continues",
      }),
    );
    return null;
  }
}

export async function maybeRecordResilienceSnapshot(
  config: ScannerConfig,
  collectionEnabled: boolean,
  sessionKind: ReturnType<typeof selectAnalysisSession>["kind"],
  sessionCandles: readonly Candle[],
): Promise<ResilienceDecayUpdate | null> {
  if (
    !collectionEnabled ||
    config.hyperliquidCoin !== "xyz:SP500" ||
    sessionKind !== "rth"
  ) {
    return null;
  }
  const snapshots = buildResilienceSnapshots(sessionCandles);
  if (snapshots.length === 0) {
    return null;
  }
  const latestSnapshot = snapshots.at(-1);
  const update = await updateResilienceDecayStateBatch(
    config.scannerState,
    config.hyperliquidCoin,
    snapshots,
  );
  console.log(
    JSON.stringify({
      status: "resilience_decay_state",
      market: config.hyperliquidCoin,
      sessionKey: latestSnapshot?.sessionKey ?? null,
      changed: update.changed,
      snapshotCount: update.state?.snapshots.length ?? 0,
      candidateSnapshotCount: snapshots.length,
      recordedSnapshotCount: update.recordedSnapshotCount,
      ignoredSnapshotCount: update.ignoredSnapshotCount,
      completedShockCount: update.state?.completedShocks.length ?? 0,
      activeShock: update.state?.activeShock?.id ?? null,
      shockStarted: update.shockStarted,
      shockCompleted: update.shockCompleted,
      ignoredReason: update.ignoredReason,
      approximateCpuMs: update.approximateCpuMs,
    }),
  );
  await maybeRecordFiveMinuteResilienceShadow(config, sessionCandles);
  return update;
}

export async function maybeRecordFiveMinuteResilienceShadow(
  config: ScannerConfig,
  sessionCandles: readonly Candle[],
): Promise<void> {
  if (config.resilienceDecayShadowMode !== "shadow") {
    return;
  }
  const snapshots = buildResilienceSnapshots(
    sessionCandles,
    RESILIENCE_SHADOW_SNAPSHOT_INTERVAL_MS,
  );
  if (snapshots.length === 0) {
    return;
  }
  try {
    const update = await updateResilienceDecayStateBatch(
      config.scannerState,
      config.hyperliquidCoin,
      snapshots,
      {
        keyPrefix: RESILIENCE_SHADOW_STATE_PREFIX,
        requireTwoHourEligibleStart: true,
      },
    );
    const metrics =
      update.state === null
        ? null
        : calculateResilienceMetrics(update.state);
    console.log(
      JSON.stringify({
        status: "resilience_decay_shadow_5m",
        market: config.hyperliquidCoin,
        changed: update.changed,
        candidateSnapshotCount: snapshots.length,
        recordedSnapshotCount: update.recordedSnapshotCount,
        ignoredSnapshotCount: update.ignoredSnapshotCount,
        completedShockCount: update.state?.completedShocks.length ?? 0,
        activeShock: update.state?.activeShock?.id ?? null,
        resilienceStatus: metrics?.status ?? null,
        recentResilience: metrics?.recentResilience ?? null,
        decayDelta: metrics?.decayDelta ?? null,
        scoredShockCount: metrics?.scoredShockCount ?? 0,
        unscoredShockCount: metrics?.unscoredShockCount ?? 0,
        lateStartPolicy: "two_hour_eligible_only",
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        status: "resilience_decay_shadow_5m_degraded",
        market: config.hyperliquidCoin,
        reason: safeErrorName(error),
        effect: "five-minute shadow omitted; live half-hour state continues",
      }),
    );
  }
}

export async function maybeRecordRthShadowAcquisition(
  config: ScannerConfig,
  collectionDue: boolean,
  sessionCandles: readonly Candle[],
  acquiredAt: Date,
): Promise<void> {
  if (
    !collectionDue ||
    config.fiveMinuteRthAcquisitionMode !== "shadow" ||
    config.hyperliquidCoin !== "xyz:SP500"
  ) {
    return;
  }
  try {
    const update = await recordRthShadowAcquisition(
      config.scannerState,
      config.hyperliquidCoin,
      acquiredAt.getTime(),
      sessionCandles,
    );
    console.log(JSON.stringify({
      status: "rth_shadow_acquisition_5m",
      market: config.hyperliquidCoin,
      changed: update.changed,
      recordedObservationCount: update.recordedObservationCount,
      ignoredObservationCount: update.ignoredObservationCount,
      retainedSessionCount: update.state?.sessions.length ?? 0,
      serializedBytes: update.serializedBytes,
      recoveredCorruptState: update.recoveredCorruptState,
      liveEffect: "none",
    }));
  } catch (error) {
    console.warn(JSON.stringify({
      status: "rth_shadow_acquisition_state_degraded",
      market: config.hyperliquidCoin,
      reason: safeErrorName(error),
      effect: "five-minute shadow omitted; live state remains unchanged",
    }));
  }
}

/**
 * Build the fixed half-hour RTH sampling grid from completed five-minute
 * candles. Rebuilding the candidates on every scheduled scan lets the state
 * writer catch up missed boundaries without additional provider requests.
 */
function buildResilienceSnapshots(
  sessionCandles: readonly Candle[],
  snapshotIntervalMs = RESILIENCE_SNAPSHOT_INTERVAL_MS,
): ResiliencePriceSnapshot[] {
  const firstCandle = sessionCandles[0];
  if (firstCandle === undefined) {
    return [];
  }
  const sessionKey = new Date(firstCandle.startTime)
    .toISOString()
    .slice(0, 10);
  const snapshots: ResiliencePriceSnapshot[] = [];
  let sessionHigh = Number.NEGATIVE_INFINITY;
  let sessionLow = Number.POSITIVE_INFINITY;

  for (const candle of sessionCandles) {
    sessionHigh = Math.max(sessionHigh, candle.high);
    sessionLow = Math.min(sessionLow, candle.low);
    const boundaryTimestamp = candle.endTime + 1;
    if (boundaryTimestamp % snapshotIntervalMs !== 0) {
      continue;
    }
    snapshots.push({
      sessionKey,
      timestamp: candle.endTime,
      price: candle.close,
      sessionHigh,
      sessionLow,
      isSessionClose: isRthClose(new Date(boundaryTimestamp)),
      twoHourCheckpointEligible: isTwoHourCheckpointEligible(
        new Date(boundaryTimestamp),
      ),
    });
  }
  return snapshots;
}
