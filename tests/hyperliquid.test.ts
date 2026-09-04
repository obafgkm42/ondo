import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchXyzStockCoins,
  fetchFifteenMinuteCandles,
  fetchFiveMinuteCandles,
  fetchXyzMarketContexts,
  HyperliquidRateLimitError,
} from "../src/hyperliquid";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
  it("retries transient server failures before returning candles", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(250 / 251);
    const warning = vi.spyOn(console, "warn").mockImplementation(
      () => undefined,
    );
    const responses = [
      new Response("unavailable", { status: 503 }),
      new Response("bad gateway", { status: 502 }),
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

    const pendingCandles = fetchFiveMinuteCandles(
      "xyz:SP500",
      new Date("2026-09-02T00:10:00Z"),
      fetcher as typeof fetch,
    );
    await vi.runAllTimersAsync();
    const candles = await pendingCandles;

    expect(candles).toHaveLength(1);
    expect(candles[0]?.close).toBe(100.5);
    expect(responses).toHaveLength(0);
    expect(requestFailureLogs(warning)).toEqual([
      expect.objectContaining({
        operation: "candle",
        responseStatus: 503,
        attempt: 1,
        maxAttempts: 3,
        decision: "retry",
        retryDelayMs: 1_000,
      }),
      expect.objectContaining({
        operation: "candle",
        responseStatus: 502,
        attempt: 2,
        maxAttempts: 3,
        decision: "retry",
        retryDelayMs: 2_250,
      }),
    ]);
  });

  it("throws a typed error after one rate limit without retrying", async () => {
    let requestCount = 0;
    const warning = vi.spyOn(console, "warn").mockImplementation(
      () => undefined,
    );
    const fetcher = async (): Promise<Response> => {
      requestCount += 1;
      return new Response("rate limited", {
        status: 429,
        headers: { "Retry-After": "12" },
      });
    };

    await expect(
      fetchFiveMinuteCandles(
        "xyz:SP500",
        new Date("2026-09-02T00:10:00Z"),
        fetcher as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(HyperliquidRateLimitError);
    expect(requestCount).toBe(1);
    expect(requestFailureLogs(warning)).toEqual([
      {
        status: "hyperliquid_request_failed",
        operation: "candle",
        responseStatus: 429,
        attempt: 1,
        maxAttempts: 1,
        decision: "abort",
        retryDelayMs: null,
        retryAfterMs: 12_000,
      },
    ]);
  });

  it("preserves rate-limit behavior when structured logging fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logging unavailable");
    });
    let requestCount = 0;
    const fetcher = async (): Promise<Response> => {
      requestCount += 1;
      return new Response("rate limited", { status: 429 });
    };

    await expect(
      fetchFiveMinuteCandles(
        "xyz:SP500",
        new Date("2026-09-02T00:10:00Z"),
        fetcher as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(HyperliquidRateLimitError);
    expect(requestCount).toBe(1);
  });

  it("aborts an exhausted server failure after exactly three attempts", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const warning = vi.spyOn(console, "warn").mockImplementation(
      () => undefined,
    );
    let requestCount = 0;
    const fetcher = async (): Promise<Response> => {
      requestCount += 1;
      return new Response("unavailable", { status: 503 });
    };

    const pendingResult = fetchFiveMinuteCandles(
      "xyz:SP500",
      new Date("2026-09-02T00:10:00Z"),
      fetcher as typeof fetch,
    );
    const assertion = expect(pendingResult).rejects.toThrow(
      "Hyperliquid candle request failed: 503",
    );
    await vi.runAllTimersAsync();
    await assertion;

    expect(requestCount).toBe(3);
    expect(requestFailureLogs(warning).at(-1)).toEqual(
      expect.objectContaining({
        attempt: 3,
        maxAttempts: 3,
        decision: "abort",
        retryDelayMs: null,
      }),
    );
  });

  it.each([
    ["delta seconds", "12", 12_000],
    ["future HTTP date", "Fri, 04 Sep 2026 10:00:30 GMT", 30_000],
    ["past HTTP date", "Fri, 04 Sep 2026 09:59:30 GMT", 0],
    ["negative seconds", "-1", null],
    ["malformed", "not-a-delay", null],
    ["absent", undefined, null],
    ["bounded", "999999", 24 * 60 * 60 * 1_000],
  ])("normalizes %s Retry-After", async (_label, header, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T10:00:00.000Z"));
    const warning = vi.spyOn(console, "warn").mockImplementation(
      () => undefined,
    );
    const fetcher = async (): Promise<Response> =>
      new Response("rate limited", {
        status: 429,
        ...(header === undefined
          ? {}
          : { headers: { "Retry-After": header } }),
      });

    await expect(
      fetchFiveMinuteCandles(
        "xyz:SP500",
        new Date("2026-09-04T10:00:00.000Z"),
        fetcher as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(HyperliquidRateLimitError);

    const serializedLog = String(warning.mock.calls[0]?.[0]);
    const parsedLog = JSON.parse(serializedLog) as Record<string, unknown>;
    expect(parsedLog).toMatchObject({
      retryAfterMs: expected,
    });
    expect(parsedLog).not.toHaveProperty("retryAfter");
    expect(parsedLog).not.toHaveProperty("retryAfterRaw");
    expect(serializedLog).not.toContain("not-a-delay");
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

function requestFailureLogs(
  warning: ReturnType<typeof vi.spyOn>,
): Array<Record<string, unknown>> {
  return warning.mock.calls.map(([message]) =>
    JSON.parse(String(message)) as Record<string, unknown>
  );
}
