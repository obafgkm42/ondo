import { describe, expect, it } from "vitest";

import {
  clearRateLimitIncident,
  getLastSuccessfulCandleEnd,
  isRateLimitIncidentActive,
  markRateLimitIncidentActive,
  markSignalSent,
  setLastSuccessfulCandleEnd,
  wasSignalSent,
} from "../src/scanner-state";
import type { ReversalLocation } from "../src/types";

describe("scanner state", () => {
  it("persists the last successfully covered candle", async () => {
    const state = memoryKv();

    expect(
      await getLastSuccessfulCandleEnd(state, "xyz:SP500"),
    ).toBeNull();
    await setLastSuccessfulCandleEnd(
      state,
      "xyz:SP500",
      1_700_000_000_000,
    );

    expect(
      await getLastSuccessfulCandleEnd(state, "xyz:SP500"),
    ).toBe(1_700_000_000_000);
  });

  it("deduplicates an exact signal after it is sent", async () => {
    const state = memoryKv();
    const signal = opportunity();

    expect(await wasSignalSent(state, signal)).toBe(false);
    await markSignalSent(state, signal);
    expect(await wasSignalSent(state, signal)).toBe(true);
  });

  it("tracks a rate-limit incident until a scan clears it", async () => {
    const state = memoryKv();

    expect(
      await isRateLimitIncidentActive(state, "xyz:SP500"),
    ).toBe(false);
    await markRateLimitIncidentActive(state, "xyz:SP500");
    expect(
      await isRateLimitIncidentActive(state, "xyz:SP500"),
    ).toBe(true);
    await clearRateLimitIncident(state, "xyz:SP500");
    expect(
      await isRateLimitIncidentActive(state, "xyz:SP500"),
    ).toBe(false);
  });

  it("uses an in-memory incident fallback without KV", async () => {
    const market = "xyz:SP500-fallback";

    await markRateLimitIncidentActive(undefined, market);
    expect(await isRateLimitIncidentActive(undefined, market)).toBe(true);
    await clearRateLimitIncident(undefined, market);
    expect(await isRateLimitIncidentActive(undefined, market)).toBe(false);
  });
});

function memoryKv(): KVNamespace {
  const values = new Map<string, string>();
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  } as unknown as KVNamespace;
}

function opportunity(): ReversalLocation {
  return {
    level: "alert",
    direction: "bullish",
    market: "xyz:SP500",
    price: 100,
    entryLow: 99,
    entryHigh: 101,
    invalidation: 95,
    target: 110,
    sessionHigh: 110,
    sessionLow: 95,
    vwap: 105,
    priceRiskReward: 2,
    confidenceScore: 80,
    policy: {
      name: "modern_reversal_zone_v1",
      role: "bullish_reversal_zone",
      alertEligible: true,
      watchEligible: true,
      reasons: [],
    },
    reasons: [],
    timestamp: 1_700_000_000_000,
  };
}
