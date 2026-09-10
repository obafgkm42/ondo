import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  handleDiscordInteraction,
  verifyDiscordRequest,
  type DiscordInteractionOptions,
  type DiscordScannerStatus,
} from "../src/discord-interactions";
import { HyperliquidRateLimitError } from "../src/hyperliquid";
import worker from "../src/index";
import type {
  Env,
  MarketActivitySnapshot,
  MarketDataHealth,
  MarketFragilitySnapshot,
  ScanResult,
} from "../src/types";

const GUILD_ID = "123456789012345678";
const APPLICATION_ID = "234567890123456789";
let publicKeyHex = "";
let privateKey: CryptoKey;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;
  const rawPublicKey = await crypto.subtle.exportKey(
    "raw",
    keyPair.publicKey,
  ) as ArrayBuffer;
  publicKeyHex = bytesToHex(new Uint8Array(rawPublicKey));
  privateKey = keyPair.privateKey;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyDiscordRequest", () => {
  it("accepts a fresh valid signature and rejects tampering", async () => {
    const body = JSON.stringify({ type: 1 });
    const timestamp = currentTimestamp();
    const signature = await signDiscordBody(timestamp, body);

    await expect(
      verifyDiscordRequest(
        publicKeyHex,
        signature,
        timestamp,
        body,
      ),
    ).resolves.toBe(true);
    await expect(
      verifyDiscordRequest(
        publicKeyHex,
        signature,
        timestamp,
        `${body} `,
      ),
    ).resolves.toBe(false);
  });

  it("rejects a correctly signed stale request", async () => {
    const now = Date.now();
    const timestamp = String(Math.floor((now - 10 * 60_000) / 1_000));
    const body = JSON.stringify({ type: 1 });
    const signature = await signDiscordBody(timestamp, body);

    await expect(
      verifyDiscordRequest(
        publicKeyHex,
        signature,
        timestamp,
        body,
        now,
      ),
    ).resolves.toBe(false);
  });
});

describe("handleDiscordInteraction", () => {
  it("acknowledges Discord endpoint-validation pings", async () => {
    const request = await signedRequest({ type: 1 });
    const response = await handleDiscordInteraction(
      request,
      baseOptions(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it("routes the public interactions endpoint through the Worker", async () => {
    const request = await signedRequest({ type: 1 });
    const response = await worker.fetch(
      request,
      workerEnv(),
      executionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it("routes authenticated status through the coordinator after deferring", async () => {
    const pending: Promise<unknown>[] = [];
    const coordinatorFetch = vi.fn(async () => Response.json(scannerStatus()));
    const name = vi.fn(() => "example-object-id");
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const env: Env = {
      ...workerEnv(),
      SCAN_EXECUTION_MODE: "durable-object",
      SCAN_COORDINATOR: {
        idFromName: name,
        get: () => ({ fetch: coordinatorFetch }),
      } as unknown as DurableObjectNamespace,
    };
    const context = executionContext();
    context.waitUntil = (promise) => { pending.push(promise); };
    const response = await worker.fetch(
      await signedRequest(commandInteraction("status")), env, context,
    );
    await expect(response.json()).resolves.toEqual({
      type: 5, data: { flags: 64 },
    });
    await Promise.all(pending);
    expect(name).toHaveBeenCalledWith("scanner");
    expect(coordinatorFetch).toHaveBeenCalledExactlyOnceWith(
      "https://scanner.internal/status", { method: "POST" },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe("PATCH");
  });

  it("returns the repair guide privately without requesting market data", async () => {
    const getStatus = vi.fn<() => Promise<DiscordScannerStatus>>();
    const request = await signedRequest(commandInteraction("repair"));
    const response = await handleDiscordInteraction(
      request,
      baseOptions({ getStatus }),
    );
    const payload = await response.json() as {
      type: number;
      data: {
        flags: number;
        allowed_mentions: { parse: string[] };
        embeds: Array<{
          title: string;
          fields: Array<{ name: string; value: string }>;
        }>;
      };
    };

    expect(payload.type).toBe(4);
    expect(payload.data.flags).toBe(64);
    expect(payload.data.allowed_mentions).toEqual({ parse: [] });
    expect(payload.data.embeds[0]?.title).toContain("修復機制說明書");
    expect(payload.data.embeds[0]?.fields).toHaveLength(8);
    expect(payload.data.embeds[0]?.fields[1]?.value).toContain(
      "<= -0.35 ATR and 3 closes below VWAP",
    );
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("defers a live status query and edits the private original response", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const waitUntilPromises: Promise<void>[] = [];
    const fetcher = vi.fn(
      async (
        input: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        requests.push({ url: String(input), init });
        return new Response(null, { status: 204 });
      },
    );
    const request = await signedRequest(commandInteraction("status"));
    const response = await handleDiscordInteraction(
      request,
      baseOptions({
        getStatus: async () => scannerStatus(),
        fetcher: fetcher as typeof fetch,
        waitUntil: (promise) => waitUntilPromises.push(promise),
      }),
    );

    await expect(response.json()).resolves.toEqual({
      type: 5,
      data: { flags: 64 },
    });
    expect(waitUntilPromises).toHaveLength(1);
    await Promise.all(waitUntilPromises);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/interaction-token/messages/@original`,
    );
    expect(requests[0]?.init?.method).toBe("PATCH");
    const message = JSON.parse(String(requests[0]?.init?.body)) as {
      allowed_mentions: { parse: string[] };
      embeds: Array<{
        title: string;
        description: string;
        fields: Array<{ name: string; value: string }>;
      }>;
    };
    expect(message.allowed_mentions).toEqual({ parse: [] });
    expect(message.embeds[0]?.title).toBe("SP500 掃描器狀態 · BREAKING");
    expect(message.embeds[0]?.description).toContain("壓力 60/100");
    expect(message.embeds[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "修復機制",
          value: expect.stringContaining("🔴 VWAP 修復失敗"),
        }),
        expect.objectContaining({
          name: "市場活躍度",
          value: expect.stringContaining(
            "今日累積量：1.31x（相較過去同時刻均值）",
          ),
        }),
        expect.objectContaining({
          name: "輸入資料健康度",
          value: expect.stringContaining("HEALTHY · RTH · 可用於決策"),
        }),
      ]),
    );
  });

  it("turns a live rate limit into a visible private status error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const responseBodies: string[] = [];
    const waitUntilPromises: Promise<void>[] = [];
    const request = await signedRequest(commandInteraction("status"));
    const response = await handleDiscordInteraction(
      request,
      baseOptions({
        getStatus: async () => {
          throw new HyperliquidRateLimitError(429, "candle");
        },
        fetcher: (async (
          _input: string | URL | Request,
          init?: RequestInit,
        ): Promise<Response> => {
          responseBodies.push(String(init?.body));
          return new Response(null, { status: 204 });
        }) as typeof fetch,
        waitUntil: (promise) => waitUntilPromises.push(promise),
      }),
    );

    expect((await response.json() as { type: number }).type).toBe(5);
    await Promise.all(waitUntilPromises);

    const message = JSON.parse(responseBodies[0] ?? "{}") as {
      embeds?: Array<{ title: string; description: string }>;
    };
    expect(message.embeds?.[0]?.title).toContain("查詢未完成");
    expect(message.embeds?.[0]?.description).toContain("限制了即時資料請求");
  });

  it("rejects commands from any guild other than the configured guild", async () => {
    const getStatus = vi.fn<() => Promise<DiscordScannerStatus>>();
    const request = await signedRequest({
      ...commandInteraction("status"),
      guild_id: "999999999999999999",
    });
    const response = await handleDiscordInteraction(
      request,
      baseOptions({ getStatus }),
    );
    const payload = await response.json() as {
      type: number;
      data: { content: string; flags: number };
    };

    expect(payload.type).toBe(4);
    expect(payload.data.flags).toBe(64);
    expect(payload.data.content).toContain("未獲授權");
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid request signature", async () => {
    const getStatus = vi.fn<() => Promise<DiscordScannerStatus>>();
    const request = await signedRequest(commandInteraction("help"));
    request.headers.set("X-Signature-Ed25519", "00".repeat(64));

    const response = await handleDiscordInteraction(
      request,
      baseOptions({ getStatus }),
    );

    expect(response.status).toBe(401);
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized body before reading it", async () => {
    const request = new Request(
      "https://scanner.example/discord/interactions",
      {
        method: "POST",
        headers: { "Content-Length": "65537" },
        body: "not read",
      },
    );

    const response = await handleDiscordInteraction(request, baseOptions());

    expect(response.status).toBe(413);
  });

  it("rejects an oversized streamed body without trusting Content-Length", async () => {
    const request = new Request(
      "https://scanner.example/discord/interactions",
      { method: "POST", body: "x".repeat(65_537) },
    );

    const response = await handleDiscordInteraction(request, baseOptions());

    expect(response.status).toBe(413);
  });

  it("returns 503 until the interaction key and guild are configured", async () => {
    const request = await signedRequest({ type: 1 });
    const response = await handleDiscordInteraction(
      request,
      baseOptions({ publicKey: undefined }),
    );

    expect(response.status).toBe(503);
  });
});

function baseOptions(
  overrides: Partial<DiscordInteractionOptions> = {},
): DiscordInteractionOptions {
  return {
    publicKey: publicKeyHex,
    allowedGuildId: GUILD_ID,
    language: "zh",
    getStatus: async () => scannerStatus(),
    waitUntil: () => undefined,
    ...overrides,
  };
}

function workerEnv(): Env {
  return {
    DISCORD_WEBHOOK_URL:
      "https://discord.com/api/webhooks/example/token",
    DISCORD_APPLICATION_PUBLIC_KEY: publicKeyHex,
    DISCORD_GUILD_ID: GUILD_ID,
  };
}

function executionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext;
}

function commandInteraction(subcommand: string): object {
  return {
    application_id: APPLICATION_ID,
    token: "interaction-token",
    type: 2,
    guild_id: GUILD_ID,
    data: {
      name: "scanner",
      options: [{ name: subcommand, type: 1 }],
    },
  };
}

async function signedRequest(payload: object): Promise<Request> {
  const body = JSON.stringify(payload);
  const timestamp = currentTimestamp();
  const signature = await signDiscordBody(timestamp, body);
  return new Request("https://scanner.example/discord/interactions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": timestamp,
    },
    body,
  });
}

async function signDiscordBody(
  timestamp: string,
  body: string,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "Ed25519",
    privateKey,
    new TextEncoder().encode(`${timestamp}${body}`),
  );
  return bytesToHex(new Uint8Array(signature));
}

function currentTimestamp(): string {
  return String(Math.floor(Date.now() / 1_000));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function scannerStatus(): DiscordScannerStatus {
  return {
    scan: scanResult(),
    fragility: fragilitySnapshot(),
    activity: activitySnapshot(),
    dataHealth: healthyDataHealth(),
  };
}

function healthyDataHealth(): MarketDataHealth {
  return {
    status: "healthy",
    sessionScope: "rth",
    candleCount: 12,
    latestEndTime: Date.parse("2026-06-23T15:29:59.999Z"),
    expectedLatestEndTime: Date.parse("2026-06-23T15:29:59.999Z"),
    lagIntervals: 0,
    gapCount: 0,
    missingIntervals: 0,
    stateEligible: true,
    reasons: [],
  };
}

function activitySnapshot(): MarketActivitySnapshot {
  return {
    market: "xyz:SP500",
    sessionKey: "2026-06-23",
    level: "ACTIVE",
    sessionRvol: 1.31,
    barRvol: 1.7,
    barActivity: "elevated",
    percentile: 82,
    percentileBand: "high",
    sampleSessions: 46,
    confidence: "confirmed",
    dataQuality: "good",
    currentSlotIndex: 7,
    asOf: Date.parse("2026-06-23T15:30:00.000Z"),
    source: "hyperliquid",
  };
}

function scanResult(): ScanResult {
  return {
    market: "xyz:SP500",
    candleCount: 12,
    sessionHigh: 6100,
    sessionLow: 6000,
    latestPrice: 6010,
    status:
      "no fresh lookback extreme rejection passed watch or alert thresholds",
    watch: null,
    signal: null,
  };
}

function fragilitySnapshot(): MarketFragilitySnapshot {
  return {
    level: "breaking",
    score: 60,
    stressedIndicatorCount: 3,
    availableIndicatorCount: 6,
    totalIndicatorCount: 6,
    dataQuality: "full",
    expandedEquityBreadth: {
      source: "hyperliquid_xyz_stock_perps",
      assetCount: 40,
      declinerCount: 28,
      declinerRatio: 0.7,
      declineThreshold: -0.005,
    },
    indicators: [
      indicator("session_loss", "stressed", "-1.20%"),
      indicator("vwap_repair_failure", "stressed", "-0.45 ATR"),
      indicator("poor_close_location", "stressed", "10%"),
      indicator("downside_tail_cluster", "healthy", "1/12 <= -0.50%"),
      indicator("mega_cap_breadth", "healthy", "43% (7 assets)"),
      indicator(
        "equity_cross_confirmation",
        "healthy",
        "SP500 -0.40% / XYZ100 -0.30%",
      ),
    ],
  };
}

function indicator(
  id: MarketFragilitySnapshot["indicators"][number]["id"],
  state: MarketFragilitySnapshot["indicators"][number]["state"],
  displayValue: string,
): MarketFragilitySnapshot["indicators"][number] {
  return {
    id,
    state,
    value: state === "unavailable" ? null : 1,
    displayValue,
    threshold: "test threshold",
  };
}
