import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HyperliquidAdmissionError,
  HyperliquidRateLimitError,
} from "../src/hyperliquid";
import worker from "../src/index";
import { ScanCoordinator } from "../src/scan-coordinator";
import {
  dispatchManualScan,
  dispatchScheduledScan,
  getScanExecutionMode,
} from "../src/scan-dispatch";
import {
  executeManualScan,
  executeScheduledScan,
  type ScanExecutionResult,
} from "../src/scan-service";
import type { Env } from "../src/types";

vi.mock("../src/scan-service", () => ({
  executeManualScan: vi.fn(),
  executeScheduledScan: vi.fn(),
}));

const scheduledTime = Date.parse("2026-07-23T15:45:39.000Z");

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(executeManualScan).mockResolvedValue(scanResult());
  vi.mocked(executeScheduledScan).mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ScanCoordinator", () => {
  it("shares concurrent manual queries and bounds later refreshes", async () => {
    const pending = Promise.withResolvers<ScanExecutionResult>();
    vi.mocked(executeManualScan).mockReturnValueOnce(pending.promise);
    const coordinator = new ScanCoordinator(memoryState(), baseEnv());
    const first = coordinator.fetch(statusRequest());
    const second = coordinator.fetch(statusRequest());
    await vi.waitFor(() => expect(executeManualScan).toHaveBeenCalledTimes(1));
    pending.resolve(scanResult());
    const responses = await Promise.all([first, second]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ...scanResult(),
        providerAccess: { status: "fresh", reason: null },
      });
    }
    const cached = await coordinator.fetch(statusRequest());
    await expect(cached.json()).resolves.toMatchObject({
      providerAccess: { status: "cached", reason: "refresh_interval" },
    });
    expect(executeManualScan).toHaveBeenCalledTimes(1);
  });

  it("queues scheduled work without changing the original tick time", async () => {
    const pending = Promise.withResolvers<ScanExecutionResult>();
    vi.mocked(executeManualScan).mockReturnValueOnce(pending.promise);
    const coordinator = new ScanCoordinator(memoryState(), baseEnv());
    const manual = coordinator.fetch(statusRequest());
    const scheduled = coordinator.fetch(scheduledRequest());
    await vi.waitFor(() => expect(executeManualScan).toHaveBeenCalledTimes(1));
    expect(executeScheduledScan).not.toHaveBeenCalled();
    pending.resolve(scanResult());
    await Promise.all([manual, scheduled]);
    expect(executeScheduledScan).toHaveBeenCalledExactlyOnceWith(
      expect.any(Object),
      new Date(scheduledTime),
      expect.any(Object),
    );
  });

  it("queues manual queries behind the entire scheduled execution", async () => {
    const pending = Promise.withResolvers<void>();
    vi.mocked(executeScheduledScan).mockReturnValueOnce(pending.promise);
    const coordinator = new ScanCoordinator(memoryState(), baseEnv());
    const scheduled = coordinator.fetch(scheduledRequest());
    await vi.waitFor(() => expect(executeScheduledScan).toHaveBeenCalledTimes(1));
    const manual = coordinator.fetch(statusRequest());
    await Promise.resolve();
    expect(executeManualScan).not.toHaveBeenCalled();
    pending.resolve();
    await Promise.all([scheduled, manual]);
    expect(executeManualScan).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent and persisted ticks across object restarts", async () => {
    const state = memoryState();
    const coordinator = new ScanCoordinator(state, baseEnv());
    await Promise.all([
      coordinator.fetch(scheduledRequest()),
      coordinator.fetch(scheduledRequest()),
    ]);
    const restarted = new ScanCoordinator(state, baseEnv());
    await restarted.fetch(scheduledRequest());
    await restarted.fetch(scheduledRequest(scheduledTime - 300_000));
    expect(executeScheduledScan).toHaveBeenCalledTimes(1);
    await restarted.fetch(scheduledRequest(scheduledTime + 300_000));
    expect(executeScheduledScan).toHaveBeenCalledTimes(2);
  });

  it("releases failed manual queries and retains the 429 response", async () => {
    vi.mocked(executeManualScan).mockRejectedValueOnce(
      new HyperliquidRateLimitError(429, "candle"),
    );
    const coordinator = new ScanCoordinator(memoryState(), baseEnv());
    expect((await coordinator.fetch(statusRequest())).status).toBe(429);
    expect((await coordinator.fetch(statusRequest())).status).toBe(200);
    expect(executeManualScan).toHaveBeenCalledTimes(2);
  });

  it("serves an older labelled cache when a refresh is rate limited", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-15T00:00:00.000Z"));
    const coordinator = new ScanCoordinator(memoryState(), baseEnv());
    expect((await coordinator.fetch(statusRequest())).status).toBe(200);
    vi.advanceTimersByTime(61_000);
    vi.mocked(executeManualScan).mockRejectedValueOnce(
      new HyperliquidRateLimitError(429, "candle"),
    );

    const response = await coordinator.fetch(statusRequest());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      providerAccess: { status: "cached", reason: "cooldown" },
    });
    expect(executeManualScan).toHaveBeenCalledTimes(2);
  });

  it("keeps failed ticks retryable and allows later work", async () => {
    vi.mocked(executeScheduledScan).mockRejectedValueOnce(new Error("example"));
    const coordinator = new ScanCoordinator(memoryState(), baseEnv());
    expect((await coordinator.fetch(scheduledRequest())).status).toBe(502);
    expect((await coordinator.fetch(statusRequest())).status).toBe(200);
    expect((await coordinator.fetch(scheduledRequest())).status).toBe(204);
    expect(executeScheduledScan).toHaveBeenCalledTimes(2);
  });

  it("discards obsolete queued ticks instead of replaying a backlog", async () => {
    const pending = Promise.withResolvers<ScanExecutionResult>();
    vi.mocked(executeManualScan).mockReturnValueOnce(pending.promise);
    const coordinator = new ScanCoordinator(memoryState(), baseEnv());
    const manual = coordinator.fetch(statusRequest());
    await vi.waitFor(() => expect(executeManualScan).toHaveBeenCalledTimes(1));
    const older = coordinator.fetch(scheduledRequest());
    await Promise.resolve();
    const newer = coordinator.fetch(scheduledRequest(scheduledTime + 300_000));
    pending.resolve(scanResult());

    await Promise.all([manual, older, newer]);
    expect(executeScheduledScan).toHaveBeenCalledTimes(1);
    expect(executeScheduledScan).toHaveBeenCalledWith(
      expect.any(Object),
      new Date(scheduledTime + 300_000),
      expect.any(Object),
    );
  });

  it("returns a labelled unavailable result when coordinator state fails", async () => {
    const state = {
      storage: {
        get: async () => {
          throw new Error("example storage failure");
        },
      },
    } as unknown as DurableObjectState;
    const coordinator = new ScanCoordinator(state, baseEnv());

    const response = await coordinator.fetch(statusRequest());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "hyperliquid_state_unavailable",
      providerAccess: {
        status: "unavailable",
        asOf: null,
        reason: "state_unavailable",
      },
    });
    expect(executeManualScan).not.toHaveBeenCalled();
  });

  it("rejects malformed ticks before any scan or state update", async () => {
    const coordinator = new ScanCoordinator(memoryState(), baseEnv());
    for (const time of [null, "123", -1, 1.5, 9e15]) {
      const response = await coordinator.fetch(new Request(
        "https://scanner.internal/scheduled",
        { method: "POST", body: JSON.stringify({ scheduledTime: time }) },
      ));
      expect(response.status).toBe(400);
    }
    expect(executeScheduledScan).not.toHaveBeenCalled();
    expect((await coordinator.fetch(new Request(
      "https://scanner.internal/status",
    ))).status).toBe(404);
  });
});

describe("scan dispatch", () => {
  it("validates the rollout mode and keeps an explicit direct rollback", async () => {
    expect(getScanExecutionMode({})).toBe("direct");
    expect(getScanExecutionMode({ SCAN_EXECUTION_MODE: " DURABLE-OBJECT " }))
      .toBe("durable-object");
    expect(() => getScanExecutionMode({ SCAN_EXECUTION_MODE: "typo" }))
      .toThrow("SCAN_EXECUTION_MODE");
    const { env, fetcher } = coordinatedEnv();
    env.SCAN_EXECUTION_MODE = "direct";
    await dispatchScheduledScan(env, scheduledTime);
    await dispatchManualScan(env);
    expect(fetcher).not.toHaveBeenCalled();
    expect(executeScheduledScan).toHaveBeenCalledTimes(1);
    expect(executeManualScan).toHaveBeenCalledTimes(1);
  });

  it("routes both entry points to the same named object", async () => {
    const { env, name, fetcher } = coordinatedEnv();
    await dispatchScheduledScan(env, scheduledTime);
    await expect(dispatchManualScan(env)).resolves.toMatchObject({
      ...scanResult(),
      providerAccess: { status: "fresh", reason: null },
    });
    expect(name.mock.calls).toEqual([["scanner"], ["scanner"]]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(executeScheduledScan).toHaveBeenCalledWith(
      expect.any(Object), new Date(scheduledTime), expect.any(Object),
    );
  });

  it("does not bypass a missing or failing coordinator", async () => {
    await expect(dispatchScheduledScan({
      ...baseEnv(), SCAN_EXECUTION_MODE: "durable-object",
    }, scheduledTime)).rejects.toThrow("SCAN_COORDINATOR");
    const { env, fetcher } = coordinatedEnv();
    fetcher.mockRejectedValue(new Error("example transport failure"));
    await expect(dispatchManualScan(env)).rejects.toThrow("transport");
    expect(executeManualScan).not.toHaveBeenCalled();
    expect(executeScheduledScan).not.toHaveBeenCalled();
  });

  it("restores Discord's typed error after internal HTTP transport", async () => {
    const { env } = coordinatedEnv();
    vi.mocked(executeManualScan).mockRejectedValueOnce(
      new HyperliquidRateLimitError(429, "candle"),
    );
    await expect(dispatchManualScan(env)).rejects
      .toBeInstanceOf(HyperliquidRateLimitError);
  });

  it("restores a typed local admission error without a direct fallback", async () => {
    const fetcher = vi.fn(async () => Response.json(
      { error: "hyperliquid_budget" },
      { status: 503 },
    ));
    const env = {
      ...baseEnv(),
      SCAN_EXECUTION_MODE: "durable-object",
      SCAN_COORDINATOR: {
        idFromName: () => "example-object-id",
        get: () => ({ fetch: fetcher }),
      } as unknown as DurableObjectNamespace,
    };

    await expect(dispatchManualScan(env)).rejects.toEqual(
      new HyperliquidAdmissionError("budget"),
    );
    expect(executeManualScan).not.toHaveBeenCalled();
  });

  it("authenticates HTTP scans before contacting the object", async () => {
    const { env, fetcher } = coordinatedEnv();
    env.MANUAL_SCAN_TOKEN = "example-manual-token";
    const context = { waitUntil: vi.fn() } as unknown as ExecutionContext;
    const unauthorized = await worker.fetch(
      new Request("https://scanner.example/scan"), env, context,
    );
    expect(unauthorized.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await worker.fetch(new Request(
      "https://scanner.example/scan",
      { headers: { Authorization: "Bearer example-manual-token" } },
    ), env, context);
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns a labelled public 503 when fresh provider access is denied", async () => {
    const fetcher = vi.fn(async () => Response.json(
      { error: "hyperliquid_budget" },
      { status: 503 },
    ));
    const env = {
      ...baseEnv(),
      MANUAL_SCAN_TOKEN: "example-manual-token",
      SCAN_EXECUTION_MODE: "durable-object",
      SCAN_COORDINATOR: {
        idFromName: () => "example-object-id",
        get: () => ({ fetch: fetcher }),
      } as unknown as DurableObjectNamespace,
    };
    const response = await worker.fetch(
      new Request("https://scanner.example/scan", {
        headers: { Authorization: "Bearer example-manual-token" },
      }),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "provider data unavailable",
      providerAccess: {
        status: "unavailable",
        asOf: null,
        reason: "budget",
      },
    });
    expect(executeManualScan).not.toHaveBeenCalled();
  });
});

function baseEnv(): Env {
  return { DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/example/token" };
}

function memoryState(): DurableObjectState {
  const values = new Map<string, unknown>();
  return {
    storage: {
      get: async (key: string) => values.get(key),
      put: async (key: string, value: unknown) => { values.set(key, value); },
    },
  } as unknown as DurableObjectState;
}

function coordinatedEnv() {
  const env = { ...baseEnv(), SCAN_EXECUTION_MODE: "durable-object" } as Env;
  const coordinator = new ScanCoordinator(memoryState(), env);
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    coordinator.fetch(new Request(url, init))
  );
  const name = vi.fn(() => "example-object-id");
  env.SCAN_COORDINATOR = {
    idFromName: name,
    get: () => ({ fetch: fetcher }),
  } as unknown as DurableObjectNamespace;
  return { env, name, fetcher };
}

function statusRequest(): Request {
  return new Request("https://scanner.internal/status", { method: "POST" });
}

function scheduledRequest(time = scheduledTime): Request {
  return new Request("https://scanner.internal/scheduled", {
    method: "POST", body: JSON.stringify({ scheduledTime: time }),
  });
}

function scanResult(): ScanExecutionResult {
  return {
    scan: {
      watch: null, signal: null, market: "xyz:SP500", candleCount: 0,
      sessionHigh: null, sessionLow: null, latestPrice: null, status: "unavailable",
    },
    fragility: null,
    activity: null,
    dataHealth: {
      status: "unavailable", sessionScope: "overnight", candleCount: 0,
      latestEndTime: null, expectedLatestEndTime: 0, lagIntervals: null,
      gapCount: 0, missingIntervals: 0, stateEligible: false, reasons: [],
    },
  };
}
