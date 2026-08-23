import type {
  DiagnosticShadowMode,
  Env,
  FragilityPersistenceMode,
  Language,
  MarketActivityMode,
  ScannerConfig,
} from "./types";

const DISCORD_WEBHOOK_PREFIX = "https://discord.com/api/webhooks/";

/**
 * Parse and validate Worker bindings without exposing secrets to clients.
 */
export function loadConfig(env: Env): ScannerConfig {
  const discordWebhookUrl = env.DISCORD_WEBHOOK_URL?.trim() ?? "";
  if (!discordWebhookUrl.startsWith(DISCORD_WEBHOOK_PREFIX)) {
    throw new Error("DISCORD_WEBHOOK_URL must be a Discord HTTPS webhook");
  }

  return {
    discordWebhookUrl,
    language: parseLanguage(env.LANGUAGE),
    hyperliquidCoin: env.HYPERLIQUID_COIN?.trim() || "xyz:SP500",
    regularScanMinutes: positiveInteger(
      env.REGULAR_SCAN_MINUTES,
      15,
      "REGULAR_SCAN_MINUTES",
    ),
    finalHourScanMinutes: positiveInteger(
      env.FINAL_HOUR_SCAN_MINUTES,
      5,
      "FINAL_HOUR_SCAN_MINUTES",
    ),
    briefIntervalMinutes: positiveInteger(
      env.BRIEF_INTERVAL_MINUTES,
      30,
      "BRIEF_INTERVAL_MINUTES",
    ),
    fragilityPersistenceMode: resolveFragilityPersistenceMode(env),
    marketActivityMode: parseMarketActivityMode(env.MARKET_ACTIVITY_MODE),
    resilienceDecayShadowMode: parseDiagnosticShadowMode(
      env.RESILIENCE_DECAY_SHADOW_MODE,
      "RESILIENCE_DECAY_SHADOW_MODE",
    ),
    minimumWatchPriceR: positiveNumber(
      env.MINIMUM_WATCH_PRICE_R,
      2,
      "MINIMUM_WATCH_PRICE_R",
    ),
    minimumWatchConfidenceScore: boundedInteger(
      env.MINIMUM_WATCH_CONFIDENCE_SCORE,
      64,
      "MINIMUM_WATCH_CONFIDENCE_SCORE",
      0,
      100,
    ),
    minimumPriceR: positiveNumber(
      env.MINIMUM_PRICE_R,
      3.5,
      "MINIMUM_PRICE_R",
    ),
    minimumConfidenceScore: boundedInteger(
      env.MINIMUM_CONFIDENCE_SCORE,
      72,
      "MINIMUM_CONFIDENCE_SCORE",
      0,
      100,
    ),
    workerVersionKey: resolveWorkerVersionKey(env),
    workerVersionLabel: resolveWorkerVersionLabel(env),
    workerVersionUploadedAt: parseCloudflareVersionTimestamp(env),
    scannerState: env.SCANNER_STATE,
  };
}

function parseDiagnosticShadowMode(
  rawValue: string | undefined,
  name: string,
): DiagnosticShadowMode {
  const mode = rawValue?.trim().toLowerCase() || "off";
  if (mode !== "off" && mode !== "shadow") {
    throw new Error(`${name} must be off or shadow`);
  }
  return mode;
}

function resolveFragilityPersistenceMode(
  env: Env,
): FragilityPersistenceMode {
  const primary = env.FRAGILITY_PERSISTENCE_MODE?.trim();
  const legacy = env.FRAGILITY_V2_MODE?.trim();
  if (
    primary !== undefined &&
    legacy !== undefined &&
    primary.toLowerCase() !== legacy.toLowerCase()
  ) {
    throw new Error(
      "FRAGILITY_PERSISTENCE_MODE conflicts with legacy FRAGILITY_V2_MODE",
    );
  }
  return parseFragilityPersistenceMode(primary ?? legacy);
}

function parseFragilityPersistenceMode(
  rawValue: string | undefined,
): FragilityPersistenceMode {
  const mode = rawValue?.trim().toLowerCase() || "off";
  if (mode !== "off" && mode !== "shadow" && mode !== "display") {
    throw new Error(
      "FRAGILITY_PERSISTENCE_MODE must be off, shadow, or display",
    );
  }
  return mode;
}

function parseMarketActivityMode(
  rawValue: string | undefined,
): MarketActivityMode {
  const mode = rawValue?.trim().toLowerCase() || "shadow";
  if (mode !== "off" && mode !== "shadow" && mode !== "display") {
    throw new Error("MARKET_ACTIVITY_MODE must be off, shadow, or display");
  }
  return mode;
}

function parseLanguage(rawValue: string | undefined): Language {
  const language = rawValue?.trim().toLowerCase() || "zh";
  if (language !== "en" && language !== "zh") {
    throw new Error("LANGUAGE must be en or zh");
  }
  return language;
}

function resolveWorkerVersionKey(env: Env): string {
  const cloudflareVersionId = env.CF_VERSION_METADATA?.id.trim();
  if (cloudflareVersionId !== undefined && cloudflareVersionId.length > 0) {
    return `cf-${cloudflareVersionId.slice(0, 12)}`;
  }

  return env.WORKER_VERSION?.trim() || "local-dev";
}

function resolveWorkerVersionLabel(env: Env): string {
  const timestamp = parseCloudflareVersionTimestamp(env);
  if (timestamp !== null) {
    return timestampVersionLabel(timestamp);
  }

  return env.WORKER_VERSION?.trim() || "local-dev";
}

function parseCloudflareVersionTimestamp(env: Env): Date | null {
  const rawTimestamp = env.CF_VERSION_METADATA?.timestamp;
  if (rawTimestamp === undefined) {
    return null;
  }

  const timestamp = new Date(rawTimestamp);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function timestampVersionLabel(timestamp: Date): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(timestamp)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return [
    parts.year,
    parts.month,
    parts.day,
    `${parts.hour}${parts.minute}${parts.second}`,
  ].join(".");
}

function positiveInteger(
  rawValue: string | undefined,
  fallback: number,
  name: string,
): number {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveNumber(
  rawValue: string | undefined,
  fallback: number,
  name: string,
): number {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return value;
}

function boundedInteger(
  rawValue: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = rawValue === undefined ? fallback : Number(rawValue);
  if (
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
