import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HyperliquidAdmissionError,
  HyperliquidRateLimitError,
} from "../src/hyperliquid";
import { ProviderTrafficController } from "../src/provider-traffic";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ProviderTrafficController", () => {
  it(
    "enforces the rolling weight ceiling and releases its exact boundary",
    async () => {
      let now = Date.parse("2026-09-14T00:00:00.000Z");
      let requestCount = 0;
      const controller = new ProviderTrafficController(
        memoryStorage().storage,
        async () => {
          requestCount += 1;
          return Response.json([]);
        },
        () => now,
      );

      for (let index = 0; index < 10; index += 1) {
        await controller.createAccess().fetchFiveMinuteCandles(
          "xyz:SP500",
          new Date(now),
        );
      }
      await expect(
        controller.createAccess().fetchFiveMinuteCandles(
          "xyz:SP500",
          new Date(now),
        ),
      ).rejects.toMatchObject({ reason: "budget" });
      expect(requestCount).toBe(10);

      now += 60_000;
      await expect(
        controller.createAccess().fetchFiveMinuteCandles(
          "xyz:SP500",
          new Date(now),
        ),
      ).resolves.toEqual([]);
      expect(requestCount).toBe(11);
    },
  );

  it("persists cooldown and admits only a successful post-expiry probe", async () => {
    vi.useFakeTimers();
    let now = Date.parse("2026-09-14T00:00:00.000Z");
    vi.setSystemTime(now);
    const { storage } = memoryStorage();
    let requestCount = 0;
    const fetcher = async (): Promise<Response> => {
      requestCount += 1;
      return requestCount === 1
        ? new Response(null, {
            status: 429,
            headers: { "Retry-After": "12" },
          })
        : Response.json([]);
    };
    const controller = () => new ProviderTrafficController(
      storage,
      fetcher as typeof fetch,
      () => now,
    );

    await expect(
      controller().createAccess().fetchFiveMinuteCandles(
        "xyz:SP500",
        new Date(now),
      ),
    ).rejects.toBeInstanceOf(HyperliquidRateLimitError);
    await expect(
      controller().createAccess().fetchFiveMinuteCandles(
        "xyz:SP500",
        new Date(now),
      ),
    ).rejects.toMatchObject({ reason: "cooldown" });
    expect(requestCount).toBe(1);

    now += 12_000;
    vi.setSystemTime(now);
    await expect(
      controller().createAccess().fetchFiveMinuteCandles(
        "xyz:SP500",
        new Date(now),
      ),
    ).resolves.toEqual([]);
    expect(requestCount).toBe(2);
  });

  it("suppresses later requests in an invocation after a zero-delay 429", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-14T00:00:00.000Z");
    vi.setSystemTime(now);
    let requestCount = 0;
    const controller = new ProviderTrafficController(
      memoryStorage().storage,
      async () => {
        requestCount += 1;
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "0" },
        });
      },
      () => now,
    );
    const access = controller.createAccess();

    await expect(access.fetchXyzStockCoins()).resolves.toMatchObject({
      cacheStatus: "unavailable",
      coins: [],
    });
    await expect(
      access.fetchXyzMarketContexts(["xyz:SP500"]),
    ).rejects.toMatchObject({ reason: "cooldown" });
    expect(requestCount).toBe(1);
  });

  it("suppresses a later bootstrap after a context 429", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-14T00:00:00.000Z");
    vi.setSystemTime(now);
    let requestCount = 0;
    const controller = new ProviderTrafficController(
      memoryStorage().storage,
      async () => {
        requestCount += 1;
        return new Response(null, { status: 429 });
      },
      () => now,
    );
    const access = controller.createAccess();

    await expect(
      access.fetchXyzMarketContexts(["xyz:SP500"]),
    ).rejects.toBeInstanceOf(HyperliquidRateLimitError);
    await expect(
      access.fetchFifteenMinuteCandles("xyz:SP500", new Date(now), 30),
    ).rejects.toMatchObject({ reason: "cooldown" });
    expect(requestCount).toBe(1);
  });

  it(
    "caches categories, backs off a failed refresh, and expires at 72 hours",
    async () => {
      let now = Date.parse("2026-09-14T00:00:00.000Z");
      const { storage } = memoryStorage();
      let requestCount = 0;
      let refreshFails = false;
      const controller = new ProviderTrafficController(
        storage,
        async () => {
          requestCount += 1;
          return refreshFails
            ? new Response(null, { status: 400 })
            : Response.json([
                ["xyz:SP500", "stocks"],
                ["xyz:BTC", "crypto"],
              ]);
        },
        () => now,
      );

      await expect(controller.createAccess().fetchXyzStockCoins()).resolves
        .toEqual({
          coins: ["xyz:SP500"],
          cacheStatus: "refreshed",
          cacheAgeMs: 0,
        });
      now += 60 * 60 * 1_000;
      await expect(controller.createAccess().fetchXyzStockCoins()).resolves
        .toMatchObject({
          cacheStatus: "cached",
          cacheAgeMs: 60 * 60 * 1_000,
        });
      expect(requestCount).toBe(1);

      now += 24 * 60 * 60 * 1_000;
      refreshFails = true;
      await expect(controller.createAccess().fetchXyzStockCoins()).resolves
        .toMatchObject({ cacheStatus: "stale", coins: ["xyz:SP500"] });
      await expect(controller.createAccess().fetchXyzStockCoins()).resolves
        .toMatchObject({ cacheStatus: "stale", coins: ["xyz:SP500"] });
      expect(requestCount).toBe(2);

      now += 48 * 60 * 60 * 1_000;
      await expect(controller.createAccess().fetchXyzStockCoins()).resolves
        .toMatchObject({ cacheStatus: "unavailable", coins: [] });
    },
  );

  it("reserves large bootstrap responses and counts lost attempts", async () => {
    let now = Date.parse("2026-09-14T00:00:00.000Z");
    const { storage, values } = memoryStorage();
    let requestCount = 0;
    const controller = new ProviderTrafficController(
      storage,
      async () => {
        requestCount += 1;
        throw new Error("example lost response");
      },
      () => now,
    );
    for (let index = 0; index < 3; index += 1) {
      await expect(
        controller.createAccess().fetchFifteenMinuteCandles(
          "xyz:SP500",
          new Date(now),
          30,
        ),
      ).rejects.toThrow("lost response");
    }
    await expect(
      controller.createAccess().fetchFifteenMinuteCandles(
        "xyz:SP500",
        new Date(now),
        30,
      ),
    ).rejects.toBeInstanceOf(HyperliquidAdmissionError);
    expect(requestCount).toBe(3);
    expect(values.get("hyperliquid-traffic:v1")).toMatchObject({
      reservations: [
        { estimatedWeight: 69 },
        { estimatedWeight: 69 },
        { estimatedWeight: 69 },
      ],
    });
    now += 1;
  });

  it("admits and accounts for every 5xx retry attempt", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const now = Date.parse("2026-09-14T00:00:00.000Z");
    vi.setSystemTime(now);
    const { storage, values } = memoryStorage();
    let requestCount = 0;
    const controller = new ProviderTrafficController(
      storage,
      async () => {
        requestCount += 1;
        return requestCount < 3
          ? new Response(null, { status: 503 })
          : Response.json([]);
      },
      () => now,
    );

    const result = controller.createAccess().fetchFiveMinuteCandles(
      "xyz:SP500",
      new Date(now),
    );
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual([]);
    expect(requestCount).toBe(3);
    expect(values.get("hyperliquid-traffic:v1")).toMatchObject({
      reservations: [
        { estimatedWeight: 24 },
        { estimatedWeight: 24 },
        { estimatedWeight: 24 },
      ],
    });
  });

  it("never has more than one provider request in flight", async () => {
    const gate = Promise.withResolvers<void>();
    let inFlight = 0;
    let maximumInFlight = 0;
    const controller = new ProviderTrafficController(
      memoryStorage().storage,
      async (input, init) => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await gate.promise;
        inFlight -= 1;
        const body = await new Request(input, init).json() as { type: string };
        return body.type === "metaAndAssetCtxs"
          ? Response.json([{ universe: [] }, []])
          : Response.json([]);
      },
    );
    const first = controller.createAccess().fetchFiveMinuteCandles(
      "xyz:SP500",
      new Date(),
    );
    const second = controller.createAccess().fetchXyzMarketContexts([
      "xyz:SP500",
    ]);
    await vi.waitFor(() => expect(inFlight).toBe(1));
    gate.resolve();
    await Promise.all([first, second]);
    expect(maximumInFlight).toBe(1);
  });

  it("fails closed before network I/O when budget storage is unavailable", async () => {
    let requestCount = 0;
    const storage = {
      get: async () => {
        throw new Error("storage unavailable");
      },
      put: async () => undefined,
    } as unknown as DurableObjectStorage;
    const controller = new ProviderTrafficController(storage, async () => {
      requestCount += 1;
      return Response.json([]);
    });

    await expect(
      controller.createAccess().fetchFiveMinuteCandles(
        "xyz:SP500",
        new Date(),
      ),
    ).rejects.toMatchObject({ reason: "state_unavailable" });
    expect(requestCount).toBe(0);
  });

  it("fails closed when persisted budget state is corrupt", async () => {
    const { storage, values } = memoryStorage();
    values.set("hyperliquid-traffic:v1", { version: 1, reservations: "bad" });
    let requestCount = 0;
    const controller = new ProviderTrafficController(storage, async () => {
      requestCount += 1;
      return Response.json([]);
    });

    await expect(
      controller.createAccess().fetchFiveMinuteCandles(
        "xyz:SP500",
        new Date(),
      ),
    ).rejects.toMatchObject({ reason: "state_unavailable" });
    expect(requestCount).toBe(0);
  });
});

function memoryStorage(): {
  storage: DurableObjectStorage;
  values: Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  const storage = {
    get: async (key: string) => values.get(key),
    put: async (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
  } as unknown as DurableObjectStorage;
  return { storage, values };
}
