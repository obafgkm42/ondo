import {
  average,
  calculateAverageTrueRange,
  calculateVwap,
} from "./market-statistics";
import type {
  Candle,
  ExpandedEquityBreadthSnapshot,
  MarketAssetContext,
  MarketFragilityDataQuality,
  MarketFragilityIndicator,
  MarketFragilityIndicatorId,
  MarketFragilityLevel,
  MarketFragilitySnapshot,
} from "./types";

const MINIMUM_PRICE_CANDLES = 6;
const FRAGILITY_ATR_WINDOW = 12;
const SESSION_LOSS_THRESHOLD = -0.01;
const VWAP_GAP_ATR_THRESHOLD = -0.35;
const VWAP_CONFIRMATION_CANDLES = 3;
const POOR_CLOSE_LOCATION_THRESHOLD = 0.25;
const TAIL_LOOKBACK_RETURNS = 12;
const LARGE_DOWN_RETURN_FLOOR = 0.0025;
const LARGE_DOWN_RETURN_MEDIAN_MULTIPLIER = 2;
const LARGE_DOWN_RETURN_COUNT = 2;
const BREADTH_MINIMUM_ASSETS = 5;
const BREADTH_DECLINE_THRESHOLD = -0.005;
const BREADTH_STRESS_RATIO = 0.7;
const EXPANDED_BREADTH_MINIMUM_ASSETS = 10;
const CROSS_ASSET_LOSS_THRESHOLD = -0.0075;
const TOTAL_INDICATOR_COUNT = 6;
const MINIMUM_AVAILABLE_INDICATORS = 4;

const MEGA_CAP_BREADTH_COINS = [
  "xyz:AAPL",
  "xyz:MSFT",
  "xyz:NVDA",
  "xyz:AMZN",
  "xyz:GOOGL",
  "xyz:META",
  "xyz:TSLA",
] as const;

/**
 * Markets needed by the periodic fragility brief. The list intentionally uses
 * one Hyperliquid metadata request rather than separate candle requests for
 * every constituent.
 */
export const FRAGILITY_CONTEXT_COINS = [
  "xyz:SP500",
  "xyz:XYZ100",
  ...MEGA_CAP_BREADTH_COINS,
] as const;

/**
 * Canonical live thresholds shared by the classifier and user-facing guides.
 */
export const marketFragilityThresholds: Readonly<
  Record<MarketFragilityIndicatorId, string>
> = {
  session_loss: "<= -1.0%",
  vwap_repair_failure: "<= -0.35 ATR and 3 closes below VWAP",
  poor_close_location: "<= 25% of range",
  downside_tail_cluster: ">= 2 volatility-adjusted large down returns",
  mega_cap_breadth: ">= 70% down at least 0.5%",
  equity_cross_confirmation: "SP500 and XYZ100 both <= -0.75%",
};

/**
 * Count independently observable repair failures without changing the frozen
 * reversal alert policy. The score is ordinal, not a calibrated probability.
 */
export function analyzeMarketFragility(
  candles: readonly Candle[],
  assetContexts: readonly MarketAssetContext[],
  expandedEquityCoins: readonly string[] = [],
): MarketFragilitySnapshot {
  const indicators = [
    sessionLossIndicator(candles),
    vwapRepairIndicator(candles),
    closeLocationIndicator(candles),
    downsideTailIndicator(candles),
    breadthIndicator(assetContexts),
    crossAssetIndicator(assetContexts),
  ];
  const availableIndicatorCount = indicators.filter(
    (indicator) => indicator.state !== "unavailable",
  ).length;
  const stressedIndicatorCount = indicators.filter(
    (indicator) => indicator.state === "stressed",
  ).length;
  const dataQuality = fragilityDataQuality(availableIndicatorCount);
  const enoughData = dataQuality !== "insufficient";

  const expandedEquityBreadth = expandedBreadthContext(
    assetContexts,
    expandedEquityCoins,
  );
  return {
    level: enoughData
      ? fragilityLevel(stressedIndicatorCount)
      : "unknown",
    score: enoughData
      ? fragilityScore(stressedIndicatorCount)
      : null,
    stressedIndicatorCount,
    availableIndicatorCount,
    totalIndicatorCount: TOTAL_INDICATOR_COUNT,
    dataQuality,
    indicators,
    ...(expandedEquityBreadth === null
      ? {}
      : { expandedEquityBreadth }),
  };
}

function expandedBreadthContext(
  assetContexts: readonly MarketAssetContext[],
  expandedEquityCoins: readonly string[],
): ExpandedEquityBreadthSnapshot | null {
  const requestedCoins = new Set(expandedEquityCoins);
  const returns = assetContexts.flatMap((context) => {
    if (!requestedCoins.has(context.coin)) {
      return [];
    }
    const assetReturn = contextReturn(context);
    return assetReturn === null ? [] : [assetReturn];
  });
  if (returns.length < EXPANDED_BREADTH_MINIMUM_ASSETS) {
    return null;
  }
  const declinerCount = returns.filter(
    (value) => value <= BREADTH_DECLINE_THRESHOLD,
  ).length;
  return {
    source: "hyperliquid_xyz_stock_perps",
    assetCount: returns.length,
    declinerCount,
    declinerRatio: declinerCount / returns.length,
    declineThreshold: BREADTH_DECLINE_THRESHOLD,
  };
}

function sessionLossIndicator(
  candles: readonly Candle[],
): MarketFragilityIndicator {
  const first = candles[0];
  const latest = candles.at(-1);
  if (
    candles.length < MINIMUM_PRICE_CANDLES ||
    first === undefined ||
    latest === undefined ||
    first.open <= 0
  ) {
    return unavailableIndicator(
      "session_loss",
      marketFragilityThresholds.session_loss,
    );
  }
  const sessionReturn = latest.close / first.open - 1;
  return indicator(
    "session_loss",
    sessionReturn <= SESSION_LOSS_THRESHOLD,
    sessionReturn,
    formatPercent(sessionReturn),
    marketFragilityThresholds.session_loss,
  );
}

function vwapRepairIndicator(
  candles: readonly Candle[],
): MarketFragilityIndicator {
  const latest = candles.at(-1);
  const atr = calculateAverageTrueRange(candles, FRAGILITY_ATR_WINDOW);
  if (
    candles.length < MINIMUM_PRICE_CANDLES ||
    latest === undefined ||
    atr <= 0
  ) {
    return unavailableIndicator(
      "vwap_repair_failure",
      marketFragilityThresholds.vwap_repair_failure,
    );
  }
  const vwap = calculateVwap(candles);
  const vwapGapAtr = (latest.close - vwap) / atr;
  const recentClosesRemainBelowVwap = candles
    .slice(-VWAP_CONFIRMATION_CANDLES)
    .every((candle) => candle.close < vwap);
  return indicator(
    "vwap_repair_failure",
    vwapGapAtr <= VWAP_GAP_ATR_THRESHOLD &&
      recentClosesRemainBelowVwap,
    vwapGapAtr,
    `${vwapGapAtr.toFixed(2)} ATR`,
    marketFragilityThresholds.vwap_repair_failure,
  );
}

function closeLocationIndicator(
  candles: readonly Candle[],
): MarketFragilityIndicator {
  const latest = candles.at(-1);
  if (candles.length < MINIMUM_PRICE_CANDLES || latest === undefined) {
    return unavailableIndicator(
      "poor_close_location",
      marketFragilityThresholds.poor_close_location,
    );
  }
  const sessionHigh = Math.max(...candles.map((candle) => candle.high));
  const sessionLow = Math.min(...candles.map((candle) => candle.low));
  const sessionRange = sessionHigh - sessionLow;
  if (sessionRange <= 0) {
    return unavailableIndicator(
      "poor_close_location",
      marketFragilityThresholds.poor_close_location,
    );
  }
  const closeLocation = (latest.close - sessionLow) / sessionRange;
  return indicator(
    "poor_close_location",
    closeLocation <= POOR_CLOSE_LOCATION_THRESHOLD,
    closeLocation,
    formatPercent(closeLocation, 0),
    marketFragilityThresholds.poor_close_location,
  );
}

function downsideTailIndicator(
  candles: readonly Candle[],
): MarketFragilityIndicator {
  if (candles.length < MINIMUM_PRICE_CANDLES) {
    return unavailableIndicator(
      "downside_tail_cluster",
      marketFragilityThresholds.downside_tail_cluster,
    );
  }
  const sample = candles.slice(-(TAIL_LOOKBACK_RETURNS + 1));
  const returns = sample.slice(1).flatMap((candle, index) => {
    const previous = sample[index];
    return previous === undefined || previous.close <= 0
      ? []
      : [candle.close / previous.close - 1];
  });
  if (returns.length < MINIMUM_PRICE_CANDLES - 1) {
    return unavailableIndicator(
      "downside_tail_cluster",
      marketFragilityThresholds.downside_tail_cluster,
    );
  }
  const medianAbsoluteReturn = median(
    returns.map((value) => Math.abs(value)),
  );
  const largeDownThreshold = Math.max(
    LARGE_DOWN_RETURN_FLOOR,
    medianAbsoluteReturn * LARGE_DOWN_RETURN_MEDIAN_MULTIPLIER,
  );
  const largeDownCount = returns.filter(
    (value) => value <= -largeDownThreshold,
  ).length;
  return indicator(
    "downside_tail_cluster",
    largeDownCount >= LARGE_DOWN_RETURN_COUNT,
    largeDownCount,
    `${largeDownCount}/${returns.length} <= -${formatPercent(largeDownThreshold)}`,
    marketFragilityThresholds.downside_tail_cluster,
  );
}

function breadthIndicator(
  assetContexts: readonly MarketAssetContext[],
): MarketFragilityIndicator {
  const returns = MEGA_CAP_BREADTH_COINS.flatMap((coin) => {
    const context = assetContexts.find((candidate) => candidate.coin === coin);
    const assetReturn = contextReturn(context);
    return assetReturn === null ? [] : [assetReturn];
  });
  if (returns.length < BREADTH_MINIMUM_ASSETS) {
    return unavailableIndicator(
      "mega_cap_breadth",
      marketFragilityThresholds.mega_cap_breadth,
    );
  }
  const declinerRatio =
    returns.filter((value) => value <= BREADTH_DECLINE_THRESHOLD).length /
    returns.length;
  return indicator(
    "mega_cap_breadth",
    declinerRatio >= BREADTH_STRESS_RATIO,
    declinerRatio,
    `${formatPercent(declinerRatio, 0)} (${returns.length} assets)`,
    marketFragilityThresholds.mega_cap_breadth,
  );
}

function crossAssetIndicator(
  assetContexts: readonly MarketAssetContext[],
): MarketFragilityIndicator {
  const sp500Return = contextReturn(
    assetContexts.find((context) => context.coin === "xyz:SP500"),
  );
  const xyz100Return = contextReturn(
    assetContexts.find((context) => context.coin === "xyz:XYZ100"),
  );
  if (sp500Return === null || xyz100Return === null) {
    return unavailableIndicator(
      "equity_cross_confirmation",
      marketFragilityThresholds.equity_cross_confirmation,
    );
  }
  return indicator(
    "equity_cross_confirmation",
    sp500Return <= CROSS_ASSET_LOSS_THRESHOLD &&
      xyz100Return <= CROSS_ASSET_LOSS_THRESHOLD,
    average([sp500Return, xyz100Return]),
    `SP500 ${formatPercent(sp500Return)} / XYZ100 ${formatPercent(xyz100Return)}`,
    marketFragilityThresholds.equity_cross_confirmation,
  );
}

function contextReturn(context: MarketAssetContext | undefined): number | null {
  if (context === undefined || context.previousDayPrice <= 0) {
    return null;
  }
  return context.markPrice / context.previousDayPrice - 1;
}

function indicator(
  id: MarketFragilityIndicatorId,
  stressed: boolean,
  value: number,
  displayValue: string,
  threshold: string,
): MarketFragilityIndicator {
  return {
    id,
    state: stressed ? "stressed" : "healthy",
    value,
    displayValue,
    threshold,
  };
}

function unavailableIndicator(
  id: MarketFragilityIndicatorId,
  threshold: string,
): MarketFragilityIndicator {
  return {
    id,
    state: "unavailable",
    value: null,
    displayValue: "n/a",
    threshold,
  };
}

function fragilityDataQuality(
  availableIndicatorCount: number,
): MarketFragilityDataQuality {
  if (availableIndicatorCount === TOTAL_INDICATOR_COUNT) {
    return "full";
  }
  return availableIndicatorCount >= MINIMUM_AVAILABLE_INDICATORS
    ? "partial"
    : "insufficient";
}

function fragilityLevel(stressedIndicatorCount: number): MarketFragilityLevel {
  if (stressedIndicatorCount >= 4) {
    return "panic";
  }
  if (stressedIndicatorCount === 3) {
    return "breaking";
  }
  if (stressedIndicatorCount === 2) {
    return "fragile";
  }
  return "resilient";
}

function fragilityScore(stressedIndicatorCount: number): number {
  const scores = [0, 15, 35, 60, 80, 90, 100] as const;
  return scores[Math.min(stressedIndicatorCount, scores.length - 1)] ?? 100;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  const middle = sorted[midpoint] ?? 0;
  if (sorted.length % 2 === 1) {
    return middle;
  }
  return average([sorted[midpoint - 1] ?? middle, middle]);
}

function formatPercent(value: number, digits = 2): string {
  return `${(value * 100).toFixed(digits)}%`;
}
