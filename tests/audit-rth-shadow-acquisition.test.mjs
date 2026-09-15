import { describe, expect, it } from "vitest";

import {
  summarizeRthShadowAcquisition,
} from "../scripts/audit-rth-shadow-acquisition.mjs";

function snapshot(sessions) {
  return {
    version: 1,
    measurementVersion: "market-fragility-price-only/v1",
    source: "hyperliquid",
    market: "xyz:SP500",
    intervalMinutes: 5,
    sessions,
  };
}

function observation(candleEndTime, acquiredAt) {
  return { candleEndTime, acquiredAt };
}

describe("stage B acquisition audit", () => {
  it("summarizes retained coverage, ordering, duplicates, and delay", () => {
    const fullSession = Array.from({ length: 78 }, (_, index) =>
      observation(1_000 + index * 300_000, 2_000 + index * 300_000),
    );
    const result = summarizeRthShadowAcquisition(
      snapshot([
        { sessionKey: "2026-09-15", observations: fullSession },
        {
          sessionKey: "2026-09-16",
          observations: [
            observation(30_000_000, 30_002_000),
            observation(30_000_000, 29_999_000),
            observation(29_000_000, 29_004_000),
          ],
        },
      ]),
    );

    expect(result).toMatchObject({
      retainedSessionCount: 2,
      retainedObservationCount: 81,
      completeGridSessionCount: 1,
      duplicateTimestampCount: 1,
      outOfOrderCount: 1,
      unexpectedIntervalCount: 2,
      acquisitionDelayMs: {
        validSampleCount: 80,
        negativeCount: 1,
        p50: 1_000,
        p95: 1_000,
        max: 4_000,
      },
    });
    expect(result.sessions[0].retainedCoveragePercent).toBe(100);
    expect(result.sessions[1]).toMatchObject({
      retainedCoveragePercent: 3.85,
      duplicateTimestampCount: 1,
      outOfOrderCount: 1,
      unexpectedIntervalCount: 2,
    });
  });

  it("reports empty delay percentiles without inventing values", () => {
    const result = summarizeRthShadowAcquisition(snapshot([]));

    expect(result.acquisitionDelayMs).toEqual({
      validSampleCount: 0,
      negativeCount: 0,
      p50: null,
      p95: null,
      max: null,
    });
  });

  it("rejects snapshots outside the stage B v1 contract", () => {
    expect(() =>
      summarizeRthShadowAcquisition({
        ...snapshot([]),
        measurementVersion: "unknown",
      }),
    ).toThrow("snapshot metadata does not match the stage B v1 contract");
  });
});
