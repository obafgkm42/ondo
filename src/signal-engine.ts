import type {
  AnalysisThresholds,
  Candle,
  NotificationOpportunity,
  ReversalLocation,
  Direction,
  ScanResult,
  SignalPolicy,
} from "./types";
import {
  average,
  calculateAverageTrueRange,
  calculateVwap,
} from "./market-statistics";

const MINIMUM_SESSION_CANDLES = 6;
const ATR_WINDOW = 12;
const RANGE_EXTREME_FRACTION = 0.2;
const MINIMUM_WICK_RATIO = 0.35;
const MINIMUM_BODY_RATIO = 0.45;
const MINIMUM_CLOSE_REJECTION = 0.65;
const VOLUME_SPIKE_MULTIPLIER = 1.2;
const BULLISH_MINIMUM_DISTANCE_FROM_VWAP_ATR = 0.8;
const BEARISH_MINIMUM_DISTANCE_FROM_VWAP_ATR = 1.25;
const MINIMUM_SESSION_RANGE_ATR = 3;
const MAXIMUM_POLICY_RISK_ATR = 2.25;

/**
 * Find a fresh lookback-extreme rejection with tightly bounded price risk.
 *
 * This is a price-location proxy for a convexity entry. It deliberately does
 * not estimate option premium, Greeks, fills, or an option-specific payoff.
 */
export function analyzeSession(
  market: string,
  candles: readonly Candle[],
  thresholds: AnalysisThresholds,
): ScanResult {
  if (candles.length < MINIMUM_SESSION_CANDLES) {
    return emptyResult(
      market,
      candles,
      `waiting for ${MINIMUM_SESSION_CANDLES} completed lookback candles`,
    );
  }

  const latest = candles.at(-1);
  if (latest === undefined) {
    return emptyResult(market, candles, "no completed lookback candle");
  }
  const priorCandles = candles.slice(0, -1);
  const sessionHigh = Math.max(...candles.map((candle) => candle.high));
  const sessionLow = Math.min(...candles.map((candle) => candle.low));
  const priorHigh = Math.max(...priorCandles.map((candle) => candle.high));
  const priorLow = Math.min(...priorCandles.map((candle) => candle.low));
  const vwap = calculateVwap(candles);
  const atr = calculateAverageTrueRange(candles, ATR_WINDOW);

  const candidates = (
    [
      buildCandidate(
        "bullish",
        market,
        candles,
        latest,
        priorHigh,
        priorLow,
        sessionHigh,
        sessionLow,
        vwap,
        atr,
      ),
      buildCandidate(
        "bearish",
        market,
        candles,
        latest,
        priorHigh,
        priorLow,
        sessionHigh,
        sessionLow,
        vwap,
        atr,
      ),
    ] satisfies Array<ReversalLocation | null>
  ).filter((candidate): candidate is ReversalLocation => candidate !== null);
  const policyQualifiedCandidates = candidates.filter(
    (candidate) => candidate.policy.watchEligible,
  );

  const alertCandidate = bestQualifiedCandidate(
    policyQualifiedCandidates,
    thresholds.minimumPriceR,
    thresholds.minimumConfidenceScore,
    "alert",
  );
  const watchCandidate = bestQualifiedCandidate(
    policyQualifiedCandidates,
    thresholds.minimumWatchPriceR,
    thresholds.minimumWatchConfidenceScore,
    "watch",
  );
  const signal =
    alertCandidate === null
      ? null
      : {
          ...alertCandidate,
          level: "alert" as const,
        };
  const watch =
    signal !== null || watchCandidate === null
      ? null
      : {
          ...watchCandidate,
          level: "watch" as const,
        };

  return {
    watch,
    signal,
    market,
    candleCount: candles.length,
    sessionHigh,
    sessionLow,
    latestPrice: latest.close,
    status: scanStatus(
      signal,
      watch,
      candidates.length,
      policyQualifiedCandidates.length,
    ),
  };
}

/**
 * Analyze every newly completed candle exposed by one scheduled fetch.
 *
 * Production requests can remain on a slower cadence while signal detection
 * still sees each five-minute rejection candle. The lower bound is the prior
 * scheduled scan time, so adjacent invocations have non-overlapping windows.
 */
export function findNotificationOpportunities(
  market: string,
  candles: readonly Candle[],
  thresholds: AnalysisThresholds,
  earliestCandleEndTime: number,
  observedAt: number,
): NotificationOpportunity[] {
  const opportunities: NotificationOpportunity[] = [];
  const seenTimestamps = new Set<number>();
  const observedPrice = candles.at(-1)?.close;
  if (observedPrice === undefined) {
    return opportunities;
  }

  for (let index = 0; index < candles.length; index += 1) {
    const triggerCandle = candles[index];
    if (
      triggerCandle === undefined ||
      triggerCandle.endTime < earliestCandleEndTime
    ) {
      continue;
    }

    const result = analyzeSession(
      market,
      candles.slice(0, index + 1),
      thresholds,
    );
    const opportunity = result.signal ?? result.watch;
    if (
      opportunity === null ||
      opportunity.timestamp !== triggerCandle.endTime ||
      seenTimestamps.has(opportunity.timestamp)
    ) {
      continue;
    }

    seenTimestamps.add(opportunity.timestamp);
    opportunities.push(
      assessNotificationOpportunity(
        opportunity,
        candles.slice(index + 1),
        observedAt,
        observedPrice,
      ),
    );
  }

  return opportunities;
}

function assessNotificationOpportunity(
  signal: ReversalLocation,
  candlesAfterSignal: readonly Candle[],
  observedAt: number,
  observedPrice: number,
): NotificationOpportunity {
  if (
    candlesAfterSignal.some((candle) =>
      signal.direction === "bullish"
        ? candle.low <= signal.invalidation
        : candle.high >= signal.invalidation
    )
  ) {
    return {
      signal,
      observedAt,
      observedPrice,
      status: "invalidated_before_delivery",
      reason: "the frozen invalidation was touched before notification delivery",
    };
  }
  if (
    candlesAfterSignal.some((candle) =>
      signal.direction === "bullish"
        ? candle.high >= signal.target
        : candle.low <= signal.target
    )
  ) {
    return {
      signal,
      observedAt,
      observedPrice,
      status: "target_reached_before_delivery",
      reason: "the frozen target was touched before notification delivery",
    };
  }
  if (
    observedPrice < signal.entryLow ||
    observedPrice > signal.entryHigh
  ) {
    return {
      signal,
      observedAt,
      observedPrice,
      status: "outside_entry_zone",
      reason: "the observed price left the frozen entry watch zone",
    };
  }
  return {
    signal,
    observedAt,
    observedPrice,
    status: "fresh",
    reason: "the setup remained inside its entry zone at delivery",
  };
}

function bestQualifiedCandidate(
  candidates: readonly ReversalLocation[],
  minimumPriceR: number,
  minimumConfidenceScore: number,
  level: "watch" | "alert",
): ReversalLocation | null {
  return (
    candidates
      .filter(
        (candidate) =>
          candidate.priceRiskReward >= minimumPriceR &&
          candidate.confidenceScore >= minimumConfidenceScore &&
          (level === "watch"
            ? candidate.policy.watchEligible
            : candidate.policy.alertEligible),
      )
      .sort(
        (left, right) =>
          right.confidenceScore - left.confidenceScore ||
          right.priceRiskReward - left.priceRiskReward,
      )[0] ?? null
  );
}

function scanStatus(
  signal: ReversalLocation | null,
  watch: ReversalLocation | null,
  candidateCount: number,
  policyQualifiedCount: number,
): string {
  if (signal !== null) {
    return "qualified alert-level modern reversal-zone signal";
  }
  if (watch !== null) {
    return "watch-level modern reversal-zone setup found; alert thresholds not yet met";
  }
  if (candidateCount > 0 && policyQualifiedCount === 0) {
    return "fresh rejection found, but regime policy kept it out of reversal-zone alerts";
  }
  return "no fresh lookback extreme rejection passed watch or alert thresholds";
}

function buildCandidate(
  direction: Direction,
  market: string,
  candles: readonly Candle[],
  latest: Candle,
  priorHigh: number,
  priorLow: number,
  sessionHigh: number,
  sessionLow: number,
  vwap: number,
  atr: number,
): ReversalLocation | null {
  const bullish = direction === "bullish";
  const freshExtreme = bullish
    ? latest.low <= priorLow
    : latest.high >= priorHigh;
  if (!freshExtreme || !isRejectionCandle(latest, direction)) {
    return null;
  }

  const sessionRange = sessionHigh - sessionLow;
  if (sessionRange <= 0 || atr <= 0) {
    return null;
  }
  const rangePosition = (latest.close - sessionLow) / sessionRange;
  const atExtreme = bullish
    ? rangePosition <= RANGE_EXTREME_FRACTION
    : rangePosition >= 1 - RANGE_EXTREME_FRACTION;
  if (!atExtreme) {
    return null;
  }

  const stopBuffer = Math.max(0.5, atr * 0.15);
  const invalidation = bullish
    ? latest.low - stopBuffer
    : latest.high + stopBuffer;
  const risk = Math.abs(latest.close - invalidation);
  const target = chooseMeanReversionTarget(
    direction,
    latest.close,
    vwap,
    sessionHigh,
    sessionLow,
    candles,
  );
  if (target === null || risk <= 0) {
    return null;
  }
  const reward = Math.abs(target - latest.close);
  const priceRiskReward = reward / risk;
  const averageVolume = average(
    candles.slice(-13, -1).map((candle) => candle.volume),
  );
  const volumeRatio =
    averageVolume > 0 ? latest.volume / averageVolume : 1;
  const candleRange = latest.high - latest.low;
  const wickRatio = rejectionWickRatio(latest, direction);
  const extensionInAtr = bullish
    ? Math.max(0, priorLow - latest.low) / atr
    : Math.max(0, latest.high - priorHigh) / atr;
  const policy = assessRegimePolicy({
    direction,
    latest,
    sessionHigh,
    sessionLow,
    vwap,
    atr,
    risk,
    candleRange,
    volumeRatio,
  });

  let confidenceScore = 52;
  const reasons = [
    `fresh lookback ${bullish ? "low" : "high"} rejected`,
    `close remained in the outer ${RANGE_EXTREME_FRACTION * 100}% of the observed range`,
    `invalidation is ${risk.toFixed(1)} points away`,
    `mean-reversion target ${target.toFixed(1)} offers ${priceRiskReward.toFixed(1)}R in underlying price`,
  ];
  if (wickRatio >= MINIMUM_WICK_RATIO) {
    confidenceScore += 8;
    reasons.push(`rejection wick is ${(wickRatio * 100).toFixed(0)}% of candle range`);
  }
  if (volumeRatio >= VOLUME_SPIKE_MULTIPLIER) {
    confidenceScore += 8;
    reasons.push(`volume is ${volumeRatio.toFixed(1)}x the recent average`);
  }
  if (extensionInAtr >= 0.15) {
    confidenceScore += 6;
    reasons.push(`new extreme extended ${extensionInAtr.toFixed(1)} ATR beyond the prior extreme`);
  }
  confidenceScore += Math.min(16, Math.round(priceRiskReward * 2));
  if (candleRange >= atr * 1.2) {
    confidenceScore += 5;
    reasons.push("reversal candle range is expanded versus recent ATR");
  }

  const entryPadding = Math.max(0.5, atr * 0.1);
  return {
    level: "watch",
    direction,
    market,
    price: latest.close,
    entryLow: latest.close - entryPadding,
    entryHigh: latest.close + entryPadding,
    invalidation,
    target,
    sessionHigh,
    sessionLow,
    vwap,
    priceRiskReward,
    confidenceScore: Math.min(100, confidenceScore),
    policy,
    reasons,
    timestamp: latest.endTime,
  };
}

interface RegimePolicyInput {
  direction: Direction;
  latest: Candle;
  sessionHigh: number;
  sessionLow: number;
  vwap: number;
  atr: number;
  risk: number;
  candleRange: number;
  volumeRatio: number;
}

function assessRegimePolicy(input: RegimePolicyInput): SignalPolicy {
  const sessionRange = input.sessionHigh - input.sessionLow;
  const distanceFromVwap = Math.abs(input.latest.close - input.vwap);
  const sessionRangeInAtr = sessionRange / input.atr;
  const distanceFromVwapInAtr = distanceFromVwap / input.atr;
  const riskInAtr = input.risk / input.atr;
  const expandedSession = sessionRangeInAtr >= MINIMUM_SESSION_RANGE_ATR;
  const boundedRisk = riskInAtr <= MAXIMUM_POLICY_RISK_ATR;
  const bullish = input.direction === "bullish";
  const onCorrectSideOfVwap = bullish
    ? input.latest.close < input.vwap
    : input.latest.close > input.vwap;

  if (bullish) {
    const awayFromVwap =
      distanceFromVwapInAtr >= BULLISH_MINIMUM_DISTANCE_FROM_VWAP_ATR;
    const eligible = onCorrectSideOfVwap && boundedRisk && (expandedSession || awayFromVwap);
    return {
      name: "modern_reversal_zone_v1",
      role: "bullish_reversal_zone",
      watchEligible: eligible,
      alertEligible: eligible,
      reasons: [
        "bullish-first policy: bottom reversals are the primary trade signal",
        `distance from VWAP is ${distanceFromVwapInAtr.toFixed(1)} ATR`,
        `session range is ${sessionRangeInAtr.toFixed(1)} ATR`,
        `risk is ${riskInAtr.toFixed(1)} ATR`,
        eligible
          ? "modern reversal-zone regime gate passed"
          : "held back because the reversal zone is not sufficiently displaced or risk is too wide",
      ],
    };
  }

  const awayFromVwap =
    distanceFromVwapInAtr >= BEARISH_MINIMUM_DISTANCE_FROM_VWAP_ATR;
  const stressCandle =
    input.candleRange >= input.atr * 1.2 ||
    input.volumeRatio >= VOLUME_SPIKE_MULTIPLIER;
  const eligible =
    onCorrectSideOfVwap &&
    boundedRisk &&
    expandedSession &&
    awayFromVwap &&
    stressCandle;
  return {
    name: "modern_reversal_zone_v1",
    role: "bearish_crash_monitor",
    watchEligible: eligible,
    alertEligible: eligible,
    reasons: [
      "bearish policy: retained only as a stricter crash/stress monitor",
      `distance from VWAP is ${distanceFromVwapInAtr.toFixed(1)} ATR`,
      `session range is ${sessionRangeInAtr.toFixed(1)} ATR`,
      `risk is ${riskInAtr.toFixed(1)} ATR`,
      eligible
        ? "bearish crash-monitor regime gate passed"
        : "held back because bearish reversals need expanded stress conditions",
    ],
  };
}

function isRejectionCandle(candle: Candle, direction: Direction): boolean {
  const range = candle.high - candle.low;
  if (range <= 0) {
    return false;
  }
  const bodyRatio = Math.abs(candle.close - candle.open) / range;
  const closePosition = (candle.close - candle.low) / range;
  const correctColor =
    direction === "bullish"
      ? candle.close > candle.open
      : candle.close < candle.open;
  const rejectedClose =
    direction === "bullish"
      ? closePosition >= MINIMUM_CLOSE_REJECTION
      : closePosition <= 1 - MINIMUM_CLOSE_REJECTION;
  return (
    correctColor &&
    rejectedClose &&
    (bodyRatio >= MINIMUM_BODY_RATIO ||
      rejectionWickRatio(candle, direction) >= MINIMUM_WICK_RATIO)
  );
}

function rejectionWickRatio(
  candle: Candle,
  direction: Direction,
): number {
  const range = candle.high - candle.low;
  if (range <= 0) {
    return 0;
  }
  return direction === "bullish"
    ? (Math.min(candle.open, candle.close) - candle.low) / range
    : (candle.high - Math.max(candle.open, candle.close)) / range;
}

function chooseMeanReversionTarget(
  direction: Direction,
  price: number,
  vwap: number,
  sessionHigh: number,
  sessionLow: number,
  candles: readonly Candle[],
): number | null {
  const sessionMidpoint = (sessionHigh + sessionLow) / 2;
  const openingCandles = candles.slice(0, Math.min(6, candles.length));
  const openingHigh = Math.max(...openingCandles.map((candle) => candle.high));
  const openingLow = Math.min(...openingCandles.map((candle) => candle.low));
  const targets =
    direction === "bullish"
      ? [vwap, sessionMidpoint, openingLow, openingHigh]
          .filter((target) => target > price)
          .sort((left, right) => left - right)
      : [vwap, sessionMidpoint, openingHigh, openingLow]
          .filter((target) => target < price)
          .sort((left, right) => right - left);
  return targets[0] ?? null;
}

function emptyResult(
  market: string,
  candles: readonly Candle[],
  status: string,
): ScanResult {
  return {
    watch: null,
    signal: null,
    market,
    candleCount: candles.length,
    sessionHigh: null,
    sessionLow: null,
    latestPrice: candles.at(-1)?.close ?? null,
    status,
  };
}
