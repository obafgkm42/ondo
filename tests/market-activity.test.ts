import { describe, expect, it } from "vitest";

import {
  aggregateRthVolumeSessions,
  calculateMarketActivitySnapshot,
  classifyMarketActivityLevel,
  completedMarketActivitySessions,
  isMarketActivityBootstrapTime,
  isMarketActivityEvaluationTime,
  MARKET_ACTIVITY_SLOT_COUNT,
} from "../src/market-activity";
import type { Candle, MarketActivitySession } from "../src/types";
import { isStandardUsEquityRthSession } from "../src/us-market-calendar";

describe("classifyMarketActivityLevel", () => {
  it("applies all fixed RVOL boundaries exactly", () => {
    expect(classifyMarketActivityLevel(0.6499)).toBe("DEADWATER");
    expect(classifyMarketActivityLevel(0.65)).toBe("QUIET");
    expect(classifyMarketActivityLevel(0.8499)).toBe("QUIET");
    expect(classifyMarketActivityLevel(0.85)).toBe("NORMAL");
    expect(classifyMarketActivityLevel(1.1999)).toBe("NORMAL");
    expect(classifyMarketActivityLevel(1.2)).toBe("ACTIVE");
    expect(classifyMarketActivityLevel(1.5999)).toBe("ACTIVE");
    expect(classifyMarketActivityLevel(1.6)).toBe("SURGE");
  });
});

describe("aggregateRthVolumeSessions", () => {
  it("requires three contiguous five-minute candles for each slot", () => {
    const candles = [
      candleAt("2026-06-23T13:30:00.000Z", 10, 5),
      candleAt("2026-06-23T13:35:00.000Z", 20, 5),
      candleAt("2026-06-23T13:40:00.000Z", 30, 5),
      candleAt("2026-06-23T13:45:00.000Z", 40, 5),
      candleAt("2026-06-23T13:55:00.000Z", 60, 5),
    ];

    const [session] = aggregateRthVolumeSessions(candles, 5);

    expect(session?.sessionKey).toBe("2026-06-23");
    expect(session?.slotVolumes[0]).toBe(60);
    expect(session?.slotVolumes[1]).toBeNull();
  });

  it("accepts aligned fifteen-minute bootstrap candles", () => {
    const candles = Array.from({ length: MARKET_ACTIVITY_SLOT_COUNT }, (_, index) =>
      candleAt(
        new Date(Date.parse("2026-12-15T14:30:00.000Z") + index * 15 * 60_000)
          .toISOString(),
        index + 1,
        15,
      )
    );

    const sessions = aggregateRthVolumeSessions(candles, 15);
    const completed = completedMarketActivitySessions(sessions);

    expect(completed).toHaveLength(1);
    expect(completed[0]?.sessionKey).toBe("2026-12-15");
    expect(completed[0]?.slotVolumes).toHaveLength(26);
    expect(completed[0]?.slotVolumes[25]).toBe(26);
  });

  it("does not persist a partial session", () => {
    const session = aggregateRthVolumeSessions(
      [
        candleAt("2026-06-23T13:30:00.000Z", 10, 5),
        candleAt("2026-06-23T13:35:00.000Z", 10, 5),
        candleAt("2026-06-23T13:40:00.000Z", 10, 5),
      ],
      5,
    );

    expect(completedMarketActivitySessions(session)).toEqual([]);
  });
});

describe("calculateMarketActivitySnapshot", () => {
  it("uses same-time cumulative history and excludes the current session", () => {
    const current = partialSession("2026-06-23", [130, 132]);
    const history = [
      ...historySessions(20, 100),
      storedSession("2026-06-23", 10_000),
    ];

    const snapshot = calculateMarketActivitySnapshot(
      "xyz:SP500",
      current,
      history,
      new Date("2026-06-23T14:00:00.000Z"),
    );

    expect(snapshot.level).toBe("ACTIVE");
    expect(snapshot.sessionRvol).toBeCloseTo(1.31);
    expect(snapshot.sampleSessions).toBe(20);
    expect(snapshot.percentile).toBe(100);
    expect(snapshot.confidence).toBe("confirmed");
    expect(snapshot.barRvol).toBeCloseTo(1.32);
    expect(snapshot.barActivity).toBe("ordinary");
  });

  it("keeps the opening interval in FORMING state", () => {
    const snapshot = calculateMarketActivitySnapshot(
      "xyz:SP500",
      partialSession("2026-06-23", [100]),
      historySessions(10, 100),
      new Date("2026-06-23T13:45:00.000Z"),
    );

    expect(snapshot.level).toBe("FORMING");
    expect(snapshot.sessionRvol).toBeNull();
    expect(snapshot.currentSlotIndex).toBe(0);
  });

  it("returns UNKNOWN when a completed slot gap breaks the cumulative path", () => {
    const current = partialSession("2026-06-23", [100, null, 100]);

    const snapshot = calculateMarketActivitySnapshot(
      "xyz:SP500",
      current,
      historySessions(10, 100),
      new Date("2026-06-23T14:15:00.000Z"),
    );

    expect(snapshot.level).toBe("UNKNOWN");
    expect(snapshot.confidence).toBe("unavailable");
  });

  it("marks five to nine baseline sessions as provisional", () => {
    const snapshot = calculateMarketActivitySnapshot(
      "xyz:SP500",
      partialSession("2026-06-23", [70, 70]),
      historySessions(5, 100),
      new Date("2026-06-23T14:00:00.000Z"),
    );

    expect(snapshot.level).toBe("QUIET");
    expect(snapshot.dataQuality).toBe("provisional");
    expect(snapshot.confidence).toBe("provisional");
    expect(snapshot.percentile).toBeNull();
  });

  it("uses midpoint percentile rank for ties", () => {
    const snapshot = calculateMarketActivitySnapshot(
      "xyz:SP500",
      partialSession("2026-06-23", [100, 100]),
      historySessions(20, 100),
      new Date("2026-06-23T14:00:00.000Z"),
    );

    expect(snapshot.percentile).toBe(50);
    expect(snapshot.percentileBand).toBe("typical");
    expect(snapshot.level).toBe("NORMAL");
    expect(snapshot.confidence).toBe("confirmed");
  });
});

describe("market activity scheduling", () => {
  it("updates only on completed fifteen-minute RTH boundaries", () => {
    expect(isMarketActivityEvaluationTime(new Date("2026-06-23T13:45:00Z")))
      .toBe(true);
    expect(isMarketActivityEvaluationTime(new Date("2026-06-23T19:05:00Z")))
      .toBe(false);
    expect(isMarketActivityEvaluationTime(new Date("2026-12-15T14:45:00Z")))
      .toBe(true);
  });

  it("bootstraps only in the first post-close hour", () => {
    expect(isMarketActivityBootstrapTime(new Date("2026-06-23T20:15:00Z")))
      .toBe(true);
    expect(isMarketActivityBootstrapTime(new Date("2026-12-15T21:15:00Z")))
      .toBe(true);
    expect(isMarketActivityBootstrapTime(new Date("2026-06-23T19:45:00Z")))
      .toBe(false);
  });
});

function candleAt(
  timestamp: string,
  volume: number,
  intervalMinutes: 5 | 15,
): Candle {
  const startTime = Date.parse(timestamp);
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

function partialSession(
  sessionKey: string,
  initialVolumes: Array<number | null>,
): ReturnType<typeof aggregateRthVolumeSessions>[number] {
  const slotVolumes: Array<number | null> = Array(26).fill(null);
  const slotEndTimes: Array<number | null> = Array(26).fill(null);
  initialVolumes.forEach((volume, index) => {
    slotVolumes[index] = volume;
    slotEndTimes[index] = Date.parse("2026-06-23T13:44:59.999Z") +
      index * 15 * 60_000;
  });
  return { sessionKey, slotVolumes, slotEndTimes };
}

function historySessions(count: number, slotVolume: number): MarketActivitySession[] {
  return standardSessionKeys(count).map((sessionKey) =>
    storedSession(sessionKey, slotVolume)
  );
}

function storedSession(
  sessionKey: string,
  slotVolume: number,
): MarketActivitySession {
  return {
    sessionKey,
    slotVolumes: Array(MARKET_ACTIVITY_SLOT_COUNT).fill(slotVolume),
  };
}

function standardSessionKeys(count: number): string[] {
  const sessionKeys: string[] = [];
  let timestamp = Date.parse("2026-04-01T00:00:00.000Z");
  while (sessionKeys.length < count) {
    const sessionKey = new Date(timestamp).toISOString().slice(0, 10);
    if (isStandardUsEquityRthSession(sessionKey)) {
      sessionKeys.push(sessionKey);
    }
    timestamp += 24 * 60 * 60 * 1_000;
  }
  return sessionKeys;
}
