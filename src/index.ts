import { loadConfig } from "./config";
import { publicScanResult } from "./discord";
import { handleDiscordInteraction } from "./discord-interactions";
import { dispatchManualScan, dispatchScheduledScan } from "./scan-dispatch";
import type { Env } from "./types";

export { ScanCoordinator } from "./scan-coordinator";

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    context: ExecutionContext,
  ): Promise<void> {
    context.waitUntil(dispatchScheduledScan(env, controller.scheduledTime));
  },

  async fetch(
    request: Request,
    env: Env,
    context: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname === "/discord/interactions"
    ) {
      const config = loadConfig(env);
      return handleDiscordInteraction(request, {
        publicKey: env.DISCORD_APPLICATION_PUBLIC_KEY,
        allowedGuildId: env.DISCORD_GUILD_ID,
        language: config.language,
        getStatus: () => dispatchManualScan(env),
        waitUntil: (promise) => context.waitUntil(promise),
      });
    }
    if (request.method !== "GET" || url.pathname !== "/scan") {
      return Response.json(
        {
          service: "hyperliquid-sp500-reversal-scanner",
          endpoint: "GET /scan",
          execution: "read-only alerts; no order placement",
        },
        { status: 200 },
      );
    }
    if (
      env.MANUAL_SCAN_TOKEN === undefined ||
      request.headers.get("Authorization") !==
        `Bearer ${env.MANUAL_SCAN_TOKEN}`
    ) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    try {
      const config = loadConfig(env);
      const execution = await dispatchManualScan(env);
      return Response.json(
        publicScanResult(
          execution.scan,
          config.language,
          execution.fragility ?? undefined,
          execution.activity ?? undefined,
          execution.dataHealth,
        ),
      );
    } catch (error) {
      console.error(
        "manual scan failed",
        error instanceof Error ? error.name : "UnknownError",
      );
      return Response.json({ error: "scan failed" }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
