import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { Env, RequestRateLimiter } from "../src/types";

const probePaths = [
  "/.env",
  "/.git/config",
  "/.DS_Store",
  "/config.json",
  "/graphql",
  "/api/graphql",
  "/api/gql",
  "/api",
  "/does-not-exist",
];

describe("public Worker routing", () => {
  it.each(probePaths)("returns a minimal 404 for %s", async (pathname) => {
    const response = await fetchWorker(pathname);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not found" });
  });

  it.each([
    ["POST", "/"],
    ["POST", "/scan"],
    ["GET", "/discord/interactions"],
    ["PUT", "/discord/interactions"],
  ])("returns 404 for unsupported %s %s", async (method, pathname) => {
    expect((await fetchWorker(pathname, { method })).status).toBe(404);
  });

  it("keeps the root response deliberately minimal", async () => {
    const response = await fetchWorker("/");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("hides unauthenticated scans without consuming rate-limit capacity", async () => {
    const limiter = mockLimiter(false);
    const response = await fetchWorker("/scan", {}, {
      MANUAL_SCAN_TOKEN: "example-manual-token",
      MANUAL_SCAN_RATE_LIMITER: limiter,
    });

    expect(response.status).toBe(404);
    expect(limiter.limit).not.toHaveBeenCalled();
  });

  it("rate limits an authenticated scan before dispatch", async () => {
    const limiter = mockLimiter(false);
    const response = await fetchWorker("/scan", {
      headers: { Authorization: "Bearer example-manual-token" },
    }, {
      MANUAL_SCAN_TOKEN: "example-manual-token",
      MANUAL_SCAN_RATE_LIMITER: limiter,
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({
      key: "manual-scan",
    });
  });

  it("does not expose Durable Object handlers through public routing", async () => {
    const coordinatorFetch = vi.fn();
    const env: Partial<Env> = {
      SCAN_EXECUTION_MODE: "durable-object",
      SCAN_COORDINATOR: {
        idFromName: vi.fn(() => "example-object-id"),
        get: vi.fn(() => ({ fetch: coordinatorFetch })),
      } as unknown as DurableObjectNamespace,
    };

    for (const pathname of ["/scheduled", "/status", "/internal/status"]) {
      expect((await fetchWorker(pathname, { method: "POST" }, env)).status)
        .toBe(404);
    }
    expect(coordinatorFetch).not.toHaveBeenCalled();
  });

  it("rate limits Discord before loading configuration or reading a body", async () => {
    const limiter = mockLimiter(false);
    const response = await fetchWorker("/discord/interactions", {
      method: "POST",
      body: "not read",
    }, { DISCORD_INTERACTIONS_RATE_LIMITER: limiter });

    expect(response.status).toBe(429);
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({
      key: "discord-interactions",
    });
  });
});

async function fetchWorker(
  pathname: string,
  init: RequestInit = {},
  envOverrides: Partial<Env> = {},
): Promise<Response> {
  const env = {
    DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/example/token",
    ...envOverrides,
  } as Env;
  return worker.fetch(
    new Request(`https://scanner.example${pathname}`, init),
    env,
    {
      waitUntil: vi.fn(),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext,
  );
}

function mockLimiter(success: boolean): RequestRateLimiter {
  return {
    limit: vi.fn(async () => ({ success })),
  };
}
