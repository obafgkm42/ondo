import type { Candle, MarketAssetContext } from "./types";
import { normalizeHyperliquidCandles } from "./market-data";

const HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info";
const REQUEST_LOOKBACK_MS = 18 * 60 * 60 * 1_000;
const MAX_BOOTSTRAP_LOOKBACK_DAYS = 30;
const MAX_CANDLE_REQUEST_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const RATE_LIMIT_STATUS = 429;

interface HyperliquidPerpAsset {
  name: string;
  isDelisted?: boolean;
}

interface HyperliquidPerpMetadata {
  universe: HyperliquidPerpAsset[];
}

interface HyperliquidAssetContext {
  markPx: string;
  oraclePx: string;
  prevDayPx: string;
  funding: string;
  premium: string | null;
  dayNtlVlm: string;
}

type HyperliquidPerpCategory = [coin: string, category: string];

export class HyperliquidRateLimitError extends Error {
  constructor(status: number, operation = "info") {
    super(`Hyperliquid ${operation} request failed: ${status}`);
    this.name = "HyperliquidRateLimitError";
  }
}

/**
 * Fetch recent five-minute candles from Hyperliquid's public info endpoint.
 */
export async function fetchFiveMinuteCandles(
  coin: string,
  now: Date,
  fetcher: typeof fetch = fetch,
): Promise<Candle[]> {
  const endTime = now.getTime();
  return fetchCandles(
    coin,
    "5m",
    endTime - REQUEST_LOOKBACK_MS,
    endTime,
    fetcher,
  );
}

/**
 * Fetch a bounded fifteen-minute history for one post-close RVOL bootstrap.
 *
 * The caller controls retry cadence; this function caps the window so a bad
 * configuration cannot turn every attempt into a maximum-size candle parse.
 */
export async function fetchFifteenMinuteCandles(
  coin: string,
  now: Date,
  lookbackDays: number,
  fetcher: typeof fetch = fetch,
): Promise<Candle[]> {
  if (
    !Number.isInteger(lookbackDays) ||
    lookbackDays <= 0 ||
    lookbackDays > MAX_BOOTSTRAP_LOOKBACK_DAYS
  ) {
    throw new Error(
      `fifteen-minute candle lookback must be 1-${MAX_BOOTSTRAP_LOOKBACK_DAYS} days`,
    );
  }
  const endTime = now.getTime();
  return fetchCandles(
    coin,
    "15m",
    endTime - lookbackDays * 24 * 60 * 60 * 1_000,
    endTime,
    fetcher,
  );
}

async function fetchCandles(
  coin: string,
  interval: "5m" | "15m",
  startTime: number,
  endTime: number,
  fetcher: typeof fetch,
): Promise<Candle[]> {
  const response = await fetchCandlesWithRetry(
    coin,
    interval,
    startTime,
    endTime,
    fetcher,
  );
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Hyperliquid candle response is invalid");
  }
  const intervalMs = interval === "5m" ? 5 * 60_000 : 15 * 60_000;
  return normalizeHyperliquidCandles(
    payload,
    coin,
    intervalMs,
    new Date(endTime).toISOString(),
  ).filter(
    // Ignore the candle still forming at scan time.
    (candle) => candle.endTime < endTime,
  );
}

/**
 * Fetch a compact set of live XYZ market contexts with one public metadata
 * request. Missing or delisted requested assets are omitted from the result.
 */
export async function fetchXyzMarketContexts(
  coins: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<MarketAssetContext[]> {
  const response = await fetchInfoWithRetry(
    {
      type: "metaAndAssetCtxs",
      dex: "xyz",
    },
    "market context",
    fetcher,
  );
  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || payload.length !== 2) {
    throw new Error("Hyperliquid market context response is invalid");
  }
  const metadata = parsePerpMetadata(payload[0]);
  const contexts = payload[1];
  if (
    !Array.isArray(contexts) ||
    contexts.length !== metadata.universe.length
  ) {
    throw new Error("Hyperliquid market context arrays are misaligned");
  }
  const requestedCoins = new Set(coins);
  return metadata.universe.flatMap((asset, index) => {
    if (asset.isDelisted === true || !requestedCoins.has(asset.name)) {
      return [];
    }
    const context = parseAssetContext(asset.name, contexts[index]);
    return context === null ? [] : [context];
  });
}

/**
 * Fetch the official Hyperliquid category list for xyz stock perps.
 *
 * Category metadata is kept separate from price contexts so a caller can
 * fail open to the frozen mega-cap basket if classification is unavailable.
 * The subsequent market-context fetch removes delisted contracts.
 */
export async function fetchXyzStockCoins(
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const response = await fetchInfoWithRetry(
    { type: "perpCategories", dex: "xyz" },
    "perp categories",
    fetcher,
  );
  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || !payload.every(isPerpCategory)) {
    throw new Error("Hyperliquid perp categories response is invalid");
  }
  return payload
    .filter(
      ([coin, category]) =>
        coin.startsWith("xyz:") && category.toLowerCase() === "stocks",
    )
    .map(([coin]) => coin);
}

async function fetchCandlesWithRetry(
  coin: string,
  interval: "5m" | "15m",
  startTime: number,
  endTime: number,
  fetcher: typeof fetch,
): Promise<Response> {
  return fetchInfoWithRetry(
    {
      type: "candleSnapshot",
      req: {
        coin,
        interval,
        startTime,
        endTime,
      },
    },
    "candle",
    fetcher,
  );
}

async function fetchInfoWithRetry(
  body: object,
  operation: string,
  fetcher: typeof fetch,
): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_CANDLE_REQUEST_ATTEMPTS; attempt += 1) {
    const response = await fetcher(HYPERLIQUID_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) {
      return response;
    }
    lastStatus = response.status;
    if (!isTransientStatus(response.status)) {
      throw new Error(
        `Hyperliquid ${operation} request failed: ${response.status}`,
      );
    }
    if (attempt < MAX_CANDLE_REQUEST_ATTEMPTS) {
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
  }

  if (lastStatus === RATE_LIMIT_STATUS) {
    throw new HyperliquidRateLimitError(lastStatus, operation);
  }
  throw new Error(`Hyperliquid ${operation} request failed: ${lastStatus}`);
}

function parsePerpMetadata(value: unknown): HyperliquidPerpMetadata {
  if (typeof value !== "object" || value === null) {
    throw new Error("Hyperliquid market metadata is invalid");
  }
  const universe = (value as { universe?: unknown }).universe;
  if (!Array.isArray(universe) || !universe.every(isPerpAsset)) {
    throw new Error("Hyperliquid market universe is invalid");
  }
  return { universe };
}

function parseAssetContext(
  coin: string,
  value: unknown,
): MarketAssetContext | null {
  if (!isAssetContext(value)) {
    return null;
  }
  const premium = value.premium === null ? null : Number(value.premium);
  const context: MarketAssetContext = {
    coin,
    markPrice: Number(value.markPx),
    oraclePrice: Number(value.oraclePx),
    previousDayPrice: Number(value.prevDayPx),
    fundingRate: Number(value.funding),
    premium,
    dayNotionalVolume: Number(value.dayNtlVlm),
  };
  const numericValues = [
    context.markPrice,
    context.oraclePrice,
    context.previousDayPrice,
    context.fundingRate,
    context.dayNotionalVolume,
    ...(context.premium === null ? [] : [context.premium]),
  ];
  return numericValues.every(Number.isFinite) &&
    context.markPrice > 0 &&
    context.oraclePrice > 0 &&
    context.previousDayPrice > 0
    ? context
    : null;
}

function isPerpAsset(value: unknown): value is HyperliquidPerpAsset {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<HyperliquidPerpAsset>;
  return (
    typeof candidate.name === "string" &&
    (candidate.isDelisted === undefined ||
      typeof candidate.isDelisted === "boolean")
  );
}

function isAssetContext(value: unknown): value is HyperliquidAssetContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<HyperliquidAssetContext>;
  return (
    typeof candidate.markPx === "string" &&
    typeof candidate.oraclePx === "string" &&
    typeof candidate.prevDayPx === "string" &&
    typeof candidate.funding === "string" &&
    (typeof candidate.premium === "string" || candidate.premium === null) &&
    typeof candidate.dayNtlVlm === "string"
  );
}

function isPerpCategory(value: unknown): value is HyperliquidPerpCategory {
  return Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string";
}

function isTransientStatus(status: number): boolean {
  return status === RATE_LIMIT_STATUS || status >= 500;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
