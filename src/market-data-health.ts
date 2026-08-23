import type {
  Candle,
  Language,
  MarketDataHealth,
  MarketDataSessionScope,
} from "./types";

export const LIVE_CANDLE_INTERVAL_MS = 5 * 60_000;

/**
 * Evaluate freshness and continuity from the candles already fetched.
 *
 * This adds no provider request. RTH is the only scope currently eligible to
 * drive persistence collection or mention routing; overnight classifications
 * remain visible but explicitly unvalidated.
 */
export function assessMarketDataHealth(
  candles: readonly Candle[],
  evaluatedAt: Date,
  sessionScope: MarketDataSessionScope,
  intervalMs = LIVE_CANDLE_INTERVAL_MS,
): MarketDataHealth {
  const expectedLatestEndTime =
    Math.floor(evaluatedAt.getTime() / intervalMs) * intervalMs - 1;
  const latestEndTime = candles.at(-1)?.endTime ?? null;
  const { gapCount, missingIntervals } = countGaps(candles, intervalMs);
  const lagIntervals = latestEndTime === null
    ? null
    : Math.max(
        0,
        Math.floor((expectedLatestEndTime - latestEndTime) / intervalMs),
      );
  const reasons: string[] = [];
  let status: MarketDataHealth["status"] = "healthy";
  if (latestEndTime === null) {
    status = "unavailable";
    reasons.push("no completed candle is available");
  } else if (lagIntervals !== null && lagIntervals >= 1) {
    status = "stale";
    reasons.push(`latest completed candle lags by ${lagIntervals} interval(s)`);
  } else if (gapCount > 0) {
    status = "degraded";
    reasons.push(
      `${gapCount} gap(s) omit ${missingIntervals} expected interval(s)`,
    );
  }
  if (sessionScope === "overnight") {
    reasons.push("overnight market-state policy is not validated");
  }
  const stateEligible = status === "healthy" && sessionScope === "rth";
  return {
    status,
    sessionScope,
    candleCount: candles.length,
    latestEndTime,
    expectedLatestEndTime,
    lagIntervals,
    gapCount,
    missingIntervals,
    stateEligible,
    reasons,
  };
}

/** Explain why live decision outputs are withheld without implying calm. */
export function formatIneligibleMarketDataStatus(
  health: MarketDataHealth,
  language: Language,
): string {
  const status = health.status.toUpperCase();
  const scope = health.sessionScope.toUpperCase();
  return language === "en"
    ? `Live decisions withheld: ${status} · ${scope} market data.`
    : `即時決策已停用：市場資料 ${status} · ${scope}。`;
}

function countGaps(
  candles: readonly Candle[],
  intervalMs: number,
): { gapCount: number; missingIntervals: number } {
  let gapCount = 0;
  let missingIntervals = 0;
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1];
    const current = candles[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const difference = current.startTime - previous.startTime;
    if (difference > intervalMs) {
      gapCount += 1;
      missingIntervals += Math.max(0, Math.floor(difference / intervalMs) - 1);
    }
  }
  return { gapCount, missingIntervals };
}
