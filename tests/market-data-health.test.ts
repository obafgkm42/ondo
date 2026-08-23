import { describe, expect, it } from "vitest";

import {
  assessMarketDataHealth,
  formatIneligibleMarketDataStatus,
} from "../src/market-data-health";
import type { Candle } from "../src/types";

describe("market data health", () => {
  it("accepts a fresh contiguous RTH series", () => {
    const now = new Date("2026-08-21T14:00:00.000Z");
    const health = assessMarketDataHealth(
      [candleAt("2026-08-21T13:50:00.000Z"), candleAt("2026-08-21T13:55:00.000Z")],
      now,
      "rth",
    );

    expect(health).toMatchObject({
      status: "healthy",
      lagIntervals: 0,
      gapCount: 0,
      stateEligible: true,
      reasons: [],
    });
  });

  it("fails closed when the latest completed candle is stale", () => {
    const health = assessMarketDataHealth(
      [candleAt("2026-08-21T13:50:00.000Z")],
      new Date("2026-08-21T14:00:00.000Z"),
      "rth",
    );

    expect(health).toMatchObject({
      status: "stale",
      lagIntervals: 1,
      stateEligible: false,
    });
  });

  it("reports gaps without mistaking them for calm activity", () => {
    const health = assessMarketDataHealth(
      [candleAt("2026-08-21T13:45:00.000Z"), candleAt("2026-08-21T13:55:00.000Z")],
      new Date("2026-08-21T14:00:00.000Z"),
      "rth",
    );

    expect(health).toMatchObject({
      status: "degraded",
      gapCount: 1,
      missingIntervals: 1,
      stateEligible: false,
    });
  });

  it("keeps fresh overnight data visible but ineligible", () => {
    const health = assessMarketDataHealth(
      [candleAt("2026-08-21T22:55:00.000Z")],
      new Date("2026-08-21T23:00:00.000Z"),
      "overnight",
    );

    expect(health).toMatchObject({
      status: "healthy",
      sessionScope: "overnight",
      stateEligible: false,
    });
    expect(health.reasons).toContain(
      "overnight market-state policy is not validated",
    );
    expect(formatIneligibleMarketDataStatus(health, "zh")).toBe(
      "即時決策已停用：市場資料 HEALTHY · OVERNIGHT。",
    );
  });
});

function candleAt(timestamp: string): Candle {
  const startTime = Date.parse(timestamp);
  return {
    startTime,
    endTime: startTime + 5 * 60_000 - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    tradeCount: 1,
  };
}
