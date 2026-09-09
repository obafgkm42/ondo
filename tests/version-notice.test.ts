import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/types";

describe("scheduled version notices", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not send a version notice without version metadata or KV state", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-06-24T12:46:37.000Z"),
      baseEnv(),
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not send stale no-KV version notices after the deploy window", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-06-24T13:31:00.000Z"),
      {
        ...baseEnv(),
        CF_VERSION_METADATA: {
          id: "1234567890abcdef",
          tag: "latest",
          timestamp: "2026-06-24T12:45:00.000Z",
        },
      },
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends a recent no-KV version notice as a best-effort deploy signal", async () => {
    const requests: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Response(null, { status: 204 });
      },
    );
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-06-24T12:46:37.000Z"),
      {
        ...baseEnv(),
        CF_VERSION_METADATA: {
          id: "1234567890abcdef",
          tag: "latest",
          timestamp: "2026-06-24T12:45:00.000Z",
        },
      },
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.body)).toContain("2026.06.24.204500");
  });

  it("waits for the scan before reporting a failed version notice", async () => {
    const candle = Promise.withResolvers<Response>();
    const candleStarted = Promise.withResolvers<void>();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input) === "https://api.hyperliquid.xyz/info") {
        candleStarted.resolve();
        return candle.promise;
      }
      return new Response("example notice failure", { status: 500 });
    });
    const pending: Promise<unknown>[] = [];
    await worker.scheduled(
      scheduledController("2026-07-23T15:45:39.000Z"),
      {
        ...baseEnv(),
        MARKET_ACTIVITY_MODE: "off",
        WORKER_VERSION: "example-new-version",
        SCANNER_STATE: memoryKv().namespace,
      },
      waitUntilContext(pending),
    );
    let completed = false;
    const outcome = Promise.all(pending).then(
      () => { completed = true; return "success"; },
      () => { completed = true; return "failure"; },
    );
    await candleStarted.promise;
    expect(completed).toBe(false);
    candle.resolve(Response.json([]));
    expect(await outcome).toBe("failure");
  });

  it("sends one version notice when the Cloudflare version changes", async () => {
    const requests: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Response(null, { status: 204 });
      },
    );
    const writes: Array<[string, string]> = [];
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-06-24T12:46:37.000Z"),
      {
        ...baseEnv(),
        CF_VERSION_METADATA: {
          id: "1234567890abcdef",
          tag: "latest",
          timestamp: "2026-06-24T12:45:00.000Z",
        },
        SCANNER_STATE: {
          get: async () => null,
          put: async (key: string, value: string) => {
            writes.push([key, value]);
          },
        } as unknown as KVNamespace,
      },
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.body)).toContain("2026.06.24.204500");
    expect(writes).toEqual([["last-version-notice", "cf-1234567890ab"]]);
  });

  it("passes the configured language to version notifications", async () => {
    const requests: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_url: string | URL | Request, init?: RequestInit) => {
        requests.push(init ?? {});
        return new Response(null, { status: 204 });
      },
    );
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-06-24T12:46:37.000Z"),
      {
        ...baseEnv(),
        LANGUAGE: "en",
        CF_VERSION_METADATA: {
          id: "abcdef1234567890",
          tag: "latest",
          timestamp: "2026-06-24T12:45:00.000Z",
        },
        SCANNER_STATE: {
          get: async () => null,
          put: async () => undefined,
        } as unknown as KVNamespace,
      },
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.embeds[0].title).toBe(
      "Hyperliquid SP500 Reversal Scanner updated",
    );
    expect(payload.embeds[0].fields[0].name).toBe("Reminder");
  });

  it("primes missing RVOL history on the first Cron of a new version", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const state = memoryKv();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = String(input);
        requests.push({ url, init });
        if (url === "https://api.hyperliquid.xyz/info") {
          return Response.json(bootstrapFifteenMinuteCandles());
        }
        return new Response(null, { status: 204 });
      },
    );
    const waitUntilPromises: Promise<unknown>[] = [];

    await worker.scheduled(
      scheduledController("2026-06-24T12:46:37.000Z"),
      {
        ...baseEnv(),
        MARKET_ACTIVITY_MODE: "display",
        CF_VERSION_METADATA: {
          id: "fedcba0987654321",
          tag: "latest",
          timestamp: "2026-06-24T12:45:00.000Z",
        },
        SCANNER_STATE: state.namespace,
      },
      waitUntilContext(waitUntilPromises),
    );
    await Promise.all(waitUntilPromises);

    const providerRequests = requests.filter(
      (request) => request.url === "https://api.hyperliquid.xyz/info",
    );
    expect(providerRequests).toHaveLength(1);
    expect(JSON.parse(String(providerRequests[0]?.init?.body))).toMatchObject({
      type: "candleSnapshot",
      req: { interval: "15m" },
    });
    const rawActivity = state.values.get("market-activity:v1:xyz:SP500");
    const activity = JSON.parse(String(rawActivity)) as {
      completedSessions: unknown[];
    };
    expect(activity.completedSessions).toHaveLength(10);
    expect(state.values.get("last-version-notice")).toBe("cf-fedcba098765");
  });
});

function baseEnv(): Env {
  return {
    DISCORD_WEBHOOK_URL:
      "https://discord.com/api/webhooks/example/token",
    MARKET_ACTIVITY_MODE: "off",
  };
}

function memoryKv(): {
  namespace: KVNamespace;
  values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    namespace: {
      get: async (key: string) => values.get(key) ?? null,
      put: async (key: string, value: string) => {
        values.set(key, value);
      },
    } as unknown as KVNamespace,
  };
}

function bootstrapFifteenMinuteCandles(): Array<Record<string, number | string>> {
  const sessionKeys = [
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
  return sessionKeys.flatMap((sessionKey) => {
    const sessionStart = Date.parse(`${sessionKey}T13:30:00.000Z`);
    return Array.from({ length: 26 }, (_, index) => {
      const startTime = sessionStart + index * 15 * 60_000;
      return {
        t: startTime,
        T: startTime + 15 * 60_000 - 1,
        o: "100",
        h: "101",
        l: "99",
        c: "100",
        v: "1000",
        n: 10,
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
