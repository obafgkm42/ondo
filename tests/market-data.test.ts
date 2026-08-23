import { describe, expect, it } from "vitest";

import {
  canonicalBarToCandle,
  normalizeHyperliquidCandles,
} from "../src/market-data";

describe("shared market-data adapter", () => {
  it("preserves the scanner candle contract exactly", () => {
    const startTime = Date.parse("2026-08-21T13:30:00Z");
    const candles = normalizeHyperliquidCandles(
      [{
        t: startTime,
        T: startTime + 299_999,
        o: "100",
        h: "102",
        l: "99",
        c: "101",
        v: "42",
        n: 7,
      }],
      "xyz:SP500",
      300_000,
      "2026-08-21T13:35:00Z",
    );

    expect(candles).toEqual([{
      startTime,
      endTime: startTime + 299_999,
      open: 100,
      high: 102,
      low: 99,
      close: 101,
      volume: 42,
      tradeCount: 7,
    }]);
  });

  it("fails instead of inventing scanner-required fields", () => {
    expect(() => canonicalBarToCandle({
      startTimeMs: 1,
      endTimeExclusiveMs: 2,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: null,
      tradeCount: 1,
      wap: null,
      priceSource: "source",
      volumeSource: null,
      flags: ["MISSING_VOLUME"],
    })).toThrow("require measured volume");
  });

  it("rejects malformed rows and valid duplicate timestamps", () => {
    expect(() => normalizeHyperliquidCandles(
      [null],
      "xyz:SP500",
      300_000,
      "2026-08-21T13:35:00Z",
    )).toThrow("malformed candle");

    const row = {
      t: Date.parse("2026-08-21T13:30:00Z"),
      T: Date.parse("2026-08-21T13:34:59.999Z"),
      o: "100",
      h: "102",
      l: "99",
      c: "101",
      v: "42",
      n: 7,
    };
    expect(() => normalizeHyperliquidCandles(
      [row, row],
      "xyz:SP500",
      300_000,
      "2026-08-21T13:35:00Z",
    )).toThrow("duplicates a valid start time");
  });
});
