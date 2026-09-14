import { describe, expect, it } from "vitest";

import {
  buildRthShadowObservations,
  exportRthShadowAcquisition,
  MAX_RTH_SHADOW_STATE_BYTES,
  mergeRthShadowAcquisitionState,
  recordRthShadowAcquisition,
  rthShadowAcquisitionKey,
  type RthShadowObservationCandidate,
} from "../src/rth-shadow-acquisition";
import type { Candle } from "../src/types";

describe("five-minute RTH shadow acquisition", () => {
  it("labels delayed catch-up rows with their true acquisition time", () => {
    const acquiredAt = Date.parse("2026-07-23T14:00:00Z");
    const observations = buildRthShadowObservations(
      Array.from({ length: 3 }, (_, index) => candleAt(index)),
      acquiredAt,
    );

    expect(observations).toHaveLength(3);
    expect(observations.map((row) => row.acquiredAt)).toEqual([
      acquiredAt,
      acquiredAt,
      acquiredAt,
    ]);
    expect(observations[0]?.context).toEqual({
      status: "not_collected",
      fetchedAt: null,
      providerTimestamp: null,
      availableIndicatorCount: 0,
    });
  });

  it("keeps separate watermarks and does not rewrite earlier rows", () => {
    const candidates = Array.from({ length: 3 }, (_, index) =>
      observation("2026-07-23", index)
    );
    const first = mergeRthShadowAcquisitionState(
      null,
      "xyz:SP500",
      candidates.slice(0, 2),
    );
    const catchUp = mergeRthShadowAcquisitionState(
      first.state,
      "xyz:SP500",
      candidates,
    );

    expect(catchUp.recordedObservationCount).toBe(1);
    expect(catchUp.ignoredObservationCount).toBe(2);
    expect(catchUp.state.sessions[0]?.observations).toHaveLength(3);
  });

  it("retains at most 78 rows for each of 60 sessions and exports NDJSON", () => {
    const candidates = Array.from({ length: 61 }, (_, sessionIndex) => {
      const sessionKey = new Date(
        Date.UTC(2026, 0, sessionIndex + 1),
      ).toISOString().slice(0, 10);
      return Array.from({ length: 80 }, (_, index) =>
        observation(sessionKey, index)
      );
    }).flat();
    const merged = mergeRthShadowAcquisitionState(
      null,
      "xyz:SP500",
      candidates,
    );

    expect(merged.state.sessions).toHaveLength(60);
    expect(
      merged.state.sessions.every(
        (session) => session.observations.length === 78,
      ),
    ).toBe(true);
    expect(merged.serializedBytes).toBeLessThanOrEqual(
      MAX_RTH_SHADOW_STATE_BYTES,
    );
    const rows = exportRthShadowAcquisition(merged.state).split("\n");
    expect(rows).toHaveLength(60 * 78);
    expect(JSON.parse(rows[0] ?? "{}")).toMatchObject({
      schemaVersion: 1,
      measurementVersion: "market-fragility-price-only/v1",
      source: "hyperliquid",
      market: "xyz:SP500",
      intervalMinutes: 5,
      context: { status: "not_collected", fetchedAt: null },
    });
  });

  it("enforces the byte ceiling independently of session retention", () => {
    const candidates = Array.from({ length: 60 }, (_, index) =>
      observation(`${"x".repeat(150_000)}${index}`, 0)
    );
    const merged = mergeRthShadowAcquisitionState(
      null,
      "xyz:SP500",
      candidates,
    );

    expect(merged.serializedBytes).toBeLessThanOrEqual(
      MAX_RTH_SHADOW_STATE_BYTES,
    );
    expect(merged.state.sessions.length).toBeLessThan(60);
  });

  it("uses an independent key and recovers corrupt state", async () => {
    const values = new Map<string, string>([[
      rthShadowAcquisitionKey("xyz:SP500"),
      "not-json",
    ]]);
    const storage = {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => values.set(key, value),
    } as unknown as KVNamespace;

    const update = await recordRthShadowAcquisition(
      storage,
      "xyz:SP500",
      Date.parse("2026-07-23T13:35:00Z"),
      [candleAt(0)],
    );

    expect(update.recoveredCorruptState).toBe(true);
    expect(update.recordedObservationCount).toBe(1);
    expect(rthShadowAcquisitionKey("xyz:SP500")).not.toContain(
      "market-fragility-v2-shadow",
    );
  });
});

function candleAt(index: number): Candle {
  const startTime = Date.parse("2026-07-23T13:30:00Z") + index * 5 * 60_000;
  return {
    startTime,
    endTime: startTime + 5 * 60_000 - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100 - index * 0.1,
    volume: 10,
    tradeCount: 1,
  };
}

function observation(
  sessionKey: string,
  index: number,
): RthShadowObservationCandidate {
  return {
    sessionKey,
    candleEndTime: index * 5 * 60_000,
    acquiredAt: index * 5 * 60_000 + 1,
    close: 100,
    level: "resilient",
    score: 0,
    availablePriceIndicatorCount: 4,
    priceIndicators: [
      "session_loss",
      "vwap_repair_failure",
      "poor_close_location",
      "downside_tail_cluster",
    ].map((id) => ({
      id: id as RthShadowObservationCandidate["priceIndicators"][number]["id"],
      state: "healthy",
      value: 0,
      unavailableReason: null,
    })),
    context: {
      status: "not_collected",
      fetchedAt: null,
      providerTimestamp: null,
      availableIndicatorCount: 0,
    },
  };
}
