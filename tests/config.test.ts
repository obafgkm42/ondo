import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  it("loads the default cadence", () => {
    const config = loadConfig({
      DISCORD_WEBHOOK_URL:
        "https://discord.com/api/webhooks/example/token",
    });

    expect(config.language).toBe("zh");
    expect(config.hyperliquidCoin).toBe("xyz:SP500");
    expect(config.regularScanMinutes).toBe(15);
    expect(config.finalHourScanMinutes).toBe(5);
    expect(config.briefIntervalMinutes).toBe(30);
    expect(config.fragilityPersistenceMode).toBe("off");
    expect(config.marketActivityMode).toBe("shadow");
    expect(config.resilienceDecayShadowMode).toBe("off");
    expect(config.minimumWatchPriceR).toBe(2);
    expect(config.minimumWatchConfidenceScore).toBe(64);
    expect(config.minimumPriceR).toBe(3.5);
    expect(config.minimumConfidenceScore).toBe(72);
    expect(config.workerVersionKey).toBe("local-dev");
    expect(config.workerVersionLabel).toBe("local-dev");
    expect(config.workerVersionUploadedAt).toBeNull();
  });

  it("uses Cloudflare metadata for the deploy key and readable version label", () => {
    const config = loadConfig({
      DISCORD_WEBHOOK_URL:
        "https://discord.com/api/webhooks/example/token",
      WORKER_VERSION: "manual-local-version",
      CF_VERSION_METADATA: {
        id: "1234567890abcdef",
        tag: "latest",
        timestamp: "2026-06-24T12:00:00.000Z",
      },
    });

    expect(config.workerVersionKey).toBe("cf-1234567890ab");
    expect(config.workerVersionLabel).toBe("2026.06.24.200000");
    expect(config.workerVersionUploadedAt?.toISOString()).toBe(
      "2026-06-24T12:00:00.000Z",
    );
  });

  it("rejects a missing Discord secret", () => {
    expect(() => loadConfig({ DISCORD_WEBHOOK_URL: "" })).toThrow(
      "DISCORD_WEBHOOK_URL",
    );
  });

  it("accepts English as the notification language", () => {
    const config = loadConfig({
      DISCORD_WEBHOOK_URL:
        "https://discord.com/api/webhooks/example/token",
      LANGUAGE: "EN",
    });

    expect(config.language).toBe("en");
  });

  it("rejects an unsupported language", () => {
    expect(() =>
      loadConfig({
        DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/example/token",
        LANGUAGE: "ja",
      })
    ).toThrow("LANGUAGE must be en or zh");
  });

  it("loads and validates the market activity rollout mode", () => {
    const config = loadConfig({
      DISCORD_WEBHOOK_URL:
        "https://discord.com/api/webhooks/example/token",
      MARKET_ACTIVITY_MODE: "DISPLAY",
    });

    expect(config.marketActivityMode).toBe("display");
    expect(() =>
      loadConfig({
        DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/example/token",
        MARKET_ACTIVITY_MODE: "alerts",
      })
    ).toThrow("MARKET_ACTIVITY_MODE");
  });

  it("loads and validates diagnostic shadow modes", () => {
    const config = loadConfig({
      DISCORD_WEBHOOK_URL:
        "https://discord.com/api/webhooks/example/token",
      FRAGILITY_PERSISTENCE_MODE: "SHADOW",
      RESILIENCE_DECAY_SHADOW_MODE: "shadow",
    });

    expect(config.fragilityPersistenceMode).toBe("shadow");
    expect(config.resilienceDecayShadowMode).toBe("shadow");
    expect(
      loadConfig({
        DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/example/token",
        FRAGILITY_PERSISTENCE_MODE: "display",
      }).fragilityPersistenceMode,
    ).toBe("display");
    expect(() =>
      loadConfig({
        DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/example/token",
        FRAGILITY_PERSISTENCE_MODE: "alerts",
      })
    ).toThrow("FRAGILITY_PERSISTENCE_MODE");
    expect(() =>
      loadConfig({
        DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/example/token",
        RESILIENCE_DECAY_SHADOW_MODE: "display",
      }),
    ).toThrow("RESILIENCE_DECAY_SHADOW_MODE");
  });

  it("supports the legacy fragility persistence alias without ambiguity", () => {
    expect(
      loadConfig({
        DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/example/token",
        FRAGILITY_V2_MODE: "shadow",
      }).fragilityPersistenceMode,
    ).toBe("shadow");
    expect(() =>
      loadConfig({
        DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/example/token",
        FRAGILITY_PERSISTENCE_MODE: "display",
        FRAGILITY_V2_MODE: "shadow",
      })
    ).toThrow("conflicts with legacy FRAGILITY_V2_MODE");
  });
});
