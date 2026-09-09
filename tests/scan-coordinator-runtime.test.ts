import {
  Log,
  LogLevel,
  Miniflare,
  Request as RuntimeRequest,
  Response as RuntimeResponse,
} from "miniflare";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const executeFile = promisify(execFile);
const webhookPath = "/api/webhooks/example/token";
let directory: string;
let script: string;
let runtime: Miniflare | undefined;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ondo-coordinator-test-"));
  // Build the actual deployment config without loading local runtime secrets.
  const config = (await readFile("wrangler.toml", "utf8")).replace(
    'main = "src/index.ts"',
    `main = ${JSON.stringify(resolve("src/index.ts"))}`,
  );
  const configPath = join(directory, "wrangler.toml");
  await writeFile(configPath, config);
  await executeFile(
    process.execPath,
    [
      resolve("node_modules/wrangler/bin/wrangler.js"),
      "deploy",
      "--dry-run",
      "--config",
      configPath,
      "--outdir",
      directory,
    ],
    {
      cwd: directory,
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH: join(directory, "wrangler.log"),
      },
    },
  );
  script = await readFile(join(directory, "index.js"), "utf8");
}, 30_000);

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
});

afterAll(async () => {
  if (directory !== undefined) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("ScanCoordinator in workerd", { timeout: 15_000 }, () => {
  it("routes public manual scans and preserves HTTP failures", async () => {
    const fixture = await startRuntime();
    const unauthorized = await runtime!.dispatchFetch(
      "https://scanner.example/scan",
    );
    expect(unauthorized.status).toBe(404);
    expect(fixture.requests).toHaveLength(0);

    const options = {
      headers: { Authorization: "Bearer example-manual-token" },
    };
    const response = await runtime!.dispatchFetch(
      "https://scanner.example/scan",
      options,
    );
    expect(response.status).toBe(200);
    expect(fixture.requests).toEqual([
      "candleSnapshot",
      "perpCategories",
      "metaAndAssetCtxs",
    ]);

    fixture.rateLimitCandles = true;
    const failed = await runtime!.dispatchFetch(
      "https://scanner.example/scan",
      options,
    );
    expect(failed.status).toBe(502);
    await expect(failed.json()).resolves.toEqual({ error: "scan failed" });
    expect(fixture.requests).toHaveLength(4);
  });

  it("preserves cadence, single-attempt 429 and recovery", async () => {
    const fixture = await startRuntime();
    const namespace =
      await runtime!.getDurableObjectNamespace("SCAN_COORDINATOR");
    const coordinator = namespace.get(namespace.idFromName("scanner"));
    const scheduled = (time: string) =>
      coordinator.fetch("https://scanner.internal/scheduled", {
        method: "POST",
        body: JSON.stringify({ scheduledTime: Date.parse(time) }),
      });

    expect((await scheduled("2026-07-23T15:35:39Z")).status).toBe(204);
    expect(fixture.requests).toHaveLength(0);
    fixture.rateLimitCandles = true;
    expect((await scheduled("2026-07-23T15:45:39Z")).status).toBe(204);
    expect(fixture.requests).toEqual(["candleSnapshot"]);
    expect(fixture.notices).toHaveLength(1);
    expect((await scheduled("2026-07-23T15:45:39Z")).status).toBe(204);
    expect(fixture.requests).toHaveLength(1);

    fixture.rateLimitCandles = false;
    expect((await scheduled("2026-07-23T16:00:39Z")).status).toBe(204);
    expect(fixture.requests).toEqual([
      "candleSnapshot",
      "candleSnapshot",
      "perpCategories",
      "metaAndAssetCtxs",
    ]);
    const state = await runtime!.getKVNamespace("SCANNER_STATE");
    expect(await state.get("rate-limit-incident:xyz:SP500")).toBeNull();
    expect(await state.get("last-successful-candle:xyz:SP500")).toBe(
      String(Date.parse("2026-07-23T15:59:59.999Z")),
    );
    expect(fixture.notices).toHaveLength(2);
  });

  it("shares a native in-flight query while queueing scheduled work", async () => {
    const fixture = await startRuntime();
    const gate = Promise.withResolvers<void>();
    fixture.candleGate = gate.promise;
    const namespace =
      await runtime!.getDurableObjectNamespace("SCAN_COORDINATOR");
    const coordinator = namespace.get(namespace.idFromName("scanner"));
    const first = coordinator.fetch("https://scanner.internal/status", {
      method: "POST",
    });
    await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
    const second = coordinator.fetch("https://scanner.internal/status", {
      method: "POST",
    });
    const scheduled = coordinator.fetch("https://scanner.internal/scheduled", {
      method: "POST",
      body: JSON.stringify({
        scheduledTime: Date.parse("2026-07-23T15:45:39Z"),
      }),
    });
    // Let workerd receive both requests while the first source request is held.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fixture.requests).toEqual(["candleSnapshot"]);
    gate.resolve();
    const responses = await Promise.all([first, second, scheduled]);
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 204,
    ]);
    expect(fixture.requests).toEqual([
      "candleSnapshot",
      "perpCategories",
      "metaAndAssetCtxs",
      "candleSnapshot",
    ]);
  });
});

async function startRuntime() {
  const fixture = {
    requests: [] as string[],
    notices: [] as string[],
    rateLimitCandles: false,
    candleGate: undefined as Promise<void> | undefined,
  };
  runtime = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-06-23",
    log: new Log(LogLevel.ERROR),
    // Intercept every external request; unexpected destinations fail locally.
    outboundService: async (request: RuntimeRequest) => {
      const url = new URL(request.url);
      if (
        url.origin === "https://api.hyperliquid.xyz" &&
        url.pathname === "/info"
      ) {
        const body = (await request.json()) as { type: string };
        fixture.requests.push(body.type);
        if (body.type === "candleSnapshot") {
          await fixture.candleGate;
        }
        const status =
          fixture.rateLimitCandles && body.type === "candleSnapshot"
            ? 429
            : 200;
        const data =
          body.type === "candleSnapshot"
            ? syntheticCandles()
            : body.type === "metaAndAssetCtxs"
              ? [{ universe: [] }, []]
              : [];
        return RuntimeResponse.json(data, { status });
      }
      if (
        url.origin === "https://discord.com" &&
        url.pathname === webhookPath
      ) {
        fixture.notices.push(await request.text());
        return new RuntimeResponse(null, { status: 204 });
      }
      throw new Error("unexpected outbound request in runtime test");
    },
    durableObjects: {
      SCAN_COORDINATOR: { className: "ScanCoordinator", useSQLite: true },
    },
    kvNamespaces: ["SCANNER_STATE"],
    bindings: {
      SCAN_EXECUTION_MODE: "durable-object",
      DISCORD_WEBHOOK_URL: `https://example.com${webhookPath}`,
      MANUAL_SCAN_TOKEN: "example-manual-token",
      MARKET_ACTIVITY_MODE: "off",
    },
  });
  const state = await runtime.getKVNamespace("SCANNER_STATE");
  await state.put("last-version-notice", "local-dev");
  return fixture;
}

function syntheticCandles(): Array<Record<string, number | string>> {
  return Array.from({ length: 12 }, (_, index) => {
    const start = Date.parse("2026-07-23T15:00:00Z") + index * 300_000;
    return {
      t: start,
      T: start + 299_999,
      o: "100",
      h: "101",
      l: "99",
      c: "100",
      v: "100",
      n: 10,
    };
  });
}
