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

function operationalEvidence(sessionKeys) {
  return {
    schemaVersion: 1,
    sessionKeys,
    provider: {
      requestCount: 10,
      estimatedPeakWeight60s: 44,
      budgetViolationCount: 0,
      maximumConsecutiveScheduled429s: 0,
      rateLimit429ByOperation: {
        candleSnapshot: 1,
        perpCategories: 0,
        metaAndAssetCtxs: 0,
      },
    },
    notifications: { duplicateCount: 0 },
    worker: {
      scanLatencyMsP50: 500,
      scanLatencyMsP95: 900,
      kvReadCount: 10,
      kvWriteCount: 10,
      durableObjectRequestCount: 10,
      cpuTimeMsTotal: null,
      estimatedMonthlyCostUsd: null,
    },
  };
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
    expect(result.pilotWindow).toBeNull();
    expect(result.sessions[1]).toMatchObject({
      retainedCoveragePercent: 3.85,
      duplicateTimestampCount: 1,
      outOfOrderCount: 1,
      unexpectedIntervalCount: 2,
    });
  });

  it("uses an explicit session manifest for the pilot denominator", () => {
    const fullSession = Array.from({ length: 78 }, (_, index) =>
      observation(1_000 + index * 300_000, 2_000 + index * 300_000),
    );
    const result = summarizeRthShadowAcquisition(
      snapshot([
        { sessionKey: "2026-09-15", observations: fullSession },
        { sessionKey: "2026-09-14", observations: [] },
      ]),
      ["2026-09-15", "2026-09-16"],
    );

    expect(result.pilotWindow).toMatchObject({
      expectedSessionCount: 2,
      expectedObservationCount: 156,
      observedUniqueObservationCount: 78,
      capturePercent: 50,
      missingSessionKeys: ["2026-09-16"],
      unexpectedSessionKeys: ["2026-09-14"],
      acquisitionGate: {
        status: "pending",
        criteria: { hasTenSessionWindow: false },
      },
    });
  });

  it("passes only the acquisition evidence covered by the snapshot", () => {
    const sessionKeys = Array.from(
      { length: 10 },
      (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`,
    );
    const sessions = sessionKeys.map((sessionKey, sessionIndex) => ({
      sessionKey,
      observations: Array.from({ length: 78 }, (_, index) => {
        const timestamp = sessionIndex * 100_000_000 + index * 300_000;
        return observation(timestamp, timestamp + 30_000);
      }),
    }));
    const result = summarizeRthShadowAcquisition(
      snapshot(sessions),
      sessionKeys,
    );

    expect(result.pilotWindow?.acquisitionGate).toEqual({
      status: "pass",
      criteria: {
        hasTenSessionWindow: true,
        captureAtLeast99Percent: true,
        p95DelayAtMost60Seconds: true,
        hasNoTimestampAnomalies: true,
      },
      notAssessed: [
        "provider_request_budget",
        "provider_429s",
        "duplicate_notifications",
        "worker_resource_usage",
      ],
    });
  });

  it("fails an assessable window when capture and delay miss their gates", () => {
    const sessionKeys = Array.from(
      { length: 10 },
      (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`,
    );
    const observations = Array.from({ length: 78 }, (_, index) => {
      const timestamp = 1_000 + index * 300_000;
      return observation(timestamp, timestamp + 120_000);
    });
    const result = summarizeRthShadowAcquisition(
      snapshot([{ sessionKey: sessionKeys[0], observations }]),
      sessionKeys,
    );

    expect(result.pilotWindow?.acquisitionGate).toMatchObject({
      status: "fail",
      criteria: {
        hasTenSessionWindow: true,
        captureAtLeast99Percent: false,
        p95DelayAtMost60Seconds: false,
      },
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

  it("rejects duplicate or malformed expected session keys", () => {
    expect(() =>
      summarizeRthShadowAcquisition(snapshot([]), [
        "2026-09-15",
        "2026-09-15",
      ]),
    ).toThrow("expected sessions must be unique YYYY-MM-DD strings");
    expect(() =>
      summarizeRthShadowAcquisition(snapshot([]), ["09/15/2026"]),
    ).toThrow("expected sessions must be unique YYYY-MM-DD strings");
  });

  it("includes sanitized operational evidence when supplied", () => {
    const result = summarizeRthShadowAcquisition(
      snapshot([]),
      ["2026-09-15"],
      operationalEvidence(["2026-09-15"]),
    );

    expect(result.operationalEvidence).toMatchObject({
      sessionWindow: { matchesExpected: true },
      provider: { rateLimit429Total: 1 },
      notifications: { duplicateCount: 0 },
    });
  });
});
