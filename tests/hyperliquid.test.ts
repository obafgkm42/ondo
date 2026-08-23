import { describe, expect, it } from "vitest";

import {
  fetchXyzStockCoins,
  fetchFifteenMinuteCandles,
  fetchFiveMinuteCandles,
  fetchXyzMarketContexts,
  HyperliquidRateLimitError,
} from "../src/hyperliquid";

describe("fetchXyzStockCoins", () => {
  it("selects only xyz assets in the official stocks category", async () => {
    const requests: object[] = [];
    const fetcher = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(JSON.parse(String(init?.body)) as object);
      return Response.json([
        ["xyz:AAPL", "stocks"],
        ["xyz:GOLD", "commodities"],
        ["para:AVGO", "stocks"],
        ["xyz:SP500", "indices"],
        ["xyz:MSFT", "STOCKS"],
      ]);
    };

    const coins = await fetchXyzStockCoins(fetcher as typeof fetch);

    expect(requests).toEqual([{ type: "perpCategories", dex: "xyz" }]);
    expect(coins).toEqual(["xyz:AAPL", "xyz:MSFT"]);
  });

  it("rejects malformed category metadata", async () => {
    const fetcher = async (): Promise<Response> =>
      Response.json([["xyz:AAPL"]]);

    await expect(
      fetchXyzStockCoins(fetcher as typeof fetch),
    ).rejects.toThrow("categories response is invalid");
  });
});

describe("fetchFifteenMinuteCandles", () => {
  it("requests a bounded bootstrap window and excludes a forming candle", async () => {
    const requests: RequestInit[] = [];
    const now = new Date("2026-09-02T20:15:00.000Z");
    const completedStart = now.getTime() - 30 * 60_000;
    const formingStart = now.getTime();
    const fetcher = async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push(init ?? {});
      return Response.json([
        candlePayload(completedStart, 15),
        candlePayload(formingStart, 15),
      ]);
    };

    const candles = await fetchFifteenMinuteCandles(
      "xyz:SP500",
      now,
      18,
      fetcher as typeof fetch,
    );
    const body = JSON.parse(String(requests[0]?.body)) as {
      req: {
        interval: string;
        startTime: number;
        endTime: number;
      };
    };

    expect(candles).toHaveLength(1);
    expect(body.req.interval).toBe("15m");
    expect(body.req.endTime - body.req.startTime).toBe(
      18 * 24 * 60 * 60 * 1_000,
    );
  });

  it("rejects an unbounded bootstrap lookback", async () => {
    await expect(
      fetchFifteenMinuteCandles(
        "xyz:SP500",
        new Date("2026-09-02T20:15:00.000Z"),
        31,
      ),
    ).rejects.toThrow("1-30 days");
  });
});

describe("fetchFiveMinuteCandles", () => {
  it("retries transient rate limits before returning candles", async () => {
    const responses = [
      new Response("rate limited", { status: 429 }),
      new Response("rate limited", { status: 429 }),
      Response.json([
        {
          t: 1_788_000_000_000,
          T: 1_788_000_299_999,
          o: "100",
          h: "101",
          l: "99",
          c: "100.5",
          v: "42",
          n: 7,
        },
      ]),
    ];
    const fetcher = async (): Promise<Response> => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("unexpected extra fetch");
      }
      return response;
    };

    const candles = await fetchFiveMinuteCandles(
      "xyz:SP500",
      new Date("2026-09-02T00:10:00Z"),
      fetcher as typeof fetch,
    );

    expect(candles).toHaveLength(1);
    expect(candles[0]?.close).toBe(100.5);
    expect(responses).toHaveLength(0);
  });

  it("throws a typed error after repeated rate limits", async () => {
    const fetcher = async (): Promise<Response> =>
      new Response("rate limited", { status: 429 });

    await expect(
      fetchFiveMinuteCandles(
        "xyz:SP500",
        new Date("2026-09-02T00:10:00Z"),
        fetcher as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(HyperliquidRateLimitError);
  });
});

describe("fetchXyzMarketContexts", () => {
  it("maps requested active assets from aligned metadata arrays", async () => {
    const fetcher = async (): Promise<Response> =>
      Response.json([
        {
          universe: [
            { name: "xyz:SP500" },
            { name: "xyz:XYZ100" },
            { name: "xyz:OLD", isDelisted: true },
          ],
        },
        [
          assetContext("99", "100"),
          assetContext("198", "200"),
          assetContext("10", "10"),
        ],
      ]);

    const contexts = await fetchXyzMarketContexts(
      ["xyz:SP500", "xyz:XYZ100", "xyz:OLD"],
      fetcher as typeof fetch,
    );

    expect(contexts).toHaveLength(2);
    expect(contexts[0]).toMatchObject({
      coin: "xyz:SP500",
      markPrice: 99,
      previousDayPrice: 100,
    });
    expect(contexts[1]?.coin).toBe("xyz:XYZ100");
  });

  it("rejects misaligned metadata instead of pairing wrong markets", async () => {
    const fetcher = async (): Promise<Response> =>
      Response.json([
        { universe: [{ name: "xyz:SP500" }] },
        [],
      ]);

    await expect(
      fetchXyzMarketContexts(
        ["xyz:SP500"],
        fetcher as typeof fetch,
      ),
    ).rejects.toThrow("misaligned");
  });
});

function assetContext(markPrice: string, previousDayPrice: string): object {
  return {
    markPx: markPrice,
    oraclePx: markPrice,
    prevDayPx: previousDayPrice,
    funding: "0.00000625",
    premium: "0.0001",
    dayNtlVlm: "1000000",
  };
}

function candlePayload(startTime: number, intervalMinutes: number): object {
  return {
    t: startTime,
    T: startTime + intervalMinutes * 60_000 - 1,
    o: "100",
    h: "101",
    l: "99",
    c: "100.5",
    v: "42",
    n: 7,
  };
}
