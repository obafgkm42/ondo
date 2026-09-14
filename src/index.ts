import { loadConfig } from "./config";
import { publicScanResult } from "./discord";
import { handleDiscordInteraction } from "./discord-interactions";
import { dispatchManualScan, dispatchScheduledScan } from "./scan-dispatch";
import type { Env, RequestRateLimiter } from "./types";

export { ScanCoordinator } from "./scan-coordinator";

const NOT_FOUND_RESPONSE = { error: "not found" };

async function rateLimitAllows(
  limiter: RequestRateLimiter | undefined,
  key: string,
): Promise<boolean> {
  if (limiter === undefined) {
    return true;
  }
  try {
    return (await limiter.limit({ key })).success;
  } catch (error) {
    console.error(
      "request rate limit failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return false;
  }
}

function rateLimitedResponse(): Response {
  return Response.json(
    { error: "too many requests" },
    { status: 429, headers: { "Retry-After": "60" } },
  );
}

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
      if (!(await rateLimitAllows(
        env.DISCORD_INTERACTIONS_RATE_LIMITER,
        "discord-interactions",
      ))) {
        return rateLimitedResponse();
      }
      const config = loadConfig(env);
      return handleDiscordInteraction(request, {
        publicKey: env.DISCORD_APPLICATION_PUBLIC_KEY,
        allowedGuildId: env.DISCORD_GUILD_ID,
        language: config.language,
        getStatus: () => dispatchManualScan(env),
        waitUntil: (promise) => context.waitUntil(promise),
      });
    }
    if (request.method === "GET" && url.pathname === "/") {
      return Response.json({ status: "ok" });
    }
    if (request.method !== "GET" || url.pathname !== "/scan") {
      return Response.json(NOT_FOUND_RESPONSE, { status: 404 });
    }
    if (
      env.MANUAL_SCAN_TOKEN === undefined ||
      request.headers.get("Authorization") !==
        `Bearer ${env.MANUAL_SCAN_TOKEN}`
    ) {
      return Response.json(NOT_FOUND_RESPONSE, { status: 404 });
    }
    if (!(await rateLimitAllows(
      env.MANUAL_SCAN_RATE_LIMITER,
      "manual-scan",
    ))) {
      return rateLimitedResponse();
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
