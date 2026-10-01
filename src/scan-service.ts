import { safeErrorName } from "./runtime-validation";
import {
  maybeRecordMarketFragilityShadow,
  maybeRecordResilienceSnapshot,
  maybeRecordFiveMinuteResilienceShadow,
  maybeRecordRthShadowAcquisition,
} from "./scan-telemetry";
import { renderMarketBriefChart } from "./chart";
import {
  sendMarketBrief,
  sendRateLimitNotice,
  sendSignal,
  sendVersionNotice,
} from "./discord";
import {
  directHyperliquidAccess,
  type HyperliquidAccess,
  HyperliquidAdmissionError,
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
import type {
  MarketFragilityPersistenceBrief,
} from "./market-fragility-shadow";
import {
  getBriefIntervalMinutes,
  getPreviousScanTime,
  getScheduleDecision,
  isFiveMinuteRthAcquisitionTime,
  selectAnalysisSession,
} from "./market-hours";
import {
  calculateResilienceMetrics,
} from "./resilience-decay";
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
  MarketActivitySnapshot,
  MarketDataHealth,
  MarketDataSessionScope,
  MarketFragilitySnapshot,
  ProviderAccessSummary,
  ScanResult,
  ScannerConfig,
} from "./types";

const VERSION_NOTICE_KEY = "last-version-notice";
const RECENT_VERSION_NOTICE_WINDOW_MS = 20 * 60 * 1000;
let lastVersionNoticeSentFor: string | null = null;

export interface ScanExecutionResult {
  scan: ScanResult;
  fragility: MarketFragilitySnapshot | null;
  activity: MarketActivitySnapshot | null;
  dataHealth: MarketDataHealth;
  providerAccess?: ProviderAccessSummary;
}

/** Run one scheduled tick and await every side effect before releasing the lock. */
export async function executeScheduledScan(
  config: ScannerConfig,
  now: Date,
  provider: HyperliquidAccess = directHyperliquidAccess(),
): Promise<void> {
  const decision = getScheduleDecision(now, config);
  const briefIntervalMinutes = getBriefIntervalMinutes(
    now,
    config.briefIntervalMinutes,
  );
  const briefDue = isBriefDue(now, briefIntervalMinutes);
  const shadowAcquisitionDue =
    config.fiveMinuteRthAcquisitionMode === "shadow" &&
    isFiveMinuteRthAcquisitionTime(now);
  const versionChanged = hasWorkerVersionChanged(config);
  const versionNotice = maybeSendVersionNotice(config, now, versionChanged);
  const fallbackNotificationWindowStart = decision.shouldRun
    ? getPreviousScanTime(now, config)
    : null;
  const scan = versionChanged.then(async (changed) => {
    const bootstrapImmediately =
      changed && config.marketActivityMode !== "off";
    if (!decision.shouldRun && !briefDue) {
      if (shadowAcquisitionDue) {
        await runRthShadowAcquisition(config, now, provider);
      }
      if (bootstrapImmediately) {
        await bootstrapMarketActivityForNewVersion(config, now, provider);
      } else if (!shadowAcquisitionDue) {
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
      shadowAcquisitionDue,
      bootstrapImmediately,
      provider,
    );
  });
  // A failed notice must not release the coordinator while a scan still runs.
  const results = await Promise.allSettled([versionNotice, scan]);
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}

/** Query current diagnostics without scheduled notifications or history writes. */
export function executeManualScan(
  config: ScannerConfig,
  now: Date,
  provider: HyperliquidAccess = directHyperliquidAccess(),
): Promise<ScanExecutionResult> {
  return runScan(config, now, {
    notify: false,
    sendBrief: false,
    notificationWindowStart: null,
    scheduledExecution: false,
    shadowAcquisitionDue: false,
  }, provider);
}

interface ScanOptions {
  notify: boolean;
  sendBrief: boolean;
  notificationWindowStart: Date | null;
  scheduledExecution: boolean;
  shadowAcquisitionDue: boolean;
  bootstrapActivityImmediately?: boolean;
}

async function runScan(
  config: ScannerConfig,
  now: Date,
  options: ScanOptions,
  provider: HyperliquidAccess,
): Promise<ScanExecutionResult> {
  const {
    notify,
    sendBrief,
    notificationWindowStart,
    scheduledExecution,
    shadowAcquisitionDue,
    bootstrapActivityImmediately = false,
  } = options;
  const candles = await provider.fetchFiveMinuteCandles(
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
    ? await calculateMarketFragility(
        sessionCandles,
        analysisSession.kind,
        provider,
      )
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
  // Shadow persistence stays behind time-sensitive live signal delivery.
  await maybeRecordRthShadowAcquisition(
    config,
    shadowAcquisitionDue && dataHealth.stateEligible,
    sessionCandles,
    now,
  );
  const activity = await maybeEvaluateMarketActivity(
    config,
    candles,
    now,
    scheduledExecution,
    bootstrapActivityImmediately,
    provider,
  );
  if (sendBrief && fragility === null) {
    // Optional cross-market work runs after time-sensitive signal delivery.
    fragility = await calculateMarketFragility(
      sessionCandles,
      analysisSession.kind,
      provider,
    );
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
        observationWindow: {
          candleEndTime:
            fragility.observationWindow.candleEndTime === null
              ? null
              : new Date(
                  fragility.observationWindow.candleEndTime,
                ).toISOString(),
          contextFetchedAt:
            fragility.observationWindow.contextFetchedAt === null
              ? null
              : new Date(
                  fragility.observationWindow.contextFetchedAt,
                ).toISOString(),
          evaluatedAt: new Date(
            fragility.observationWindow.evaluatedAt,
          ).toISOString(),
          sessionScope: fragility.observationWindow.sessionScope,
          contextReferencePriceType:
            fragility.observationWindow.contextReferencePriceType,
          contextProviderTimestamp:
            fragility.observationWindow.contextProviderTimestamp,
        },
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
                categoryCacheStatus:
                  fragility.expandedEquityBreadth.categoryCacheStatus,
                categoryCacheAgeMs:
                  fragility.expandedEquityBreadth.categoryCacheAgeMs,
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

async function maybeEvaluateMarketActivity(
  config: ScannerConfig,
  candles: readonly Candle[],
  timestamp: Date,
  scheduledExecution: boolean,
  bootstrapImmediately = false,
  provider: HyperliquidAccess = directHyperliquidAccess(),
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
        fetchBootstrapCandles: (market, bootstrapTime, lookbackDays) =>
          provider.fetchFifteenMinuteCandles(
            market,
            bootstrapTime,
            lookbackDays,
          ),
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

async function runRthShadowAcquisition(
  config: ScannerConfig,
  now: Date,
  provider: HyperliquidAccess,
): Promise<void> {
  try {
    const candles = await provider.fetchFiveMinuteCandles(
      config.hyperliquidCoin,
      now,
    );
    const analysisSession = selectAnalysisSession(candles, now);
    const dataHealth = assessMarketDataHealth(
      analysisSession.candles,
      now,
      analysisSession.kind,
    );
    if (!dataHealth.stateEligible) {
      console.warn(JSON.stringify({
        status: "rth_shadow_acquisition_skipped",
        market: config.hyperliquidCoin,
        reason: dataHealth.status,
        candleCount: dataHealth.candleCount,
      }));
      return;
    }
    await maybeRecordRthShadowAcquisition(
      config,
      true,
      analysisSession.candles,
      now,
    );
    await maybeRecordFiveMinuteResilienceShadow(
      config,
      analysisSession.candles,
    );
  } catch (error) {
    console.warn(JSON.stringify({
      status: "rth_shadow_acquisition_degraded",
      market: config.hyperliquidCoin,
      reason: safeErrorName(error),
      effect: "five-minute shadow omitted; live schedule remains unchanged",
    }));
  }
}

async function calculateMarketFragility(
  candles: readonly Candle[],
  sessionScope: MarketDataSessionScope,
  provider: HyperliquidAccess = directHyperliquidAccess(),
): Promise<MarketFragilitySnapshot> {
  let expandedEquityCoins: string[] = [];
  let categoryCacheStatus:
    | "direct"
    | "refreshed"
    | "cached"
    | "stale"
    | "unavailable" = "unavailable";
  let categoryCacheAgeMs: number | null = null;
  try {
    const categorySelection = await provider.fetchXyzStockCoins();
    expandedEquityCoins = categorySelection.coins;
    categoryCacheStatus = categorySelection.cacheStatus;
    categoryCacheAgeMs = categorySelection.cacheAgeMs;
  } catch (error) {
    console.warn(
      JSON.stringify({
        status: "expanded_equity_breadth_degraded",
        reason: safeErrorName(error),
        effect: "expanded context omitted; frozen six-indicator classifier continues",
      }),
    );
    if (error instanceof HyperliquidRateLimitError) {
      return analyzeMarketFragility(candles, [], {
        evaluatedAt: Date.now(),
        sessionScope,
      });
    }
  }
  try {
    const requestedCoins = [
      ...new Set([...FRAGILITY_CONTEXT_COINS, ...expandedEquityCoins]),
    ];
    const contexts = await provider.fetchXyzMarketContexts(requestedCoins);
    return analyzeMarketFragility(
      candles,
      contexts,
      {
        evaluatedAt: Date.now(),
        sessionScope,
        expandedEquityCoins,
        expandedEquityCategoryCache: {
          status: categoryCacheStatus,
          ageMs: categoryCacheAgeMs,
        },
      },
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        status: "market_fragility_context_degraded",
        reason: safeErrorName(error),
        effect: "market fragility uses price-only indicators",
      }),
    );
    return analyzeMarketFragility(candles, [], {
      evaluatedAt: Date.now(),
      sessionScope,
    });
  }
}

async function runScheduledScan(
  config: ScannerConfig,
  now: Date,
  notify: boolean,
  sendBrief: boolean,
  fallbackNotificationWindowStart: Date | null,
  shadowAcquisitionDue: boolean,
  bootstrapActivityImmediately = false,
  provider: HyperliquidAccess = directHyperliquidAccess(),
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
            "failed-scan recovery and cross-invocation signal dedupe " +
            "use best-effort fallbacks",
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
    await runScan(config, now, {
      notify,
      sendBrief,
      notificationWindowStart,
      scheduledExecution: true,
      shadowAcquisitionDue,
      bootstrapActivityImmediately,
    }, provider);
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
    if (error instanceof HyperliquidAdmissionError) {
      console.warn(
        JSON.stringify({
          message: "scheduled scan skipped: local provider guard denied access",
          status: "skipped",
          reason: `hyperliquid_${error.reason}`,
          market: config.hyperliquidCoin,
          scheduledTime: now.toISOString(),
          effect: "fresh provider data unavailable; no decision was emitted",
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
  provider: HyperliquidAccess = directHyperliquidAccess(),
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
        fetchBootstrapCandles: (market, bootstrapTime, lookbackDays) =>
          provider.fetchFifteenMinuteCandles(
            market,
            bootstrapTime,
            lookbackDays,
          ),
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
      "version notice skipped: no recent Worker version metadata " +
      "and SCANNER_STATE KV is not bound",
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
