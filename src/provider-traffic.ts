import {
  fetchFifteenMinuteCandles,
  fetchFiveMinuteCandles,
  fetchXyzMarketContexts,
  fetchXyzStockCoins,
  HyperliquidAdmissionError,
  type HyperliquidAccess,
  parseRetryAfterMs,
  type XyzStockCoinSelection,
} from "./hyperliquid";

const TRAFFIC_STATE_KEY = "hyperliquid-traffic:v1";
const CATEGORY_CACHE_KEY = "hyperliquid-categories:v1";
const TRAFFIC_STATE_VERSION = 1;
const CATEGORY_CACHE_VERSION = 1;
const ROLLING_WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;
const CATEGORY_REFRESH_MS = 24 * 60 * 60 * 1_000;
const CATEGORY_STALE_LIMIT_MS = 72 * 60 * 60 * 1_000;
const CATEGORY_FAILURE_BACKOFF_MS = 60 * 60 * 1_000;
const DEFAULT_INVOCATION_BUDGET_MS = 25_000;
const DEFAULT_WEIGHT_LIMIT = 240;
const BASE_INFO_WEIGHT = 20;
const CANDLES_PER_EXTRA_WEIGHT = 60;

interface TrafficReservation {
  reservedAt: number;
  estimatedWeight: number;
  operation: string;
}

interface ProviderTrafficState {
  version: typeof TRAFFIC_STATE_VERSION;
  blockedUntil: number;
  reservations: TrafficReservation[];
}

interface CategoryCacheState {
  version: typeof CATEGORY_CACHE_VERSION;
  coins: string[];
  fetchedAt: number | null;
  refreshAfter: number;
}

interface RequestEstimate {
  operation: "candle" | "market context" | "perp categories";
  estimatedWeight: number;
  estimateUncertain: boolean;
}

/**
 * Own persisted admission state for every Hyperliquid request made by one
 * named scan coordinator. Reservations are written before network I/O so a
 * lost response still consumes the local rolling-minute budget.
 */
export class ProviderTrafficController {
  private pendingRequest: Promise<unknown> = Promise.resolve();
  private volatileBlockedUntil = 0;

  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly fetcher: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
    private readonly weightLimit = DEFAULT_WEIGHT_LIMIT,
  ) {}

  /** Create one invocation-scoped client with a shared persisted budget. */
  createAccess(
    deadline = this.clock() + DEFAULT_INVOCATION_BUDGET_MS,
  ): HyperliquidAccess {
    let rateLimitedThisInvocation = false;
    const controlledFetch = (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (rateLimitedThisInvocation) {
        return Promise.reject(new HyperliquidAdmissionError("cooldown"));
      }
      const request = new Request(input, init);
      return this.exclusive(async () => {
        const response = await this.fetchAdmitted(
          request,
          deadline,
          input,
          init,
        );
        if (response.status === 429) {
          rateLimitedThisInvocation = true;
        }
        return response;
      });
    };

    return {
      fetchFiveMinuteCandles: (coin, now) =>
        fetchFiveMinuteCandles(coin, now, controlledFetch),
      fetchFifteenMinuteCandles: (coin, now, lookbackDays) =>
        fetchFifteenMinuteCandles(
          coin,
          now,
          lookbackDays,
          controlledFetch,
        ),
      fetchXyzMarketContexts: (coins) =>
        fetchXyzMarketContexts(coins, controlledFetch, this.clock),
      fetchXyzStockCoins: () => this.fetchStockCoins(controlledFetch),
    };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingRequest.then(operation);
    this.pendingRequest = result.catch(() => undefined);
    return result;
  }

  private async fetchAdmitted(
    request: Request,
    deadline: number,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const now = this.clock();
    if (now >= deadline) {
      throw new HyperliquidAdmissionError("deadline");
    }
    if (this.volatileBlockedUntil > now) {
      throw new HyperliquidAdmissionError("cooldown");
    }
    const estimate = await estimateRequest(request);
    let state: ProviderTrafficState;
    try {
      state = normalizeTrafficState(
        await this.storage.get<unknown>(TRAFFIC_STATE_KEY),
      );
    } catch {
      throw new HyperliquidAdmissionError("state_unavailable");
    }
    if (state.blockedUntil > now) {
      logAdmission({
        decision: "deny",
        reason: "cooldown",
        operation: estimate.operation,
        estimatedWeight: estimate.estimatedWeight,
        rollingWeight: rollingWeight(state.reservations, now),
        blockedUntil: state.blockedUntil,
        estimateUncertain: estimate.estimateUncertain,
      }, this.weightLimit);
      throw new HyperliquidAdmissionError("cooldown");
    }

    const reservations = activeReservations(state.reservations, now);
    const reservedWeight = rollingWeight(reservations, now);
    if (reservedWeight + estimate.estimatedWeight > this.weightLimit) {
      logAdmission({
        decision: "deny",
        reason: "budget",
        operation: estimate.operation,
        estimatedWeight: estimate.estimatedWeight,
        rollingWeight: reservedWeight,
        blockedUntil: state.blockedUntil,
        estimateUncertain: estimate.estimateUncertain,
      }, this.weightLimit);
      throw new HyperliquidAdmissionError("budget");
    }

    const wasCooldownProbe = state.blockedUntil > 0;
    const reservedState: ProviderTrafficState = {
      version: TRAFFIC_STATE_VERSION,
      blockedUntil: state.blockedUntil,
      reservations: [
        ...reservations,
        {
          reservedAt: now,
          estimatedWeight: estimate.estimatedWeight,
          operation: estimate.operation,
        },
      ],
    };
    try {
      await this.storage.put(TRAFFIC_STATE_KEY, reservedState);
    } catch {
      throw new HyperliquidAdmissionError("state_unavailable");
    }
    logAdmission({
      decision: "admit",
      reason: null,
      operation: estimate.operation,
      estimatedWeight: estimate.estimatedWeight,
      rollingWeight: reservedWeight + estimate.estimatedWeight,
      blockedUntil: state.blockedUntil,
      estimateUncertain: estimate.estimateUncertain,
    }, this.weightLimit);

    let response: Response;
    try {
      response = await this.fetcher(input, init);
    } catch (error) {
      if (wasCooldownProbe) {
        await this.persistCooldown(reservedState, now + DEFAULT_COOLDOWN_MS);
      }
      throw error;
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("Retry-After"),
        now,
      );
      await this.persistCooldown(
        reservedState,
        now + (retryAfterMs ?? DEFAULT_COOLDOWN_MS),
      );
    } else if (wasCooldownProbe && !response.ok) {
      await this.persistCooldown(reservedState, now + DEFAULT_COOLDOWN_MS);
    } else if (wasCooldownProbe && response.ok) {
      await this.persistCooldown(reservedState, 0);
    }
    await logReconciliation(response, estimate);
    return response;
  }

  private async persistCooldown(
    state: ProviderTrafficState,
    blockedUntil: number,
  ): Promise<void> {
    this.volatileBlockedUntil = blockedUntil;
    try {
      await this.storage.put(TRAFFIC_STATE_KEY, { ...state, blockedUntil });
    } catch {
      // The request was already attempted. Fail closed on the next admission
      // if storage remains unavailable rather than hiding the provider result.
      console.warn(JSON.stringify({
        status: "hyperliquid_cooldown_persistence_failed",
        blockedUntil,
      }));
    }
  }

  private async fetchStockCoins(
    controlledFetch: typeof fetch,
  ): Promise<XyzStockCoinSelection> {
    const now = this.clock();
    let cache: CategoryCacheState;
    try {
      cache = normalizeCategoryCache(
        await this.storage.get<unknown>(CATEGORY_CACHE_KEY),
      );
    } catch {
      throw new HyperliquidAdmissionError("state_unavailable");
    }
    const cacheAgeMs = cache.fetchedAt === null
      ? null
      : Math.max(0, now - cache.fetchedAt);
    if (
      cache.fetchedAt !== null &&
      cacheAgeMs !== null &&
      cacheAgeMs <= CATEGORY_REFRESH_MS
    ) {
      return categorySelection(cache, "cached", cacheAgeMs);
    }
    if (now < cache.refreshAfter) {
      return cacheAgeMs !== null && cacheAgeMs <= CATEGORY_STALE_LIMIT_MS
        ? categorySelection(cache, "stale", cacheAgeMs)
        : categorySelection(cache, "unavailable", cacheAgeMs);
    }

    try {
      const coins = await fetchXyzStockCoins(controlledFetch);
      const refreshed: CategoryCacheState = {
        version: CATEGORY_CACHE_VERSION,
        coins,
        fetchedAt: now,
        refreshAfter: now + CATEGORY_REFRESH_MS,
      };
      await this.storage.put(CATEGORY_CACHE_KEY, refreshed);
      return categorySelection(refreshed, "refreshed", 0);
    } catch {
      try {
        await this.storage.put(CATEGORY_CACHE_KEY, {
          ...cache,
          refreshAfter: now + CATEGORY_FAILURE_BACKOFF_MS,
        });
      } catch {
        throw new HyperliquidAdmissionError("state_unavailable");
      }
      if (cacheAgeMs !== null && cacheAgeMs <= CATEGORY_STALE_LIMIT_MS) {
        return categorySelection(cache, "stale", cacheAgeMs);
      }
      return categorySelection(cache, "unavailable", cacheAgeMs);
    }
  }
}

function categorySelection(
  cache: CategoryCacheState,
  cacheStatus: XyzStockCoinSelection["cacheStatus"],
  cacheAgeMs: number | null,
): XyzStockCoinSelection {
  return {
    coins: cacheStatus === "unavailable" ? [] : [...cache.coins],
    cacheStatus,
    cacheAgeMs,
  };
}

function normalizeTrafficState(value: unknown): ProviderTrafficState {
  if (value === undefined) {
    return {
      version: TRAFFIC_STATE_VERSION,
      blockedUntil: 0,
      reservations: [],
    };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== TRAFFIC_STATE_VERSION ||
    !("blockedUntil" in value) ||
    typeof value.blockedUntil !== "number" ||
    !Number.isFinite(value.blockedUntil) ||
    value.blockedUntil < 0 ||
    !("reservations" in value) ||
    !Array.isArray(value.reservations)
  ) {
    throw new Error("provider traffic state is invalid");
  }
  if (!value.reservations.every(
    (reservation): reservation is TrafficReservation =>
      typeof reservation === "object" &&
      reservation !== null &&
      "reservedAt" in reservation &&
      typeof reservation.reservedAt === "number" &&
      Number.isFinite(reservation.reservedAt) &&
      "estimatedWeight" in reservation &&
      typeof reservation.estimatedWeight === "number" &&
      Number.isFinite(reservation.estimatedWeight) &&
      reservation.estimatedWeight > 0 &&
      "operation" in reservation &&
      typeof reservation.operation === "string",
  )) {
    throw new Error("provider traffic reservations are invalid");
  }
  return {
    version: TRAFFIC_STATE_VERSION,
    blockedUntil: value.blockedUntil,
    reservations: value.reservations,
  };
}

function normalizeCategoryCache(value: unknown): CategoryCacheState {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== CATEGORY_CACHE_VERSION ||
    !("coins" in value) ||
    !Array.isArray(value.coins) ||
    !value.coins.every((coin) => typeof coin === "string") ||
    !("fetchedAt" in value) ||
    (value.fetchedAt !== null && typeof value.fetchedAt !== "number") ||
    !("refreshAfter" in value) ||
    typeof value.refreshAfter !== "number"
  ) {
    return {
      version: CATEGORY_CACHE_VERSION,
      coins: [],
      fetchedAt: null,
      refreshAfter: 0,
    };
  }
  return value as CategoryCacheState;
}

async function estimateRequest(request: Request): Promise<RequestEstimate> {
  const body: unknown = await request.clone().json();
  if (isCandleRequest(body)) {
    const intervalMs = body.req.interval === "5m" ? 300_000 : 900_000;
    const maximumCandles = Math.ceil(
      (body.req.endTime - body.req.startTime) / intervalMs,
    ) + 1;
    return {
      operation: "candle",
      estimatedWeight:
        BASE_INFO_WEIGHT + Math.ceil(maximumCandles / CANDLES_PER_EXTRA_WEIGHT),
      estimateUncertain: true,
    };
  }
  if (isInfoRequest(body, "metaAndAssetCtxs")) {
    return {
      operation: "market context",
      estimatedWeight: BASE_INFO_WEIGHT,
      estimateUncertain: false,
    };
  }
  return {
    operation: "perp categories",
    estimatedWeight: BASE_INFO_WEIGHT,
    estimateUncertain: true,
  };
}

function isCandleRequest(value: unknown): value is {
  type: "candleSnapshot";
  req: {
    interval: "5m" | "15m";
    startTime: number;
    endTime: number;
  };
} {
  if (!isInfoRequest(value, "candleSnapshot") || !("req" in value)) {
    return false;
  }
  const request = value.req;
  return typeof request === "object" && request !== null &&
    "interval" in request &&
    (request.interval === "5m" || request.interval === "15m") &&
    "startTime" in request && typeof request.startTime === "number" &&
    "endTime" in request && typeof request.endTime === "number";
}

function isInfoRequest(
  value: unknown,
  type: string,
): value is { type: string } {
  return typeof value === "object" && value !== null &&
    "type" in value && value.type === type;
}

function activeReservations(
  reservations: readonly TrafficReservation[],
  now: number,
): TrafficReservation[] {
  return reservations.filter(
    (reservation) =>
      reservation.reservedAt > now - ROLLING_WINDOW_MS &&
      reservation.reservedAt <= now,
  );
}

function rollingWeight(
  reservations: readonly TrafficReservation[],
  now: number,
): number {
  return activeReservations(reservations, now).reduce(
    (total, reservation) => total + reservation.estimatedWeight,
    0,
  );
}

async function logReconciliation(
  response: Response,
  estimate: RequestEstimate,
): Promise<void> {
  if (estimate.operation !== "candle" || !response.ok) {
    return;
  }
  let returnedCandles: number | null = null;
  try {
    const payload: unknown = await response.clone().json();
    returnedCandles = Array.isArray(payload) ? payload.length : null;
  } catch {
    // Parsing remains the caller's responsibility; this is diagnostic only.
  }
  const reconciledWeight = returnedCandles === null
    ? null
    : BASE_INFO_WEIGHT +
      Math.ceil(returnedCandles / CANDLES_PER_EXTRA_WEIGHT);
  console.log(JSON.stringify({
    status: "hyperliquid_request_reconciled",
    operation: estimate.operation,
    estimatedWeight: estimate.estimatedWeight,
    reconciledWeight,
    returnedCandles,
    estimateUncertain: estimate.estimateUncertain,
  }));
}

interface AdmissionLog {
  decision: "admit" | "deny";
  reason: "budget" | "cooldown" | null;
  operation: string;
  estimatedWeight: number;
  rollingWeight: number;
  blockedUntil: number;
  estimateUncertain: boolean;
}

function logAdmission(details: AdmissionLog, weightLimit: number): void {
  console.log(JSON.stringify({
    status: "hyperliquid_request_admission",
    localWeightLimit: weightLimit,
    rollingWindowMs: ROLLING_WINDOW_MS,
    ...details,
  }));
}
