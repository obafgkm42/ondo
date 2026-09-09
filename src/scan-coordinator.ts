import { loadConfig } from "./config";
import { HyperliquidRateLimitError } from "./hyperliquid";
import {
  executeManualScan,
  executeScheduledScan,
  type ScanExecutionResult,
} from "./scan-service";
import type { Env } from "./types";

const LAST_SCHEDULED_TIME_KEY = "last-scheduled-time";

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

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

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
        await this.enqueue(() => this.runScheduled(payload.scheduledTime));
        return new Response(null, { status: 204 });
      }

      // Share only an in-flight manual query, never a stale cached result.
      if (this.pendingStatus === null) {
        this.pendingStatus = this.enqueue(() =>
          executeManualScan(loadConfig(this.env), new Date())
        ).finally(() => {
          this.pendingStatus = null;
        });
      }
      return Response.json(await this.pendingStatus);
    } catch (error) {
      const rateLimited = error instanceof HyperliquidRateLimitError;
      console.warn(JSON.stringify({
        status: "scan_coordinator_failed",
        trigger: pathname === "/scheduled" ? "scheduled" : "manual",
        reason: error instanceof Error ? error.name : "UnknownError",
      }));
      return Response.json(
        { error: rateLimited ? "hyperliquid_rate_limited" : "scan failed" },
        { status: rateLimited ? 429 : 502 },
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
    await executeScheduledScan(loadConfig(this.env), new Date(scheduledTime));
    // Persist after completion, including a gracefully handled provider 429.
    await this.state.storage.put(LAST_SCHEDULED_TIME_KEY, scheduledTime);
  }
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
