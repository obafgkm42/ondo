import { describe, expect, it } from "vitest";

import {
  calculateResilienceEventScore,
  calculateResilienceMetrics,
  updateResilienceDecayState,
  updateResilienceDecayStateBatch,
} from "../src/resilience-decay";
import type {
  ResilienceDecayState,
  ResiliencePriceSnapshot,
  ResilienceShockEvent,
} from "../src/types";

describe("resilience decay state", () => {
  it("logs a shock, trough, and raw one-hour, two-hour, and close observations", async () => {
    const state = countingMemoryKv();
    const sessionKey = "2026-08-04";

    await record(state, snapshot(sessionKey, 0, 100, 100));
    const started = await record(state, snapshot(sessionKey, 30, 99.4, 100));
    expect(started.shockStarted).toBe(true);
    await record(state, snapshot(sessionKey, 60, 98.8, 100));
    await record(state, snapshot(sessionKey, 90, 99.5, 100));
    await record(state, snapshot(sessionKey, 150, 99.7, 100));
    const closed = await record(
      state,
      snapshot(sessionKey, 390, 100, 100, true),
    );

    const event = closed.state?.completedShocks.at(-1);
    expect(event).toMatchObject({
      triggerPrice: 99.4,
      troughPrice: 98.8,
      oneHourPrice: 99.5,
      oneHourTroughPrice: 98.8,
      twoHourPrice: 99.7,
      twoHourTroughPrice: 98.8,
      closePrice: 100,
      closeTroughPrice: 98.8,
      completionReason: "recovered",
    });
    expect(closed.state?.activeShock).toBeNull();
  });

  it("keeps only the current session snapshots and the latest twelve shocks", async () => {
    const state = countingMemoryKv();

    for (let day = 0; day < 13; day += 1) {
      const sessionKey = `2026-08-${String(day + 1).padStart(2, "0")}`;
      await record(state, snapshot(sessionKey, 0, 100, 100));
      await record(state, snapshot(sessionKey, 30, 99, 100));
      await record(
        state,
        snapshot(sessionKey, 60, 100, 100, true),
      );
    }

    const saved = await readState(state);
    expect(saved.snapshots).toHaveLength(3);
    expect(
      saved.snapshots.every((item) => item.sessionKey === "2026-08-13"),
    ).toBe(true);
    expect(saved.sessionKey).toBe("2026-08-13");
    expect(saved.completedShocks).toHaveLength(12);
    expect(saved.completedShocks[0]?.sessionKey).toBe("2026-08-02");
  });

  it("skips the write when a snapshot was already recorded", async () => {
    const state = countingMemoryKv();
    const priceSnapshot = snapshot("2026-08-04", 0, 100, 100);

    await updateResilienceDecayState(
      state,
      "xyz:SP500",
      priceSnapshot,
    );
    const repeated = await updateResilienceDecayState(
      state,
      "xyz:SP500",
      priceSnapshot,
    );

    expect(repeated.changed).toBe(false);
    expect(repeated.ignoredReason).toBe("duplicate");
    expect(state.getCount).toBe(2);
    expect(state.putCount).toBe(1);
    expect(repeated.approximateCpuMs).toBeGreaterThanOrEqual(0);
  });

  it("catches up an ordered batch with one KV read and write", async () => {
    const state = countingMemoryKv();
    const sessionKey = "2026-08-04";
    const firstSnapshot = snapshot(sessionKey, 0, 100, 100);
    await record(state, firstSnapshot);

    const caughtUp = await updateResilienceDecayStateBatch(
      state,
      "xyz:SP500",
      [
        firstSnapshot,
        snapshot(sessionKey, 30, 99.5, 100),
        snapshot(sessionKey, 60, 99, 100),
      ],
    );

    expect(caughtUp.changed).toBe(true);
    expect(caughtUp.recordedSnapshotCount).toBe(2);
    expect(caughtUp.ignoredSnapshotCount).toBe(1);
    expect(caughtUp.state?.snapshots).toHaveLength(3);
    expect(state.getCount).toBe(2);
    expect(state.putCount).toBe(2);
  });

  it("keeps five-minute shadow state separate and rejects late starts", async () => {
    const state = countingMemoryKv();
    const sessionKey = "2026-08-04";
    const lateSnapshot = {
      ...snapshot(sessionKey, 300, 99, 100),
      twoHourCheckpointEligible: false,
    };

    const shadow = await updateResilienceDecayStateBatch(
      state,
      "xyz:SP500",
      [lateSnapshot],
      {
        keyPrefix: "resilience-decay-shadow-5m",
        requireTwoHourEligibleStart: true,
      },
    );

    expect(shadow.shockStarted).toBe(false);
    expect(shadow.state?.activeShock).toBeNull();
    expect(
      await state.get("resilience-decay-shadow-5m:xyz:SP500"),
    ).not.toBeNull();
    expect(await state.get("resilience-decay:xyz:SP500")).toBeNull();
  });

  it("allows an eligible five-minute shadow shock to start", async () => {
    const state = countingMemoryKv();
    const eligibleSnapshot = {
      ...snapshot("2026-08-04", 30, 99, 100),
      twoHourCheckpointEligible: true,
    };

    const shadow = await updateResilienceDecayStateBatch(
      state,
      "xyz:SP500",
      [eligibleSnapshot],
      {
        keyPrefix: "resilience-decay-shadow-5m",
        requireTwoHourEligibleStart: true,
      },
    );

    expect(shadow.shockStarted).toBe(true);
    expect(shadow.state?.activeShock).not.toBeNull();
  });

  it("writes a full five-minute RTH batch with one KV read and write", async () => {
    const state = countingMemoryKv();
    const sessionKey = "2026-08-04";
    const snapshots = Array.from({ length: 78 }, (_value, index) => ({
      ...snapshot(
        sessionKey,
        index * 5,
        100,
        100,
        index === 77,
      ),
      twoHourCheckpointEligible: index <= 54,
    }));

    const shadow = await updateResilienceDecayStateBatch(
      state,
      "xyz:SP500",
      snapshots,
      {
        keyPrefix: "resilience-decay-shadow-5m",
        requireTwoHourEligibleStart: true,
      },
    );

    expect(shadow.recordedSnapshotCount).toBe(78);
    expect(shadow.state?.snapshots).toHaveLength(78);
    expect(state.getCount).toBe(1);
    expect(state.putCount).toBe(1);
  });

  it("hard-caps retained current-session snapshots at 78", async () => {
    const state = countingMemoryKv();
    const sessionKey = "2026-08-04";
    const snapshots = Array.from({ length: 80 }, (_value, index) => ({
      ...snapshot(sessionKey, index * 5, 100, 100),
      twoHourCheckpointEligible: true,
    }));

    const update = await updateResilienceDecayStateBatch(
      state,
      "xyz:SP500",
      snapshots,
    );

    expect(update.recordedSnapshotCount).toBe(80);
    expect(update.state?.snapshots).toHaveLength(78);
    expect(update.state?.snapshots[0]?.timestamp).toBe(
      snapshots[2]?.timestamp,
    );
  });

  it("applies the weighted event score to the three recovery ratios", () => {
    const score = calculateResilienceEventScore(
      completedEvent("weighted", 100, 90, 100, 90, 95),
    );

    expect(score).toMatchObject({
      oneHourRecoveryRatio: 1,
      twoHourRecoveryRatio: 0,
      closeRecoveryRatio: 0.5,
      eventScore: 45,
    });
  });

  it("uses only the trough visible at each checkpoint", () => {
    const event = {
      ...completedEvent("checkpoint-troughs", 100, 90, 96, 92, 95),
      oneHourTroughPrice: 94,
      twoHourTroughPrice: 90,
      closeTroughPrice: 90,
    };

    const score = calculateResilienceEventScore(event);

    expect(score?.oneHourRecoveryRatio).toBeCloseTo(1 / 3);
    expect(score?.twoHourRecoveryRatio).toBeCloseTo(0.2);
    expect(score?.closeRecoveryRatio).toBeCloseTo(0.5);
  });

  it("freezes a recovered event trough before a later sell-off", async () => {
    const state = countingMemoryKv();
    const sessionKey = "2026-08-04";

    await record(state, snapshot(sessionKey, 0, 100, 100));
    await record(state, snapshot(sessionKey, 30, 99, 100));
    await record(state, snapshot(sessionKey, 60, 99.5, 100));
    const laterSellOff = await record(
      state,
      snapshot(sessionKey, 90, 98, 100),
    );

    expect(laterSellOff.state?.completedShocks[0]).toMatchObject({
      troughPrice: 99,
      oneHourPrice: 98,
      oneHourTroughPrice: 99,
      completionReason: "recovered",
    });
    expect(laterSellOff.state?.activeShock?.troughPrice).toBe(98);
  });

  it("keeps a checkpoint trough fixed when the active shock deepens later", async () => {
    const state = countingMemoryKv();
    const sessionKey = "2026-08-04";

    await record(state, snapshot(sessionKey, 0, 100, 100));
    await record(state, snapshot(sessionKey, 30, 99, 100));
    await record(state, snapshot(sessionKey, 90, 99, 100));
    await record(state, snapshot(sessionKey, 120, 95, 100));
    const twoHours = await record(
      state,
      snapshot(sessionKey, 150, 96, 100),
    );

    expect(twoHours.state?.activeShock).toMatchObject({
      troughPrice: 95,
      oneHourPrice: 99,
      oneHourTroughPrice: 99,
      twoHourPrice: 96,
      twoHourTroughPrice: 95,
    });
  });

  it("ignores out-of-order snapshots instead of rewinding state", async () => {
    const state = countingMemoryKv();
    const sessionKey = "2026-08-04";

    await record(state, snapshot(sessionKey, 60, 99, 100));
    const stale = await record(
      state,
      snapshot(sessionKey, 30, 98, 100),
    );

    expect(stale.changed).toBe(false);
    expect(stale.ignoredReason).toBe("out_of_order");
    expect(stale.state?.snapshots).toHaveLength(1);
    expect(state.putCount).toBe(1);
  });

  it("calculates recent, baseline, slope, and bounded decay metrics", () => {
    const eventScores = [80, 78, 75, 72, 70, 60, 55, 50];
    const metrics = calculateResilienceMetrics({
      version: 2,
      market: "xyz:SP500",
      sessionKey: "2026-08-04",
      snapshots: [],
      activeShock: null,
      completedShocks: eventScores.map((score, index) =>
        completedEvent(
          `event-${index}`,
          100,
          90,
          90 + score / 10,
          90 + score / 10,
          90 + score / 10,
        ),
      ),
    });

    expect(metrics.status).toBe("FADING");
    expect(metrics.recentResilience).toBe(55);
    expect(metrics.baselineResilience).toBe(75);
    expect(metrics.decayDelta).toBe(-20);
    expect(metrics.recentEventScoreSlope).toBe(-5);
    expect(metrics.decayScore).toBe(50);
    expect(metrics.unscoredShockCount).toBe(0);
  });

  it("does not classify until three recent and five baseline shocks are scored", () => {
    const metrics = calculateResilienceMetrics({
      version: 2,
      market: "xyz:SP500",
      sessionKey: "2026-08-04",
      snapshots: [],
      activeShock: null,
      completedShocks: [
        completedEvent("event-1", 100, 90, 100, 100, 100),
        completedEvent("event-2", 100, 90, 100, 100, 100),
      ],
    });

    expect(metrics.status).toBe("INSUFFICIENT_DATA");
    expect(metrics.recentResilience).toBeNull();
    expect(metrics.baselineResilience).toBeNull();
    expect(metrics.decayDelta).toBeNull();
    expect(metrics.scoredShockCount).toBe(2);
    expect(metrics.unscoredShockCount).toBe(0);
  });

  it.each([
    { baseline: 70, recent: 54.99, status: "FRAGILE" },
    { baseline: 70, recent: 55, status: "FADING" },
    { baseline: 69.99, recent: 55, status: "RESILIENT" },
  ] as const)(
    "classifies the absolute and decay boundaries as $status",
    ({ baseline, recent, status }) => {
      const metrics = calculateResilienceMetrics({
        version: 2,
        market: "xyz:SP500",
        sessionKey: "2026-08-04",
        snapshots: [],
        activeShock: null,
        completedShocks: [
          ...Array.from({ length: 5 }, (_value, index) =>
            eventWithScore(`baseline-${index}`, baseline, index),
          ),
          ...Array.from({ length: 3 }, (_value, index) =>
            eventWithScore(`recent-${index}`, recent, index + 5),
          ),
        ],
      });

      expect(metrics.status).toBe(status);
    },
  );

  it("migrates version-one events without treating old troughs as valid checkpoint data", async () => {
    const sessionKey = "2026-08-04";
    const priceSnapshot = snapshot(sessionKey, 60, 100, 100);
    const legacyEvent = completedEvent(
      "legacy",
      100,
      90,
      95,
      96,
      97,
    ) as Partial<ResilienceShockEvent>;
    delete legacyEvent.oneHourTroughPrice;
    delete legacyEvent.twoHourTroughPrice;
    delete legacyEvent.closeTroughPrice;
    const state = countingMemoryKv({
      "resilience-decay:xyz:SP500": JSON.stringify({
        version: 1,
        market: "xyz:SP500",
        sessionKey,
        snapshots: [priceSnapshot],
        activeShock: null,
        completedShocks: [legacyEvent],
      }),
    });

    const migrated = await record(state, priceSnapshot);
    const metrics = calculateResilienceMetrics(
      migrated.state as ResilienceDecayState,
    );

    expect(migrated.changed).toBe(true);
    expect(migrated.ignoredReason).toBe("duplicate");
    expect(migrated.state?.version).toBe(2);
    expect(migrated.state?.completedShocks[0]).toMatchObject({
      oneHourTroughPrice: null,
      twoHourTroughPrice: null,
      closeTroughPrice: null,
    });
    expect(metrics.scoredShockCount).toBe(0);
    expect(metrics.unscoredShockCount).toBe(1);
  });

  it("rebuilds malformed persisted state from the next valid snapshot", async () => {
    const state = countingMemoryKv({
      "resilience-decay:xyz:SP500": JSON.stringify({
        version: 2,
        market: "xyz:SP500",
        sessionKey: "2026-08-04",
        snapshots: [{ price: "not-a-number" }],
        activeShock: null,
        completedShocks: [],
      }),
    });

    const rebuilt = await record(
      state,
      snapshot("2026-08-04", 30, 99, 100),
    );

    expect(rebuilt.changed).toBe(true);
    expect(rebuilt.recordedSnapshotCount).toBe(1);
    expect(rebuilt.state).toMatchObject({
      version: 2,
      sessionKey: "2026-08-04",
      snapshots: [{ price: 99 }],
    });
  });
});

async function record(
  state: KVNamespace,
  snapshotValue: ResiliencePriceSnapshot,
) {
  return updateResilienceDecayState(state, "xyz:SP500", snapshotValue);
}

function snapshot(
  sessionKey: string,
  minutes: number,
  price: number,
  sessionHigh: number,
  isSessionClose = false,
): ResiliencePriceSnapshot {
  return {
    sessionKey,
    timestamp:
      Date.parse(`${sessionKey}T13:30:00.000Z`) + minutes * 60_000,
    price,
    sessionHigh,
    sessionLow: price,
    isSessionClose,
  };
}

function completedEvent(
  id: string,
  sessionHighAtTrigger: number,
  troughPrice: number,
  oneHourPrice: number | null,
  twoHourPrice: number | null,
  closePrice: number | null,
): ResilienceShockEvent {
  return {
    id,
    sessionKey: "2026-08-04",
    startedAt: Date.parse("2026-08-04T14:00:00.000Z"),
    triggerPrice: 99.4,
    sessionHighAtTrigger,
    troughPrice,
    troughAt: Date.parse("2026-08-04T14:30:00.000Z"),
    oneHourPrice,
    oneHourTroughPrice: oneHourPrice === null ? null : troughPrice,
    twoHourPrice,
    twoHourTroughPrice: twoHourPrice === null ? null : troughPrice,
    closePrice,
    closeTroughPrice: closePrice === null ? null : troughPrice,
    recoveredAt: Date.parse("2026-08-04T15:00:00.000Z"),
    completedAt: Date.parse("2026-08-04T16:00:00.000Z"),
    completionReason: "recovered",
  };
}

function eventWithScore(
  id: string,
  score: number,
  order: number,
): ResilienceShockEvent {
  return {
    ...completedEvent(
      id,
      100,
      90,
      90 + score / 10,
      90 + score / 10,
      90 + score / 10,
    ),
    startedAt:
      Date.parse("2026-08-04T14:00:00.000Z") + order * 60_000,
  };
}

async function readState(state: KVNamespace): Promise<ResilienceDecayState> {
  const rawState = await state.get("resilience-decay:xyz:SP500");
  if (rawState === null) {
    throw new Error("resilience state was not persisted");
  }
  return JSON.parse(rawState) as ResilienceDecayState;
}

function countingMemoryKv(
  initial: Record<string, string> = {},
): KVNamespace & {
  getCount: number;
  putCount: number;
} {
  const values = new Map<string, string>(Object.entries(initial));
  const counters = {
    getCount: 0,
    putCount: 0,
  };
  const state = {
    get: async (key: string) => {
      counters.getCount += 1;
      return values.get(key) ?? null;
    },
    put: async (key: string, value: string) => {
      counters.putCount += 1;
      values.set(key, value);
    },
    delete: async () => undefined,
  } as unknown as KVNamespace & {
    getCount: number;
    putCount: number;
  };
  Object.defineProperties(state, {
    getCount: { get: () => counters.getCount },
    putCount: { get: () => counters.putCount },
  });
  return state;
}
