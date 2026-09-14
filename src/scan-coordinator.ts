import { loadConfig } from "./config";
import {
  HyperliquidAdmissionError,
  HyperliquidRateLimitError,
} from "./hyperliquid";
import { ProviderTrafficController } from "./provider-traffic";
import {
  executeManualScan,
  executeScheduledScan,
  type ScanExecutionResult,
} from "./scan-service";
import type { Env } from "./types";

const LAST_SCHEDULED_TIME_KEY = "last-scheduled-time";
const MANUAL_CACHE_KEY = "manual-scan-cache:v1";
const MANUAL_REFRESH_INTERVAL_MS = 60_000;

interface ManualScanCache {
  version: 1;
  refreshedAt: number;
  result: ScanExecutionResult;
}

/**
 * Serialize every scan for this Worker at one named Durable Object.
 *
 * Awaiting provider I/O permits another request to enter a Durable Object,
 * so the promise queue is necessary even though this is a single object.
 * Research history and notification receipts continue to use SCANNER_STATE.
 */
export class ScanCoordinator {
  private pendingExecution: Promise<unknown> = Promise.resolve();
  private pendingStatus: Promise<ScanExecutionResult> | null = null;
  private pendingScheduled: Promise<void> | null = null;
  private latestScheduledTime = -1;
  private readonly providerTraffic: ProviderTrafficController;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.providerTraffic = new ProviderTrafficController(
      state.storage,
      (input, init) => fetch(input, init),
      Date.now,
      loadConfig(env).hyperliquidWeightLimit,
    );
  }

  /** Accept internal requests only; authentication stays at the public Worker. */
  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      (pathname !== "/scheduled" && pathname !== "/status")
    ) {
      return new Response("not found", { status: 404 });
    }
    try {
      if (pathname === "/scheduled") {
        const payload: unknown = await request.json();
        if (!isScheduledRequest(payload)) {
          return Response.json({ error: "invalid scheduled time" }, { status: 400 });
        }
        this.latestScheduledTime = Math.max(
          this.latestScheduledTime,
          payload.scheduledTime,
        );
        if (this.pendingScheduled === null) {
          this.pendingScheduled = this.enqueue(() =>
            this.drainScheduled()
          ).finally(() => {
            this.pendingScheduled = null;
          });
        }
        await this.pendingScheduled;
        return new Response(null, { status: 204 });
      }

      // Coalesce in-flight work; runManual applies the bounded cache policy.
      if (this.pendingStatus === null) {
        this.pendingStatus = this.enqueue(() => this.runManual()).finally(() => {
          this.pendingStatus = null;
        });
      }
      return Response.json(await this.pendingStatus);
    } catch (error) {
      const rateLimited = error instanceof HyperliquidRateLimitError;
      const admissionDenied = error instanceof HyperliquidAdmissionError;
      console.warn(JSON.stringify({
        status: "scan_coordinator_failed",
        trigger: pathname === "/scheduled" ? "scheduled" : "manual",
        reason: error instanceof Error ? error.name : "UnknownError",
      }));
      return Response.json(
        {
          error: rateLimited
            ? "hyperliquid_rate_limited"
            : admissionDenied
              ? `hyperliquid_${error.reason}`
              : "scan failed",
          ...(admissionDenied
            ? {
                providerAccess: {
                  status: "unavailable",
                  asOf: null,
                  reason: error.reason,
                },
              }
            : {}),
        },
        { status: rateLimited ? 429 : admissionDenied ? 503 : 502 },
      );
    }
  }

  private enqueue<T>(execute: () => Promise<T>): Promise<T> {
    const result = this.pendingExecution.then(execute);
    // One failed scan must not poison the queue for all later ticks.
    this.pendingExecution = result.catch(() => undefined);
    return result;
  }

  private async runScheduled(scheduledTime: number): Promise<void> {
    const previous = await this.state.storage.get<number>(LAST_SCHEDULED_TIME_KEY);
    if (previous !== undefined && previous >= scheduledTime) {
      console.log(JSON.stringify({
        status: "scan_coordinator_duplicate_tick",
        scheduledTime: new Date(scheduledTime).toISOString(),
      }));
      return;
    }
    console.log(JSON.stringify({
      status: "scan_coordinator_scheduled",
      scheduledTime: new Date(scheduledTime).toISOString(),
    }));
    await executeScheduledScan(
      loadConfig(this.env),
      new Date(scheduledTime),
      this.providerTraffic.createAccess(),
    );
    // Persist after completion, including a gracefully handled provider 429.
    await this.state.storage.put(LAST_SCHEDULED_TIME_KEY, scheduledTime);
  }

  private async drainScheduled(): Promise<void> {
    while (true) {
      const scheduledTime = this.latestScheduledTime;
      await this.runScheduled(scheduledTime);
      if (scheduledTime === this.latestScheduledTime) {
        return;
      }
      console.log(JSON.stringify({
        status: "scan_coordinator_obsolete_ticks_discarded",
        nextScheduledTime: new Date(
          this.latestScheduledTime,
        ).toISOString(),
      }));
    }
  }

  private async runManual(): Promise<ScanExecutionResult> {
    let cached: ManualScanCache | null;
    try {
      cached = normalizeManualCache(
        await this.state.storage.get<unknown>(MANUAL_CACHE_KEY),
      );
    } catch {
      throw new HyperliquidAdmissionError("state_unavailable");
    }
    const now = Date.now();
    if (
      cached !== null &&
      now - cached.refreshedAt < MANUAL_REFRESH_INTERVAL_MS
    ) {
      return cachedResult(cached, "refresh_interval");
    }
    try {
      const result = await executeManualScan(
        loadConfig(this.env),
        new Date(now),
        this.providerTraffic.createAccess(),
      );
      const refreshedAt = Date.now();
      const fresh: ScanExecutionResult = {
        ...result,
        providerAccess: {
          status: "fresh",
          asOf: refreshedAt,
          reason: null,
        },
      };
      await this.state.storage.put(MANUAL_CACHE_KEY, {
        version: 1,
        refreshedAt,
        result: fresh,
      } satisfies ManualScanCache);
      return fresh;
    } catch (error) {
      if (
        cached !== null &&
        (error instanceof HyperliquidAdmissionError ||
          error instanceof HyperliquidRateLimitError)
      ) {
        return cachedResult(
          cached,
          error instanceof HyperliquidAdmissionError
            ? error.reason
            : "cooldown",
        );
      }
      throw error;
    }
  }
}

function normalizeManualCache(value: unknown): ManualScanCache | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    value.version !== 1 ||
    !("refreshedAt" in value) ||
    typeof value.refreshedAt !== "number" ||
    !("result" in value) ||
    typeof value.result !== "object" ||
    value.result === null
  ) {
    return null;
  }
  return value as ManualScanCache;
}

function cachedResult(
  cache: ManualScanCache,
  reason: NonNullable<
    ScanExecutionResult["providerAccess"]
  >["reason"],
): ScanExecutionResult {
  return {
    ...cache.result,
    providerAccess: {
      status: "cached",
      asOf: cache.refreshedAt,
      reason,
    },
  };
}

function isScheduledRequest(
  value: unknown,
): value is { scheduledTime: number } {
  return typeof value === "object" && value !== null &&
    "scheduledTime" in value &&
    typeof value.scheduledTime === "number" &&
    Number.isSafeInteger(value.scheduledTime) &&
    value.scheduledTime >= 0 &&
    !Number.isNaN(new Date(value.scheduledTime).getTime());
}
