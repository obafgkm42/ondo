import { loadConfig } from "./config";
import { HyperliquidRateLimitError } from "./hyperliquid";
import {
  executeManualScan,
  executeScheduledScan,
  type ScanExecutionResult,
} from "./scan-service";
import type { Env } from "./types";

const COORDINATOR_NAME = "scanner";

/** Select the explicit rollout mode; missing configuration keeps legacy routing. */
export function getScanExecutionMode(
  env: Pick<Env, "SCAN_EXECUTION_MODE">,
): "direct" | "durable-object" {
  const mode = env.SCAN_EXECUTION_MODE?.trim().toLowerCase() || "direct";
  if (mode !== "direct" && mode !== "durable-object") {
    throw new Error("SCAN_EXECUTION_MODE must be direct or durable-object");
  }
  return mode;
}

/** Forward a Cron tick without changing the timestamp used by cadence gates. */
export async function dispatchScheduledScan(
  env: Env,
  scheduledTime: number,
): Promise<void> {
  if (getScanExecutionMode(env) === "direct") {
    await executeScheduledScan(loadConfig(env), new Date(scheduledTime));
    return;
  }
  const response = await getCoordinator(env).fetch(
    "https://scanner.internal/scheduled",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduledTime }),
    },
  );
  if (!response.ok) {
    // Retrying outside the object could duplicate work after a lost response.
    throw new Error("coordinated scheduled scan failed");
  }
}

/** Use the same authenticated manual-scan path for HTTP and Discord status. */
export async function dispatchManualScan(env: Env): Promise<ScanExecutionResult> {
  if (getScanExecutionMode(env) === "direct") {
    return executeManualScan(loadConfig(env), new Date());
  }
  const response = await getCoordinator(env).fetch(
    "https://scanner.internal/status",
    { method: "POST" },
  );
  if (response.status === 429) {
    // Preserve Discord's existing provider-specific degradation message.
    throw new HyperliquidRateLimitError(429, "candle");
  }
  if (!response.ok) {
    throw new Error("coordinated manual scan failed");
  }
  return response.json<ScanExecutionResult>();
}

function getCoordinator(env: Env): DurableObjectStub {
  if (env.SCAN_COORDINATOR === undefined) {
    throw new Error("SCAN_COORDINATOR binding is required in durable-object mode");
  }
  return env.SCAN_COORDINATOR.get(
    env.SCAN_COORDINATOR.idFromName(COORDINATOR_NAME),
  );
}
