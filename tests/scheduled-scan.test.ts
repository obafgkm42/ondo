import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";

describe("scheduled catch-up scan", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("catches a signal between boundaries with one candle request", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        calls.push({ url, init });
        if (url === HYPERLIQUID_INFO_URL) {
          return Response.json(hyperliquidCandles());
        }
        return new Response(null, { status: 204 });
      },
    );
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-07-23T15:45:00.000Z"),
      baseEnv(),
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    const candleRequests = calls.filter(
      (call) => call.url === HYPERLIQUID_INFO_URL,
    );
    const webhookRequests = calls.filter(
      (call) => call.url !== HYPERLIQUID_INFO_URL,
    );
    expect(candleRequests).toHaveLength(1);
    expect(webhookRequests).toHaveLength(1);

    const payload = JSON.parse(
      String(webhookRequests[0]?.init?.body),
    ) as {
      embeds: Array<{ timestamp: string }>;
    };
    expect(payload.embeds[0]?.timestamp).toBe(
      "2026-07-23T15:34:59.999Z",
    );
  });

  it("sends a due brief even when the signal cadence gate is closed", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const state = memoryKv({ "last-version-notice": "local-dev" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        calls.push({ url, init });
        if (url === HYPERLIQUID_INFO_URL) {
          const body = JSON.parse(String(init?.body)) as { type: string };
          if (body.type === "perpCategories") {
            return Response.json([]);
          }
          if (body.type === "metaAndAssetCtxs") {
            return new Response("context unavailable", { status: 400 });
          }
          return Response.json(hyperliquidCandles());
        }
        return new Response(null, { status: 204 });
      },
    );
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-07-23T15:30:00.000Z"),
      {
        ...baseEnv(),
        REGULAR_SCAN_MINUTES: "20",
        BRIEF_INTERVAL_MINUTES: "30",
        FRAGILITY_PERSISTENCE_MODE: "display",
        SCANNER_STATE: state,
      },
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    const candleRequests = calls.filter(
      (call) => call.url === HYPERLIQUID_INFO_URL,
    );
    const webhookRequests = calls.filter(
      (call) => call.url !== HYPERLIQUID_INFO_URL,
    );
    expect(candleRequests).toHaveLength(3);
    expect(webhookRequests).toHaveLength(1);

    const body = webhookRequests[0]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const payload = JSON.parse(
      String((body as FormData).get("payload_json")),
    ) as {
      allowed_mentions: { parse: string[] };
      embeds: Array<{
        title: string;
        fields: Array<{ name: string; value: string }>;
      }>;
    };
    expect(payload.embeds[0]?.title).toContain("市場狀態");
    expect(payload.embeds[0]?.title).toContain("BREAKING");
    expect(payload.allowed_mentions).toEqual({ parse: ["everyone"] });
    expect(payload.embeds[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "BREAKING 持續性",
          value: expect.stringContaining("待確認 PENDING"),
        }),
      ]),
    );
    const rawShadow = await state.get(
      "market-fragility-v2-shadow:xyz:SP500",
    );
    const shadowState = JSON.parse(String(rawShadow)) as {
      version: number;
      sessions: Array<{ observations: unknown[] }>;
    };
    expect(shadowState.version).toBe(3);
    expect(shadowState.sessions).toHaveLength(1);
    expect(shadowState.sessions[0]?.observations).toHaveLength(1);
  });

  it("stops optional context requests after a category rate limit", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const state = memoryKv({ "last-version-notice": "local-dev" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(
      () => undefined,
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        calls.push({ url, init });
        if (url !== HYPERLIQUID_INFO_URL) {
          return new Response(null, { status: 204 });
        }
        const body = JSON.parse(String(init?.body)) as { type: string };
        if (body.type === "perpCategories") {
          return new Response("rate limited", {
            status: 429,
            headers: { "Retry-After": "60" },
          });
        }
        if (body.type === "metaAndAssetCtxs") {
          throw new Error("market contexts should be suppressed");
        }
        return Response.json(hyperliquidCandles());
      },
    );
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-07-23T15:30:00.000Z"),
      {
        ...baseEnv(),
        REGULAR_SCAN_MINUTES: "20",
        BRIEF_INTERVAL_MINUTES: "30",
        SCANNER_STATE: state,
      },
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    const infoRequestTypes = calls
      .filter((call) => call.url === HYPERLIQUID_INFO_URL)
      .map((call) =>
        (JSON.parse(String(call.init?.body)) as { type: string }).type
      );
    expect(infoRequestTypes).toEqual(["candleSnapshot", "perpCategories"]);
    expect(
      calls.filter((call) => call.url !== HYPERLIQUID_INFO_URL),
    ).toHaveLength(1);
    expect(
      warning.mock.calls.some(([message]) =>
        String(message).includes(
          '"operation":"perp categories","responseStatus":429',
        )
      ),
    ).toBe(true);
  });

  it("still attempts frozen-basket contexts after a non-rate-limit category failure", async () => {
    const infoRequestTypes: string[] = [];
    const state = memoryKv({ "last-version-notice": "local-dev" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        if (String(input) !== HYPERLIQUID_INFO_URL) {
          return new Response(null, { status: 204 });
        }
        const body = JSON.parse(String(init?.body)) as { type: string };
        infoRequestTypes.push(body.type);
        if (body.type === "perpCategories") {
          return new Response("category unavailable", { status: 400 });
        }
        if (body.type === "metaAndAssetCtxs") {
          return new Response("context unavailable", { status: 400 });
        }
        return Response.json(hyperliquidCandles());
      },
    );
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-07-23T15:30:00.000Z"),
      {
        ...baseEnv(),
        REGULAR_SCAN_MINUTES: "20",
        BRIEF_INTERVAL_MINUTES: "30",
        SCANNER_STATE: state,
      },
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    expect(infoRequestTypes).toEqual([
      "candleSnapshot",
      "perpCategories",
      "metaAndAssetCtxs",
    ]);
  });

  it("does not persist or broadcast a stale market-state brief", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const state = memoryKv({ "last-version-notice": "local-dev" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        calls.push({ url, init });
        if (url === HYPERLIQUID_INFO_URL) {
          const body = JSON.parse(String(init?.body)) as { type: string };
          if (body.type === "perpCategories") {
            return Response.json([]);
          }
          if (body.type === "metaAndAssetCtxs") {
            return new Response("context unavailable", { status: 400 });
          }
          return Response.json(hyperliquidCandles());
        }
        return new Response(null, { status: 204 });
      },
    );
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-07-23T15:50:00.000Z"),
      {
        ...baseEnv(),
        BRIEF_INTERVAL_MINUTES: "10",
        FRAGILITY_PERSISTENCE_MODE: "display",
        SCANNER_STATE: state,
      },
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    const candleRequests = calls.filter(
      (call) => call.url === HYPERLIQUID_INFO_URL,
    );
    const webhookRequests = calls.filter(
      (call) => call.url !== HYPERLIQUID_INFO_URL,
    );
    expect(candleRequests).toHaveLength(3);
    expect(webhookRequests).toHaveLength(1);

    const body = webhookRequests[0]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const payload = JSON.parse(
      String((body as FormData).get("payload_json")),
    ) as {
      allowed_mentions: { parse: string[] };
      embeds: Array<{
        fields: Array<{ name: string; value: string }>;
      }>;
    };
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "市場資料",
          value: expect.stringContaining("STALE · RTH · 不納入決策"),
        }),
      ]),
    );
    expect(
      await state.get("market-fragility-v2-shadow:xyz:SP500"),
    ).toBeNull();
    expect(await state.get("resilience-decay:xyz:SP500")).toBeNull();
  });

  it("persists fixed-grid resilience snapshots when the brief is not due", async () => {
    const state = memoryKv({ "last-version-notice": "local-dev" });
    let candleRequestCount = 0;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        if (String(input) === HYPERLIQUID_INFO_URL) {
          const body = JSON.parse(String(init?.body)) as { type: string };
          if (body.type === "candleSnapshot") {
            candleRequestCount += 1;
          }
          return body.type === "metaAndAssetCtxs"
            ? new Response("context unavailable", { status: 400 })
            : Response.json(hyperliquidCandles().slice(0, 9));
        }
        return new Response(null, { status: 204 });
      },
    );
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-07-23T15:30:00.000Z"),
      {
        ...baseEnv(),
        BRIEF_INTERVAL_MINUTES: "60",
        RESILIENCE_DECAY_SHADOW_MODE: "shadow",
        SCANNER_STATE: state,
      },
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    const rawState = await state.get("resilience-decay:xyz:SP500");
    const resilienceState = JSON.parse(String(rawState)) as {
      version: number;
      snapshots: Array<{ timestamp: number }>;
      activeShock: { oneHourTroughPrice: number | null } | null;
    };
    expect(resilienceState.version).toBe(2);
    expect(resilienceState.snapshots).toHaveLength(2);
    expect(resilienceState.snapshots[1]?.timestamp).toBe(
      Date.parse("2026-07-23T15:29:59.999Z"),
    );
    expect(resilienceState.activeShock).toMatchObject({
      oneHourTroughPrice: null,
    });
    const rawShadow = await state.get(
      "resilience-decay-shadow-5m:xyz:SP500",
    );
    const shadowState = JSON.parse(String(rawShadow)) as {
      snapshots: Array<{ timestamp: number }>;
    };
    expect(shadowState.snapshots.length).toBeGreaterThan(
      resilienceState.snapshots.length,
    );
    expect(candleRequestCount).toBe(1);
  });

  it("recovers from the last successful candle after a rate-limited scan", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const state = memoryKv({
      "last-version-notice": "local-dev",
      "last-successful-candle:xyz:SP500": String(
        Date.parse("2026-07-23T15:29:59.999Z"),
      ),
    });
    let candleAttempts = 0;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        calls.push({ url, init });
        if (url === HYPERLIQUID_INFO_URL) {
          candleAttempts += 1;
          if (candleAttempts === 1) {
            return new Response(null, { status: 429 });
          }
          return Response.json(hyperliquidCandlesThroughClose());
        }
        return new Response(null, { status: 204 });
      },
    );

    const failedPromises: Promise<unknown>[] = [];
    await worker.scheduled(
      scheduledController("2026-07-23T15:45:00.000Z"),
      {
        ...baseEnv(),
        BRIEF_INTERVAL_MINUTES: "17",
        SCANNER_STATE: state,
      },
      waitUntilContext(failedPromises),
    );
    await Promise.all(failedPromises);

    const recoveredPromises: Promise<unknown>[] = [];
    await worker.scheduled(
      scheduledController("2026-07-23T16:00:00.000Z"),
      {
        ...baseEnv(),
        BRIEF_INTERVAL_MINUTES: "17",
        SCANNER_STATE: state,
      },
      waitUntilContext(recoveredPromises),
    );
    await Promise.all(recoveredPromises);

    const webhookRequests = calls.filter(
      (call) => call.url !== HYPERLIQUID_INFO_URL,
    );
    expect(webhookRequests).toHaveLength(2);
    const degradationPayload = JSON.parse(
      String(webhookRequests[0]?.init?.body),
    ) as { embeds: Array<{ title: string }> };
    expect(degradationPayload.embeds[0]?.title).toContain("資料源限流");
    expect(
      await state.get("last-successful-candle:xyz:SP500"),
    ).toBe(String(Date.parse("2026-07-23T15:59:59.999Z")));
    expect(
      await state.get("rate-limit-incident:xyz:SP500"),
    ).toBeNull();
  });

  it("sends one Discord notice for consecutive rate-limited scans", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const state = memoryKv({ "last-version-notice": "local-dev" });
    const warning = vi.spyOn(console, "warn").mockImplementation(
      () => undefined,
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        calls.push({ url, init });
        return url === HYPERLIQUID_INFO_URL
          ? new Response(null, { status: 429 })
          : new Response(null, { status: 204 });
      },
    );

    for (const timestamp of [
      "2026-07-23T15:45:00.000Z",
      "2026-07-23T16:00:00.000Z",
    ]) {
      const promises: Promise<unknown>[] = [];
      await worker.scheduled(
        scheduledController(timestamp),
        {
          ...baseEnv(),
          BRIEF_INTERVAL_MINUTES: "17",
          SCANNER_STATE: state,
        },
        waitUntilContext(promises),
      );
      await Promise.all(promises);
    }

    const webhookRequests = calls.filter(
      (call) => call.url !== HYPERLIQUID_INFO_URL,
    );
    expect(webhookRequests).toHaveLength(1);
    expect(
      warning.mock.calls.some(([message]) =>
        String(message).includes(
          '"message":"scheduled scan skipped: Hyperliquid rate limited"',
        ),
      ),
    ).toBe(true);
  });

  it("bootstraps bounded RVOL history only in the post-close window", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const state = memoryKv({ "last-version-notice": "local-dev" });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        calls.push({ url, init });
        if (url !== HYPERLIQUID_INFO_URL) {
          return new Response(null, { status: 204 });
        }
        const body = JSON.parse(String(init?.body)) as {
          type: string;
          req?: { interval?: string };
        };
        return body.req?.interval === "15m"
          ? Response.json(bootstrapFifteenMinuteCandles())
          : Response.json(hyperliquidCandles());
      },
    );
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-07-23T20:15:00.000Z"),
      { ...baseEnv(), SCANNER_STATE: state },
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    const candleIntervals = calls
      .filter((call) => call.url === HYPERLIQUID_INFO_URL)
      .map((call) => {
        const body = JSON.parse(String(call.init?.body)) as {
          req?: { interval?: string };
        };
        return body.req?.interval;
      });
    expect(candleIntervals).toEqual(["5m", "15m"]);
    const rawActivity = await state.get("market-activity:v1:xyz:SP500");
    const activityState = JSON.parse(String(rawActivity)) as {
      bootstrapAttemptedAt: number | null;
      completedSessions: unknown[];
    };
    expect(activityState.bootstrapAttemptedAt).toBe(
      Date.parse("2026-07-23T20:15:00.000Z"),
    );
    expect(activityState.completedSessions).toHaveLength(10);
    expect(
      calls.filter((call) => call.url !== HYPERLIQUID_INFO_URL),
    ).toHaveLength(0);
  });
});

function baseEnv(): Env {
  return {
    DISCORD_WEBHOOK_URL:
      "https://discord.com/api/webhooks/example/token",
    MINIMUM_WATCH_PRICE_R: "1",
    MINIMUM_WATCH_CONFIDENCE_SCORE: "60",
    MINIMUM_PRICE_R: "1",
    MINIMUM_CONFIDENCE_SCORE: "60",
  };
}

function hyperliquidCandles(): Array<Record<string, number | string>> {
  const firstStartTime = Date.parse("2026-07-23T14:45:00.000Z");
  const values = [
    [100, 102, 99, 101, 100],
    [101, 103, 100, 102, 100],
    [102, 104, 101, 103, 100],
    [103, 104, 100, 101, 100],
    [101, 102, 98, 99, 100],
    [99, 100, 97, 98, 100],
    [98, 99, 96, 97, 100],
    [97, 98, 95, 96, 100],
    [96, 97, 94, 95, 100],
    [91.5, 93.8, 91, 93.5, 220],
    [93.5, 94, 92.5, 93.7, 100],
    [93.7, 94.5, 93, 94, 100],
  ];

  return values.map(
    ([open, high, low, close, volume], index) => {
      const startTime = firstStartTime + index * 300_000;
      return {
        t: startTime,
        T: startTime + 299_999,
        o: String(open),
        h: String(high),
        l: String(low),
        c: String(close),
        v: String(volume),
        n: 10,
      };
    },
  );
}

function hyperliquidCandlesThroughClose(): Array<
  Record<string, number | string>
> {
  const candles = hyperliquidCandles();
  const prior = candles.at(-1);
  if (prior === undefined) {
    return candles;
  }
  const priorStartTime = Number(prior.t);
  return [
    ...candles,
    ...Array.from({ length: 3 }, (_, index) => {
      const startTime = priorStartTime + (index + 1) * 300_000;
      return {
        t: startTime,
        T: startTime + 299_999,
        o: "94",
        h: "94.5",
        l: "93.5",
        c: "94",
        v: "100",
        n: 10,
      };
    }),
  ];
}

function bootstrapFifteenMinuteCandles(): Array<
  Record<string, number | string>
> {
  const sessionDates = [
    "2026-07-09",
    "2026-07-10",
    "2026-07-13",
    "2026-07-14",
    "2026-07-15",
    "2026-07-16",
    "2026-07-17",
    "2026-07-20",
    "2026-07-21",
    "2026-07-22",
  ];
  return sessionDates.flatMap((sessionDate) => {
    const firstStartTime = Date.parse(`${sessionDate}T13:30:00.000Z`);
    return Array.from({ length: 26 }, (_, index) => {
      const startTime = firstStartTime + index * 15 * 60_000;
      return {
        t: startTime,
        T: startTime + 15 * 60_000 - 1,
        o: "100",
        h: "101",
        l: "99",
        c: "100",
        v: "300",
        n: 30,
      };
    });
  });
}

function scheduledController(timestamp: string): ScheduledController {
  return {
    scheduledTime: new Date(timestamp).getTime(),
    cron: "*/5 * * * *",
    noRetry: vi.fn(),
  };
}

function waitUntilContext(
  promises: Promise<unknown>[],
): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => {
      promises.push(promise);
    },
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

function memoryKv(initial: Record<string, string>): KVNamespace {
  const values = new Map(Object.entries(initial));
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  } as unknown as KVNamespace;
}
