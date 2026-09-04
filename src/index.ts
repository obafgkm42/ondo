import { renderMarketBriefChart } from "./chart";
import { loadConfig } from "./config";
import { handleDiscordInteraction } from "./discord-interactions";
import {
  publicScanResult,
  sendMarketBrief,
  sendRateLimitNotice,
  sendSignal,
  sendVersionNotice,
} from "./discord";
import {
  fetchXyzStockCoins,
  fetchFiveMinuteCandles,
  fetchXyzMarketContexts,
  HyperliquidRateLimitError,
} from "./hyperliquid";
import {
  isMarketActivityBootstrapTime,
  isMarketActivityEvaluationTime,
} from "./market-activity";
import { evaluateMarketActivity } from "./market-activity-service";
import { assessMarketDataHealth } from "./market-data-health";
import {
  analyzeMarketFragility,
  FRAGILITY_CONTEXT_COINS,
} from "./market-fragility";
import { recordMarketFragilityShadow } from "./market-fragility-shadow";
import type {
  MarketFragilityPersistenceBrief,
  MarketFragilityShadowUpdate,
} from "./market-fragility-shadow";
import {
  getBriefIntervalMinutes,
  getPreviousScanTime,
  getScheduleDecision,
  isRthClose,
  isTwoHourCheckpointEligible,
  selectAnalysisSession,
} from "./market-hours";
import {
  calculateResilienceMetrics,
  updateResilienceDecayStateBatch,
} from "./resilience-decay";
import type { ResilienceDecayUpdate } from "./resilience-decay";
import {
  clearRateLimitIncident,
  getLastSuccessfulCandleEnd,
  isRateLimitIncidentActive,
  markRateLimitIncidentActive,
  markSignalSent,
  setLastSuccessfulCandleEnd,
  wasSignalSent,
} from "./scanner-state";
import {
  analyzeSession,
  findNotificationOpportunities,
} from "./signal-engine";
import type {
  AnalysisThresholds,
  Candle,
  Env,
  MarketActivitySnapshot,
  MarketDataHealth,
  MarketFragilitySnapshot,
  ResiliencePriceSnapshot,
  ScanResult,
  ScannerConfig,
} from "./types";

const VERSION_NOTICE_KEY = "last-version-notice";
const RECENT_VERSION_NOTICE_WINDOW_MS = 20 * 60 * 1000;
const RESILIENCE_SNAPSHOT_INTERVAL_MS = 30 * 60 * 1_000;
const RESILIENCE_SHADOW_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1_000;
const RESILIENCE_SHADOW_STATE_PREFIX = "resilience-decay-shadow-5m";
let lastVersionNoticeSentFor: string | null = null;

interface ScanExecutionResult {
  scan: ScanResult;
  fragility: MarketFragilitySnapshot | null;
  activity: MarketActivitySnapshot | null;
  dataHealth: MarketDataHealth;
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    const config = loadConfig(env);
    const now = new Date(controller.scheduledTime);
    const decision = getScheduleDecision(now, config);
    const briefIntervalMinutes = getBriefIntervalMinutes(
      now,
      config.briefIntervalMinutes,
    );
    const briefDue = isBriefDue(now, briefIntervalMinutes);
    const versionChanged = hasWorkerVersionChanged(config);
    context.waitUntil(maybeSendVersionNotice(config, now, versionChanged));
    const fallbackNotificationWindowStart = decision.shouldRun
      ? getPreviousScanTime(now, config)
      : null;
    context.waitUntil(
      versionChanged.then(async (changed) => {
        const bootstrapImmediately =
          changed && config.marketActivityMode !== "off";
        if (!decision.shouldRun && !briefDue) {
          if (bootstrapImmediately) {
            await bootstrapMarketActivityForNewVersion(config, now);
          } else {
            console.log(`scan skipped: ${decision.reason}`);
          }
          return;
        }
        await runScheduledScan(
          config,
          now,
          decision.shouldRun,
          briefDue,
          fallbackNotificationWindowStart,
          bootstrapImmediately,
        );
      }),
    );
  },

  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname === "/discord/interactions"
    ) {
      const config = loadConfig(env);
      return handleDiscordInteraction(request, {
        publicKey: env.DISCORD_APPLICATION_PUBLIC_KEY,
        allowedGuildId: env.DISCORD_GUILD_ID,
        language: config.language,
        getStatus: () =>
          runScan(config, new Date(), false, false, null, false),
        waitUntil: (promise) => context.waitUntil(promise),
      });
    }
    if (request.method !== "GET" || url.pathname !== "/scan") {
      return Response.json(
        {
          service: "hyperliquid-sp500-reversal-scanner",
          endpoint: "GET /scan",
          execution: "read-only alerts; no order placement",
        },
        { status: 200 },
      );
    }
    if (
      env.MANUAL_SCAN_TOKEN === undefined ||
      request.headers.get("Authorization") !==
        `Bearer ${env.MANUAL_SCAN_TOKEN}`
    ) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    try {
      const config = loadConfig(env);
      const execution = await runScan(
        config,
        new Date(),
        false,
        false,
        null,
        false,
      );
      return Response.json(
        publicScanResult(
          execution.scan,
          config.language,
          execution.fragility ?? undefined,
          execution.activity ?? undefined,
          execution.dataHealth,
        ),
      );
    } catch (error) {
      console.error("manual scan failed", safeErrorName(error));
      return Response.json({ error: "scan failed" }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;

async function runScan(
  config: ScannerConfig,
  now: Date,
  notify: boolean,
  sendBrief: boolean,
  notificationWindowStart: Date | null,
  scheduledExecution: boolean,
  bootstrapActivityImmediately = false,
): Promise<ScanExecutionResult> {
  const candles = await fetchFiveMinuteCandles(
    config.hyperliquidCoin,
    now,
  );
  const analysisSession = selectAnalysisSession(candles, now);
  const sessionCandles = analysisSession.candles;
  const dataHealth = assessMarketDataHealth(
    sessionCandles,
    now,
    analysisSession.kind,
  );
  console.log(
    JSON.stringify({
      status: "market_data_health",
      market: config.hyperliquidCoin,
      dataStatus: dataHealth.status,
      sessionScope: dataHealth.sessionScope,
      stateEligible: dataHealth.stateEligible,
      candleCount: dataHealth.candleCount,
      latestEndTime:
        dataHealth.latestEndTime === null
          ? null
          : new Date(dataHealth.latestEndTime).toISOString(),
      expectedLatestEndTime: new Date(
        dataHealth.expectedLatestEndTime,
      ).toISOString(),
      lagIntervals: dataHealth.lagIntervals,
      gapCount: dataHealth.gapCount,
      missingIntervals: dataHealth.missingIntervals,
      reasons: dataHealth.reasons,
    }),
  );
  const thresholds: AnalysisThresholds = {
    minimumWatchPriceR: config.minimumWatchPriceR,
    minimumWatchConfidenceScore: config.minimumWatchConfidenceScore,
    minimumPriceR: config.minimumPriceR,
    minimumConfidenceScore: config.minimumConfidenceScore,
  };
  const result = analyzeSession(
    config.hyperliquidCoin,
    sessionCandles,
    thresholds,
  );
  const resilienceUpdate = await maybeRecordResilienceSnapshot(
    config,
    (notify || sendBrief) && dataHealth.stateEligible,
    analysisSession.kind,
    sessionCandles,
  );
  const resilienceMetrics =
    resilienceUpdate?.state !== null &&
    resilienceUpdate?.state !== undefined
      ? calculateResilienceMetrics(resilienceUpdate.state)
      : undefined;
  if (
    resilienceMetrics !== undefined
  ) {
    console.log(
      JSON.stringify({
        status: "resilience_decay_metrics",
        market: config.hyperliquidCoin,
        resilienceStatus: resilienceMetrics.status,
        recentResilience: resilienceMetrics.recentResilience,
        baselineResilience: resilienceMetrics.baselineResilience,
        decayDelta: resilienceMetrics.decayDelta,
        recentEventScoreSlope: resilienceMetrics.recentEventScoreSlope,
        decayScore: resilienceMetrics.decayScore,
        scoredShockCount: resilienceMetrics.scoredShockCount,
        unscoredShockCount: resilienceMetrics.unscoredShockCount,
      }),
    );
  }
  const notificationOpportunities =
    notify &&
    analysisSession.notificationsEnabled &&
    dataHealth.stateEligible &&
    notificationWindowStart !== null
      ? findNotificationOpportunities(
          config.hyperliquidCoin,
          sessionCandles,
          thresholds,
          notificationWindowStart.getTime(),
          now.getTime(),
        )
      : [];
  let fragility = !notify
    ? await calculateMarketFragility(sessionCandles)
    : null;
  console.log(
    JSON.stringify({
      market: result.market,
      candleCount: result.candleCount,
      status: result.status,
      watch: result.watch?.direction ?? null,
      signal: result.signal?.direction ?? null,
      analysisSession: analysisSession.kind,
      notificationsEnabled: analysisSession.notificationsEnabled,
      evaluatedNewCandles:
        notificationWindowStart === null
          ? 0
          : sessionCandles.filter(
              (candle) =>
                candle.endTime >= notificationWindowStart.getTime(),
            ).length,
      notificationTimestamps: notificationOpportunities.map(
        (opportunity) => ({
          signalTime: new Date(
            opportunity.signal.timestamp,
          ).toISOString(),
          observedAt: new Date(opportunity.observedAt).toISOString(),
          observedPrice: opportunity.observedPrice,
          status: opportunity.status,
        }),
      ),
    }),
  );
  for (const notificationOpportunity of notificationOpportunities) {
    if (notificationOpportunity.status !== "fresh") {
      console.log(
        JSON.stringify({
          status: "notification_suppressed",
          reason: notificationOpportunity.reason,
          market: notificationOpportunity.signal.market,
          signalTime: new Date(
            notificationOpportunity.signal.timestamp,
          ).toISOString(),
          observedAt: new Date(
            notificationOpportunity.observedAt,
          ).toISOString(),
          observedPrice: notificationOpportunity.observedPrice,
        }),
      );
      continue;
    }
    if (
      await wasSignalSent(
        config.scannerState,
        notificationOpportunity.signal,
      )
    ) {
      console.log(
        JSON.stringify({
          status: "notification_deduplicated",
          market: notificationOpportunity.signal.market,
          signalTime: new Date(
            notificationOpportunity.signal.timestamp,
          ).toISOString(),
        }),
      );
      continue;
    }
    await sendSignal(
      config.discordWebhookUrl,
      notificationOpportunity.signal,
      fetch,
      config.language,
      notificationOpportunity,
    );
    await markSignalSent(
      config.scannerState,
      notificationOpportunity.signal,
    );
  }
  const activity = await maybeEvaluateMarketActivity(
    config,
    candles,
    now,
    scheduledExecution,
    bootstrapActivityImmediately,
  );
  if (sendBrief && fragility === null) {
    // Optional cross-market work runs after time-sensitive signal delivery.
    fragility = await calculateMarketFragility(sessionCandles);
  }
  let fragilityPersistenceBrief: MarketFragilityPersistenceBrief | undefined;
  if (fragility !== null) {
    console.log(
      JSON.stringify({
        status: "market_fragility",
        level: fragility.level,
        score: fragility.score,
        stressedIndicatorCount: fragility.stressedIndicatorCount,
        availableIndicatorCount: fragility.availableIndicatorCount,
        dataQuality: fragility.dataQuality,
        expandedEquityBreadth:
          fragility.expandedEquityBreadth === undefined
            ? null
            : {
                source: fragility.expandedEquityBreadth.source,
                assetCount: fragility.expandedEquityBreadth.assetCount,
                declinerCount:
                  fragility.expandedEquityBreadth.declinerCount,
                declinerRatio:
                  fragility.expandedEquityBreadth.declinerRatio,
                declineThreshold:
                  fragility.expandedEquityBreadth.declineThreshold,
              },
      }),
    );
    const fragilityPersistenceUpdate = await maybeRecordMarketFragilityShadow(
      config,
      scheduledExecution && sendBrief && dataHealth.stateEligible,
      analysisSession.kind,
      sessionCandles,
      fragility,
    );
    if (
      config.fragilityPersistenceMode === "display" &&
      fragilityPersistenceUpdate !== null
    ) {
      fragilityPersistenceBrief = {
        observation: fragilityPersistenceUpdate.observation,
        metrics: fragilityPersistenceUpdate.metrics,
      };
    }
  }
  if (sendBrief) {
    const chart = await renderMarketBriefChart(result, sessionCandles);
    await sendMarketBrief(
      config.discordWebhookUrl,
      result,
      now,
      fetch,
      chart,
      config.language,
      fragility ?? undefined,
      resilienceMetrics,
      config.marketActivityMode === "display" && dataHealth.stateEligible
        ? activity ?? undefined
        : undefined,
      fragilityPersistenceBrief,
      dataHealth,
    );
  }
  if (notify && dataHealth.stateEligible) {
    const latestCompletedCandle = candles.at(-1);
    if (latestCompletedCandle !== undefined) {
      await setLastSuccessfulCandleEnd(
        config.scannerState,
        config.hyperliquidCoin,
        latestCompletedCandle.endTime,
      );
    }
  }
  return { scan: result, fragility, activity, dataHealth };
}

async function maybeRecordMarketFragilityShadow(
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
        breakingDurationMinutes:
          update.observation.breakingDurationMinutes,
        stressedIndicatorIds: update.observation.stressedIndicatorIds,
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

async function maybeEvaluateMarketActivity(
  config: ScannerConfig,
  candles: readonly Candle[],
  timestamp: Date,
  scheduledExecution: boolean,
  bootstrapImmediately = false,
): Promise<MarketActivitySnapshot | null> {
  if (
    config.marketActivityMode === "off" ||
    (scheduledExecution &&
      !bootstrapImmediately &&
      !isMarketActivityEvaluationTime(timestamp) &&
      !isMarketActivityBootstrapTime(timestamp))
  ) {
    return null;
  }

  try {
    const evaluation = await evaluateMarketActivity(
      config.scannerState,
      config.hyperliquidCoin,
      candles,
      timestamp,
      {
        allowBootstrap: scheduledExecution,
        bootstrapImmediately,
        persistState: scheduledExecution,
      },
    );
    console.log(
      JSON.stringify({
        status: "market_activity",
        mode: config.marketActivityMode,
        market: config.hyperliquidCoin,
        level: evaluation.snapshot.level,
        sessionRvol: evaluation.snapshot.sessionRvol,
        barRvol: evaluation.snapshot.barRvol,
        percentile: evaluation.snapshot.percentile,
        sampleSessions: evaluation.snapshot.sampleSessions,
        confidence: evaluation.snapshot.confidence,
        dataQuality: evaluation.snapshot.dataQuality,
        asOf: new Date(evaluation.snapshot.asOf).toISOString(),
        historySessionCount: evaluation.historySessionCount,
        stateChanged: evaluation.stateChanged,
        stateWritten: evaluation.stateWritten,
        recoveredCorruptState: evaluation.recoveredCorruptState,
        bootstrapAttempted: evaluation.bootstrapAttempted,
        bootstrapLookbackDays: evaluation.bootstrapLookbackDays,
        bootstrapSessionCount: evaluation.bootstrapSessionCount,
        bootstrapError: evaluation.bootstrapError,
        approximateCpuMs: evaluation.approximateCpuMs,
      }),
    );
    if (evaluation.bootstrapError !== null) {
      console.warn(
        JSON.stringify({
          status: "market_activity_bootstrap_degraded",
          market: config.hyperliquidCoin,
          reason: evaluation.bootstrapError,
          effect: "RVOL history remains provisional; scanner signals continue",
        }),
      );
    }
    return evaluation.snapshot;
  } catch (error) {
    console.warn(
      JSON.stringify({
        status: "market_activity_degraded",
        market: config.hyperliquidCoin,
        reason: safeErrorName(error),
        effect: "RVOL diagnostic omitted; scanner signals continue",
      }),
    );
    return null;
  }
}

async function maybeRecordResilienceSnapshot(
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

async function maybeRecordFiveMinuteResilienceShadow(
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

async function calculateMarketFragility(
  candles: readonly Candle[],
): Promise<MarketFragilitySnapshot> {
  let expandedEquityCoins: string[] = [];
  try {
    expandedEquityCoins = await fetchXyzStockCoins();
  } catch (error) {
    console.warn(
      JSON.stringify({
        status: "expanded_equity_breadth_degraded",
        reason: safeErrorName(error),
        effect: "expanded context omitted; frozen six-indicator classifier continues",
      }),
    );
    if (error instanceof HyperliquidRateLimitError) {
      return analyzeMarketFragility(candles, []);
    }
  }
  try {
    const requestedCoins = [
      ...new Set([...FRAGILITY_CONTEXT_COINS, ...expandedEquityCoins]),
    ];
    const contexts = await fetchXyzMarketContexts(requestedCoins);
    return analyzeMarketFragility(
      candles,
      contexts,
      expandedEquityCoins,
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        status: "market_fragility_context_degraded",
        reason: safeErrorName(error),
        effect: "market fragility uses price-only indicators",
      }),
    );
    return analyzeMarketFragility(candles, []);
  }
}

async function runScheduledScan(
  config: ScannerConfig,
  now: Date,
  notify: boolean,
  sendBrief: boolean,
  fallbackNotificationWindowStart: Date | null,
  bootstrapActivityImmediately = false,
): Promise<void> {
  let rateLimitIncidentActive = false;
  try {
    if (notify && config.scannerState === undefined) {
      console.warn(
        JSON.stringify({
          message: "scanner state KV is not bound",
          status: "degraded",
          reason: "scanner_state_not_bound",
          effect:
            "failed-scan recovery and cross-invocation signal dedupe use best-effort fallbacks",
        }),
      );
    }
    rateLimitIncidentActive = await isRateLimitIncidentActive(
      config.scannerState,
      config.hyperliquidCoin,
    );
    const persistedCandleEnd = notify
      ? await getLastSuccessfulCandleEnd(
          config.scannerState,
          config.hyperliquidCoin,
        )
      : null;
    const notificationWindowStart =
      persistedCandleEnd !== null &&
      persistedCandleEnd < now.getTime()
        ? new Date(persistedCandleEnd + 1)
        : fallbackNotificationWindowStart;
    await runScan(
      config,
      now,
      notify,
      sendBrief,
      notificationWindowStart,
      true,
      bootstrapActivityImmediately,
    );
    if (rateLimitIncidentActive) {
      await clearRateLimitIncident(
        config.scannerState,
        config.hyperliquidCoin,
      );
    }
  } catch (error) {
    if (error instanceof HyperliquidRateLimitError) {
      let discordNotice = "deduplicated";
      if (!rateLimitIncidentActive) {
        await sendRateLimitNotice(
          config.discordWebhookUrl,
          config.hyperliquidCoin,
          now,
          fetch,
          config.language,
        );
        await markRateLimitIncidentActive(
          config.scannerState,
          config.hyperliquidCoin,
        );
        discordNotice = "sent";
      }
      console.warn(
        JSON.stringify({
          message: "scheduled scan skipped: Hyperliquid rate limited",
          status: "skipped",
          reason: "hyperliquid_rate_limited",
          market: config.hyperliquidCoin,
          scheduledTime: now.toISOString(),
          discordNotice,
        }),
      );
      return;
    }
    throw error;
  }
}

function isBriefDue(timestamp: Date, intervalMinutes: number): boolean {
  const minuteOfDay = timestamp.getUTCHours() * 60 + timestamp.getUTCMinutes();
  return minuteOfDay % intervalMinutes === 0;
}

async function hasWorkerVersionChanged(
  config: ScannerConfig,
): Promise<boolean> {
  if (config.scannerState === undefined) {
    return false;
  }
  try {
    return (await config.scannerState.get(VERSION_NOTICE_KEY)) !==
      config.workerVersionKey;
  } catch (error) {
    console.warn(
      JSON.stringify({
        status: "version_state_degraded",
        reason: safeErrorName(error),
        effect: "version notice and startup RVOL bootstrap skipped",
      }),
    );
    return false;
  }
}

async function maybeSendVersionNotice(
  config: ScannerConfig,
  now: Date,
  versionChanged: Promise<boolean>,
): Promise<void> {
  if (config.scannerState === undefined) {
    await maybeSendRecentVersionNoticeWithoutState(config, now);
    return;
  }

  if (!(await versionChanged)) {
    return;
  }
  await sendVersionNotice(
    config.discordWebhookUrl,
    config.workerVersionLabel,
    now,
    fetch,
    config.language,
  );
  await config.scannerState.put(VERSION_NOTICE_KEY, config.workerVersionKey);
}

/** Prime missing RVOL history on the first Cron invocation of a new version. */
async function bootstrapMarketActivityForNewVersion(
  config: ScannerConfig,
  now: Date,
): Promise<void> {
  try {
    const evaluation = await evaluateMarketActivity(
      config.scannerState,
      config.hyperliquidCoin,
      [],
      now,
      {
        allowBootstrap: true,
        bootstrapImmediately: true,
        persistState: true,
      },
    );
    const message = JSON.stringify({
      status: "market_activity_startup_bootstrap",
      market: config.hyperliquidCoin,
      attempted: evaluation.bootstrapAttempted,
      lookbackDays: evaluation.bootstrapLookbackDays,
      bootstrapSessionCount: evaluation.bootstrapSessionCount,
      historySessionCount: evaluation.historySessionCount,
      stateWritten: evaluation.stateWritten,
      error: evaluation.bootstrapError,
    });
    if (evaluation.bootstrapError === null) {
      console.log(message);
    } else {
      console.warn(message);
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        status: "market_activity_startup_bootstrap_degraded",
        market: config.hyperliquidCoin,
        reason: safeErrorName(error),
        effect: "scheduled scanner operation continues",
      }),
    );
  }
}

async function maybeSendRecentVersionNoticeWithoutState(
  config: ScannerConfig,
  now: Date,
): Promise<void> {
  if (
    config.workerVersionUploadedAt === null ||
    now.getTime() - config.workerVersionUploadedAt.getTime() >
      RECENT_VERSION_NOTICE_WINDOW_MS
  ) {
    console.log(
      "version notice skipped: no recent Worker version metadata and SCANNER_STATE KV is not bound",
    );
    return;
  }

  const versionKey = `${VERSION_NOTICE_KEY}:${config.workerVersionKey}`;
  if (lastVersionNoticeSentFor === versionKey) {
    return;
  }
  await sendVersionNotice(
    config.discordWebhookUrl,
    config.workerVersionLabel,
    now,
    fetch,
    config.language,
  );
  lastVersionNoticeSentFor = versionKey;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
