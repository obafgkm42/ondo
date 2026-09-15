import { describe, expect, it } from "vitest";

import {
  summarizeStageBOperationalEvidence,
  validateStageBOperationalEvidence,
} from "../scripts/stage-b-operational-evidence.mjs";

function evidence() {
  return {
    schemaVersion: 1,
    sessionKeys: ["2026-09-15"],
    provider: {
      requestCount: 197,
      estimatedPeakWeight60s: 44,
      budgetViolationCount: 0,
      maximumConsecutiveScheduled429s: 0,
      rateLimit429ByOperation: {
        candleSnapshot: 0,
        perpCategories: 0,
        metaAndAssetCtxs: 0,
      },
    },
    notifications: { duplicateCount: 0 },
    worker: {
      scanLatencyMsP50: 500,
      scanLatencyMsP95: 900,
      kvReadCount: 78,
      kvWriteCount: 78,
      durableObjectRequestCount: 197,
      cpuTimeMsTotal: null,
      estimatedMonthlyCostUsd: null,
    },
  };
}

describe("Stage B operational evidence", () => {
  it("accepts a sanitized manifest with unavailable resource metrics", () => {
    const value = evidence();

    expect(validateStageBOperationalEvidence(value)).toBe(value);
  });

  it("summarizes the matching window and endpoint 429 total", () => {
    const result = summarizeStageBOperationalEvidence(
      evidence(),
      ["2026-09-15", "2026-09-16"],
    );

    expect(result.sessionWindow).toEqual({
      matchesExpected: false,
      missingSessionKeys: ["2026-09-16"],
      unexpectedSessionKeys: [],
    });
    expect(result.provider.rateLimit429Total).toBe(0);
    expect(result.operationalGate.status).toBe("pending");
  });

  it("passes a complete clean window and fails a stop condition", () => {
    const sessionKeys = Array.from(
      { length: 10 },
      (_, index) => `2026-09-${String(index + 1).padStart(2, "0")}`,
    );
    const value = evidence();
    value.sessionKeys = sessionKeys;
    value.worker.cpuTimeMsTotal = 12;
    value.worker.estimatedMonthlyCostUsd = 0.03;

    expect(
      summarizeStageBOperationalEvidence(value, sessionKeys).operationalGate,
    ).toMatchObject({ status: "pass" });

    value.provider.maximumConsecutiveScheduled429s = 3;
    expect(
      summarizeStageBOperationalEvidence(value, sessionKeys).operationalGate,
    ).toMatchObject({
      status: "fail",
      criteria: { belowScheduled429StopThreshold: false },
    });
  });

  it("rejects missing provider operation counts", () => {
    const value = evidence();
    delete value.provider.rateLimit429ByOperation.perpCategories;

    expect(() => validateStageBOperationalEvidence(value)).toThrow(
      "operational evidence does not match the stage B v1 contract",
    );
  });

  it("rejects invalid dates, negative counts, and inverted latency", () => {
    expect(() =>
      validateStageBOperationalEvidence({
        ...evidence(),
        sessionKeys: ["2026-09-31"],
      }),
    ).toThrow("operational evidence does not match the stage B v1 contract");
    expect(() =>
      validateStageBOperationalEvidence({
        ...evidence(),
        notifications: { duplicateCount: -1 },
      }),
    ).toThrow("operational evidence does not match the stage B v1 contract");
    expect(() =>
      validateStageBOperationalEvidence({
        ...evidence(),
        worker: {
          ...evidence().worker,
          scanLatencyMsP50: 1_000,
          scanLatencyMsP95: 900,
        },
      }),
    ).toThrow("operational evidence does not match the stage B v1 contract");
  });
});
