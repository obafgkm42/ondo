import { describe, expect, it, vi } from "vitest";

import { evaluateMarketActivity } from "../src/market-activity-service";
import { marketActivityStateKey } from "../src/market-activity-state";
import { MARKET_ACTIVITY_SLOT_COUNT } from "../src/market-activity";
import type {
  Candle,
  MarketActivitySession,
  MarketActivityState,
} from "../src/types";
import { isStandardUsEquityRthSession } from "../src/us-market-calendar";

const MARKET = "xyz:SP500";

describe("evaluateMarketActivity", () => {
  it("bootstraps after the close with one read and one write", async () => {
    const namespace = memoryKv();
    const fetchBootstrapCandles = vi.fn(async () =>
      completeSessions15m(weekdayDates())
    );

    const evaluation = await evaluateMarketActivity(
      namespace,
      MARKET,
      completeSession5m("2026-06-23"),
      new Date("2026-06-23T20:15:00.000Z"),
      { allowBootstrap: true, fetchBootstrapCandles },
    );

    expect(fetchBootstrapCandles).toHaveBeenCalledWith(
      MARKET,
      new Date("2026-06-23T20:15:00.000Z"),
      18,
    );
    expect(evaluation.bootstrapAttempted).toBe(true);
    expect(evaluation.bootstrapSessionCount).toBe(10);
    expect(evaluation.bootstrapError).toBeNull();
    expect(evaluation.snapshot.level).toBe("NORMAL");
    expect(evaluation.snapshot.sampleSessions).toBe(10);
    expect(namespace.getCount()).toBe(1);
    expect(namespace.putCount()).toBe(1);
    const stored = JSON.parse(
      String(await namespace.peek(marketActivityStateKey(MARKET))),
    ) as MarketActivityState;
    expect(stored.completedSessions).toHaveLength(11);
  });

  it("bootstraps immediately when a new Worker version primes history", async () => {
    const namespace = memoryKv();
    const fetchBootstrapCandles = vi.fn(async () =>
      completeSessions15m(weekdayDates())
    );

    const evaluation = await evaluateMarketActivity(
      namespace,
      MARKET,
      [],
      new Date("2026-06-23T12:45:00.000Z"),
      {
        allowBootstrap: true,
        bootstrapImmediately: true,
        fetchBootstrapCandles,
      },
    );

    expect(fetchBootstrapCandles).toHaveBeenCalledWith(
      MARKET,
      new Date("2026-06-23T12:45:00.000Z"),
      18,
    );
    expect(evaluation.bootstrapAttempted).toBe(true);
    expect(evaluation.historySessionCount).toBe(10);
    expect(evaluation.stateWritten).toBe(true);
  });

  it("does not add a provider request during an ordinary RTH evaluation", async () => {
    const state = stateWithHistory(10);
    const namespace = memoryKv({
      [marketActivityStateKey(MARKET)]: JSON.stringify(state),
    });
    const fetchBootstrapCandles = vi.fn<() => Promise<Candle[]>>();

    const evaluation = await evaluateMarketActivity(
      namespace,
      MARKET,
      partialSession5m("2026-06-23", 2),
      new Date("2026-06-23T14:00:00.000Z"),
      { allowBootstrap: true, fetchBootstrapCandles },
    );

    expect(fetchBootstrapCandles).not.toHaveBeenCalled();
    expect(evaluation.snapshot.level).toBe("NORMAL");
    expect(evaluation.stateWritten).toBe(false);
    expect(namespace.getCount()).toBe(1);
    expect(namespace.putCount()).toBe(0);
  });

  it("keeps manual status evaluation read-only after a session completes", async () => {
    const state = stateWithHistory(10);
    const namespace = memoryKv({
      [marketActivityStateKey(MARKET)]: JSON.stringify(state),
    });

    const evaluation = await evaluateMarketActivity(
      namespace,
      MARKET,
      completeSession5m("2026-06-23"),
      new Date("2026-06-23T20:15:00.000Z"),
      { allowBootstrap: false, persistState: false },
    );

    expect(evaluation.snapshot.level).toBe("NORMAL");
    expect(evaluation.stateChanged).toBe(true);
    expect(evaluation.stateWritten).toBe(false);
    expect(namespace.getCount()).toBe(1);
    expect(namespace.putCount()).toBe(0);
  });

  it("records a failed optional bootstrap without failing the scan", async () => {
    const namespace = memoryKv();

    const evaluation = await evaluateMarketActivity(
      namespace,
      MARKET,
      completeSession5m("2026-06-23"),
      new Date("2026-06-23T20:15:00.000Z"),
      {
        allowBootstrap: true,
        fetchBootstrapCandles: async () => {
          throw new Error("provider unavailable");
        },
      },
    );

    expect(evaluation.bootstrapError).toBe("Error");
    expect(evaluation.snapshot.level).toBe("UNKNOWN");
    expect(evaluation.stateWritten).toBe(true);
    const stored = JSON.parse(
      String(await namespace.peek(marketActivityStateKey(MARKET))),
    ) as MarketActivityState;
    expect(stored.bootstrapAttemptedAt).toBe(
      Date.parse("2026-06-23T20:15:00.000Z"),
    );
  });

  it("keeps sixty prior sessions in the close snapshot before bounded storage", async () => {
    const state = stateWithHistory(60, "2026-03-02T00:00:00.000Z");
    const namespace = memoryKv({
      [marketActivityStateKey(MARKET)]: JSON.stringify(state),
    });

    const evaluation = await evaluateMarketActivity(
      namespace,
      MARKET,
      completeSession5m("2026-06-23"),
      new Date("2026-06-23T20:00:00.000Z"),
      { allowBootstrap: false },
    );

    expect(evaluation.snapshot.sampleSessions).toBe(60);
    expect(evaluation.snapshot.dataQuality).toBe("full");
    expect(evaluation.historySessionCount).toBe(60);
  });
});

function partialSession5m(sessionKey: string, completedSlots: number): Candle[] {
  const startTime = Date.parse(`${sessionKey}T13:30:00.000Z`);
  return Array.from({ length: completedSlots * 3 }, (_, index) =>
    candle(startTime + index * 5 * 60_000, 5, 10)
  );
}

function completeSession5m(sessionKey: string): Candle[] {
  return partialSession5m(sessionKey, MARKET_ACTIVITY_SLOT_COUNT);
}

function completeSessions15m(sessionKeys: readonly string[]): Candle[] {
  return sessionKeys.flatMap((sessionKey) => {
    const startTime = Date.parse(`${sessionKey}T13:30:00.000Z`);
    return Array.from({ length: MARKET_ACTIVITY_SLOT_COUNT }, (_, index) =>
      candle(startTime + index * 15 * 60_000, 15, 30)
    );
  });
}

function candle(
  startTime: number,
  intervalMinutes: 5 | 15,
  volume: number,
): Candle {
  return {
    startTime,
    endTime: startTime + intervalMinutes * 60_000 - 1,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume,
    tradeCount: 1,
  };
}

function weekdayDates(): string[] {
  return [
    "2026-06-08",
    "2026-06-09",
    "2026-06-10",
    "2026-06-11",
    "2026-06-12",
    "2026-06-15",
    "2026-06-16",
    "2026-06-17",
    "2026-06-18",
    "2026-06-22",
  ];
}

function stateWithHistory(
  count: number,
  startTimestamp = "2026-05-01T00:00:00.000Z",
): MarketActivityState {
  const sessionKeys = standardSessionKeys(count, startTimestamp);
  const completedSessions: MarketActivitySession[] = Array.from(
    { length: count },
    (_, index) => ({
      sessionKey: sessionKeys[index] ?? "",
      slotVolumes: Array(MARKET_ACTIVITY_SLOT_COUNT).fill(30),
    }),
  );
  return {
    version: 1,
    market: MARKET,
    intervalMinutes: 15,
    bootstrapAttemptedAt: null,
    completedSessions,
  };
}

function standardSessionKeys(
  count: number,
  startTimestamp = "2026-05-01T00:00:00.000Z",
): string[] {
  const sessionKeys: string[] = [];
  let timestamp = Date.parse(startTimestamp);
  while (sessionKeys.length < count) {
    const sessionKey = new Date(timestamp).toISOString().slice(0, 10);
    if (isStandardUsEquityRthSession(sessionKey)) {
      sessionKeys.push(sessionKey);
    }
    timestamp += 24 * 60 * 60 * 1_000;
  }
  return sessionKeys;
}

function memoryKv(
  initial: Record<string, string> = {},
): KVNamespace & {
  getCount(): number;
  putCount(): number;
  peek(key: string): Promise<string | null>;
} {
  const values = new Map(Object.entries(initial));
  let gets = 0;
  let puts = 0;
  return {
    get: async (key: string) => {
      gets += 1;
      return values.get(key) ?? null;
    },
    put: async (key: string, value: string) => {
      puts += 1;
      values.set(key, value);
    },
    getCount: () => gets,
    putCount: () => puts,
    peek: async (key: string) => values.get(key) ?? null,
  } as unknown as KVNamespace & {
    getCount(): number;
    putCount(): number;
    peek(key: string): Promise<string | null>;
  };
}
