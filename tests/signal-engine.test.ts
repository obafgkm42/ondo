import { describe, expect, it } from "vitest";

import {
  analyzeSession,
  findNotificationOpportunities,
} from "../src/signal-engine";
import type { Candle } from "../src/types";

describe("analyzeSession", () => {
  it("finds a bullish fresh-low rejection with asymmetric price risk", () => {
    const candles = [
      candle(0, 100, 102, 99, 101, 100),
      candle(1, 101, 103, 100, 102, 100),
      candle(2, 102, 104, 101, 103, 100),
      candle(3, 103, 104, 100, 101, 100),
      candle(4, 101, 102, 98, 99, 100),
      candle(5, 99, 100, 97, 98, 100),
      candle(6, 98, 99, 96, 97, 100),
      candle(7, 97, 98, 95, 96, 100),
      candle(8, 96, 97, 94, 95, 100),
      candle(9, 91.5, 93.8, 91, 93.5, 220),
    ];

    const result = analyzeSession("xyz:SP500", candles, {
      minimumWatchPriceR: 1,
      minimumWatchConfidenceScore: 60,
      minimumPriceR: 1,
      minimumConfidenceScore: 60,
    });

    expect(result.watch).toBeNull();
    expect(result.signal?.direction).toBe("bullish");
    expect(result.signal?.level).toBe("alert");
    expect(result.signal?.invalidation).toBeLessThan(91);
    expect(result.signal?.target).toBeGreaterThan(93.5);
  });

  it("promotes an imperfect reversal to watch before alert", () => {
    const candles = [
      candle(0, 100, 102, 99, 101, 100),
      candle(1, 101, 103, 100, 102, 100),
      candle(2, 102, 104, 101, 103, 100),
      candle(3, 103, 104, 100, 101, 100),
      candle(4, 101, 102, 98, 99, 100),
      candle(5, 99, 100, 97, 98, 100),
      candle(6, 98, 99, 96, 97, 100),
      candle(7, 97, 98, 95, 96, 100),
      candle(8, 96, 97, 94, 95, 100),
      candle(9, 91.5, 93.8, 91, 93.5, 220),
    ];

    const result = analyzeSession("xyz:SP500", candles, {
      minimumWatchPriceR: 1,
      minimumWatchConfidenceScore: 60,
      minimumPriceR: 4,
      minimumConfidenceScore: 90,
    });

    expect(result.signal).toBeNull();
    expect(result.watch?.level).toBe("watch");
    expect(result.watch?.direction).toBe("bullish");
    expect(result.status).toContain("watch-level");
  });

  it("does not turn an ordinary middle-of-range candle into a signal", () => {
    const candles = [
      candle(0, 100, 102, 99, 101, 100),
      candle(1, 101, 103, 100, 102, 100),
      candle(2, 102, 104, 101, 103, 100),
      candle(3, 103, 105, 102, 104, 100),
      candle(4, 104, 106, 103, 105, 100),
      candle(5, 105, 106, 100, 103, 100),
      candle(6, 103, 104, 101, 102, 100),
    ];

    const result = analyzeSession("xyz:SP500", candles, {
      minimumWatchPriceR: 1,
      minimumWatchConfidenceScore: 0,
      minimumPriceR: 1,
      minimumConfidenceScore: 0,
    });

    expect(result.watch).toBeNull();
    expect(result.signal).toBeNull();
  });

  it("holds bearish reversals unless the crash-monitor regime gate passes", () => {
    const candles = [
      candle(0, 95, 101, 90, 100, 100),
      candle(1, 100, 101, 99, 100.5, 100),
      candle(2, 100.5, 101.5, 100, 101, 100),
      candle(3, 101, 102, 100.5, 101.5, 100),
      candle(4, 101.5, 102.5, 101, 102, 100),
      candle(5, 102, 103, 101.5, 102.5, 100),
      candle(6, 103.8, 104, 102.2, 102.4, 100),
    ];

    const result = analyzeSession("xyz:SP500", candles, {
      minimumWatchPriceR: 0,
      minimumWatchConfidenceScore: 0,
      minimumPriceR: 0,
      minimumConfidenceScore: 0,
    });

    expect(result.signal).toBeNull();
    expect(result.watch).toBeNull();
    expect(result.status).toContain("regime policy kept it out");
  });

  it("catches a qualifying middle candle that is stale by the next boundary", () => {
    const candles = [
      candle(0, 100, 102, 99, 101, 100),
      candle(1, 101, 103, 100, 102, 100),
      candle(2, 102, 104, 101, 103, 100),
      candle(3, 103, 104, 100, 101, 100),
      candle(4, 101, 102, 98, 99, 100),
      candle(5, 99, 100, 97, 98, 100),
      candle(6, 98, 99, 96, 97, 100),
      candle(7, 97, 98, 95, 96, 100),
      candle(8, 96, 97, 94, 95, 100),
      candle(9, 91.5, 93.8, 91, 93.5, 220),
      candle(10, 93.5, 94, 92.5, 93.7, 100),
      candle(11, 93.7, 94.5, 93, 94, 100),
    ];
    const thresholds = {
      minimumWatchPriceR: 1,
      minimumWatchConfidenceScore: 60,
      minimumPriceR: 1,
      minimumConfidenceScore: 60,
    };

    const latestResult = analyzeSession("xyz:SP500", candles, thresholds);
    const opportunities = findNotificationOpportunities(
      "xyz:SP500",
      candles,
      thresholds,
      candles[9]?.startTime ?? 0,
      (candles.at(-1)?.endTime ?? 0) + 1,
    );

    expect(latestResult.signal).toBeNull();
    expect(latestResult.watch).toBeNull();
    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.signal.timestamp).toBe(
      candles[9]?.endTime,
    );
    expect(opportunities[0]?.signal.direction).toBe("bullish");
    expect(opportunities[0]?.status).toBe("fresh");
  });

  it("marks a catch-up signal stale after price leaves its entry zone", () => {
    const candles = [
      candle(0, 100, 102, 99, 101, 100),
      candle(1, 101, 103, 100, 102, 100),
      candle(2, 102, 104, 101, 103, 100),
      candle(3, 103, 104, 100, 101, 100),
      candle(4, 101, 102, 98, 99, 100),
      candle(5, 99, 100, 97, 98, 100),
      candle(6, 98, 99, 96, 97, 100),
      candle(7, 97, 98, 95, 96, 100),
      candle(8, 96, 97, 94, 95, 100),
      candle(9, 91.5, 93.8, 91, 93.5, 220),
      candle(10, 93.5, 96, 93.4, 95.5, 100),
    ];
    const thresholds = {
      minimumWatchPriceR: 1,
      minimumWatchConfidenceScore: 60,
      minimumPriceR: 1,
      minimumConfidenceScore: 60,
    };

    const opportunities = findNotificationOpportunities(
      "xyz:SP500",
      candles,
      thresholds,
      candles[9]?.startTime ?? 0,
      (candles.at(-1)?.endTime ?? 0) + 1,
    );

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.status).toBe("outside_entry_zone");
    expect(opportunities[0]?.observedPrice).toBe(95.5);
  });

  it("marks a catch-up signal invalid after its stop is touched", () => {
    const candles = [
      candle(0, 100, 102, 99, 101, 100),
      candle(1, 101, 103, 100, 102, 100),
      candle(2, 102, 104, 101, 103, 100),
      candle(3, 103, 104, 100, 101, 100),
      candle(4, 101, 102, 98, 99, 100),
      candle(5, 99, 100, 97, 98, 100),
      candle(6, 98, 99, 96, 97, 100),
      candle(7, 97, 98, 95, 96, 100),
      candle(8, 96, 97, 94, 95, 100),
      candle(9, 91.5, 93.8, 91, 93.5, 220),
      candle(10, 93.5, 94, 89, 93.5, 100),
    ];
    const thresholds = {
      minimumWatchPriceR: 1,
      minimumWatchConfidenceScore: 60,
      minimumPriceR: 1,
      minimumConfidenceScore: 60,
    };

    const opportunities = findNotificationOpportunities(
      "xyz:SP500",
      candles,
      thresholds,
      candles[9]?.startTime ?? 0,
      (candles.at(-1)?.endTime ?? 0) + 1,
    );

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0]?.status).toBe(
      "invalidated_before_delivery",
    );
  });
});

function candle(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): Candle {
  return {
    startTime: index * 300_000,
    endTime: index * 300_000 + 299_999,
    open,
    high,
    low,
    close,
    volume,
    tradeCount: 10,
  };
}
