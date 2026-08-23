import { describe, expect, it } from "vitest";

import {
  loadMarketActivityState,
  marketActivityStateKey,
  mergeMarketActivityState,
  saveMarketActivityState,
  shouldBootstrapMarketActivity,
} from "../src/market-activity-state";
import { MARKET_ACTIVITY_SLOT_COUNT } from "../src/market-activity";
import type { MarketActivitySession } from "../src/types";
import { isStandardUsEquityRthSession } from "../src/us-market-calendar";

const MARKET = "xyz:SP500";

describe("market activity state", () => {
  it("uses one read and writes only when serialized state changes", async () => {
    const namespace = memoryKv();
    const loaded = await loadMarketActivityState(namespace, MARKET);
    const nextState = mergeMarketActivityState(loaded.state, [session(1)]);
    const firstSave = await saveMarketActivityState(
      namespace,
      MARKET,
      loaded.rawState,
      nextState,
    );
    const reloaded = await loadMarketActivityState(namespace, MARKET);
    const duplicateState = mergeMarketActivityState(reloaded.state, [session(1)]);
    const duplicateSave = await saveMarketActivityState(
      namespace,
      MARKET,
      reloaded.rawState,
      duplicateState,
    );

    expect(firstSave).toEqual({ changed: true, written: true });
    expect(duplicateSave).toEqual({ changed: false, written: false });
    expect(namespace.getCount()).toBe(2);
    expect(namespace.putCount()).toBe(1);
  });

  it("keeps only the newest sixty unique sessions", () => {
    const sessions = Array.from({ length: 65 }, (_, index) => session(index + 1));
    const state = mergeMarketActivityState(emptyState(), sessions);

    expect(state.completedSessions).toHaveLength(60);
    expect(state.completedSessions[0]?.sessionKey).toBe(
      standardSessionKeys(65)[5],
    );
    expect(state.completedSessions.at(-1)?.sessionKey).toBe(
      standardSessionKeys(65)[64],
    );
  });

  it("recovers corrupt JSON as an empty fail-open state", async () => {
    const namespace = memoryKv({
      [marketActivityStateKey(MARKET)]: "{not-json",
    });

    const loaded = await loadMarketActivityState(namespace, MARKET);

    expect(loaded.recoveredCorruptState).toBe(true);
    expect(loaded.state.completedSessions).toEqual([]);
  });

  it("drops a non-standard session without discarding valid history", async () => {
    const validSession = session(1);
    const holidaySession = {
      ...validSession,
      sessionKey: "2026-07-03",
    };
    const namespace = memoryKv({
      [marketActivityStateKey(MARKET)]: JSON.stringify({
        ...emptyState(),
        completedSessions: [validSession, holidaySession],
      }),
    });

    const loaded = await loadMarketActivityState(namespace, MARKET);

    expect(loaded.recoveredCorruptState).toBe(false);
    expect(loaded.state.completedSessions).toEqual([validSession]);
  });

  it("does not perform persistence work without a KV binding", async () => {
    const loaded = await loadMarketActivityState(undefined, MARKET);
    const state = mergeMarketActivityState(loaded.state, [session(1)]);

    await expect(
      saveMarketActivityState(undefined, MARKET, loaded.rawState, state),
    ).resolves.toEqual({ changed: true, written: false });
    expect(loaded.persistent).toBe(false);
  });

  it("retries an underfilled bootstrap at most once per day", () => {
    const attemptedAt = Date.parse("2026-06-23T20:15:00.000Z");
    const state = mergeMarketActivityState(
      emptyState(),
      Array.from({ length: 5 }, (_, index) => session(index + 1)),
      attemptedAt,
    );

    expect(
      shouldBootstrapMarketActivity(
        state,
        new Date("2026-06-24T20:14:59.999Z"),
      ),
    ).toBe(false);
    expect(
      shouldBootstrapMarketActivity(
        state,
        new Date("2026-06-24T20:15:00.000Z"),
      ),
    ).toBe(true);
    expect(
      shouldBootstrapMarketActivity(
        mergeMarketActivityState(
          state,
          Array.from({ length: 10 }, (_, index) => session(index + 1)),
        ),
        new Date("2026-06-25T20:15:00.000Z"),
      ),
    ).toBe(false);
  });
});

function emptyState() {
  return {
    version: 1 as const,
    market: MARKET,
    intervalMinutes: 15 as const,
    bootstrapAttemptedAt: null,
    completedSessions: [],
  };
}

function session(index: number): MarketActivitySession {
  return {
    sessionKey: standardSessionKeys(index)[index - 1] ?? "",
    slotVolumes: Array(MARKET_ACTIVITY_SLOT_COUNT).fill(index),
  };
}

function standardSessionKeys(count: number): string[] {
  const sessionKeys: string[] = [];
  let timestamp = Date.parse("2026-01-02T00:00:00.000Z");
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
): KVNamespace & { getCount(): number; putCount(): number } {
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
  } as unknown as KVNamespace & {
    getCount(): number;
    putCount(): number;
  };
}
