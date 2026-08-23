import { describe, expect, it } from "vitest";

import {
  publicScanResult,
  sendMarketBrief,
  sendRateLimitNotice,
  sendSignal,
  sendVersionNotice,
} from "../src/discord";
import type { MarketFragilityPersistenceBrief } from "../src/market-fragility-shadow";
import type {
  MarketActivitySnapshot,
  MarketDataHealth,
  MarketFragilitySnapshot,
  ReversalLocation,
  ResilienceDecayMetrics,
  ScanResult,
} from "../src/types";

describe("sendMarketBrief", () => {
  it("adds RVOL to the push preview and detailed card without changing mentions", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 24,
      sessionHigh: 6100,
      sessionLow: 6075,
      latestPrice: 6090,
      status: "no fresh lookback extreme rejection passed watch or alert thresholds",
      watch: null,
      signal: null,
    };
    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-23T15:30:00.000Z"),
      fetcher as typeof fetch,
      undefined,
      "zh",
      undefined,
      undefined,
      activitySnapshot(),
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.content).toContain(
      "量能 ACTIVE（活躍）｜累積 1.31x｜15m 1.70x 明顯放量",
    );
    expect(payload.content.indexOf("量能 ACTIVE")).toBeLessThan(
      payload.content.indexOf("最新 6090.0"),
    );
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "市場活躍度",
          value: expect.stringContaining(
            "今日累積量：1.31x（相較過去同時刻均值）\n歷史位置：第 82 百分位（樣本：46 日）",
          ),
        }),
      ]),
    );
  });

  it("sends a Discord heartbeat when no signal is present", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6075,
      latestPrice: 6090,
      status: "no fresh lookback extreme rejection passed price-R and confidence thresholds",
      watch: null,
      signal: null,
    };

    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T00:30:00Z"),
      fetcher as typeof fetch,
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.content).toContain("SP500 半小時簡報");
    expect(payload.content).not.toContain("😌");
    expect(payload.content).toContain("最新 6090.0");
    expect(payload.content).toContain("日內 6075.0–6100.0");
    expect(payload.content).toContain("暫無合格訊號");
    expect(payload.embeds[0].title).toContain("半小時簡報");
    expect(payload.embeds[0].description).toContain("xyz:SP500 最新 6090.0");
    expect(payload.embeds[0].description).toContain("日內區間 6075.0–6100.0");
    expect(payload.embeds[0].description).toContain("暫無合格訊號");
    expect(payload.embeds[0].description).toContain(
      "沒有新的回看極值拒絕形態",
    );
    expect(payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "最新價格", value: "6090.0" }),
      ]),
    );
  });

  it("renders an English brief when configured", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6075,
      latestPrice: 6090,
      status: "no fresh lookback extreme rejection passed watch or alert thresholds",
      watch: null,
      signal: null,
    };

    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T00:30:00Z"),
      fetcher as typeof fetch,
      undefined,
      "en",
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.content).toContain("SP500 30-minute brief");
    expect(payload.content).toContain("No qualified signal");
    expect(payload.embeds[0].title).toBe(
      "SP500 Reversal Scanner 30-Minute Brief",
    );
    expect(payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Latest price", value: "6090.0" }),
      ]),
    );
  });

  it("attaches a chart image when one is available", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6075,
      latestPrice: 6090,
      status: "no fresh lookback extreme rejection passed price-R and confidence thresholds",
      watch: null,
      signal: null,
    };

    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T00:30:00Z"),
      fetcher as typeof fetch,
      {
        filename: "SP500-brief-chart.png",
        contentType: "image/png",
        bytes: new Uint8Array([137, 80, 78, 71]),
      },
    );

    const body = requests[0]?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    const payload = JSON.parse(String(form.get("payload_json")));
    expect(payload.content).toContain("最新 6090.0");
    expect(payload.content).toContain("暫無合格訊號");
    expect(payload.attachments[0].filename).toBe("SP500-brief-chart.png");
    expect(payload.embeds[0].image.url).toBe(
      "attachment://SP500-brief-chart.png",
    );
    expect(form.get("files[0]")).toBeInstanceOf(File);
  });

  it("puts the market fragility state in the push preview and embed", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6000,
      latestPrice: 6010,
      status: "no fresh lookback extreme rejection passed watch or alert thresholds",
      watch: null,
      signal: null,
    };
    const fragility = fragilitySnapshot();
    fragility.expandedEquityBreadth = {
      source: "hyperliquid_xyz_stock_perps",
      assetCount: 40,
      declinerCount: 28,
      declinerRatio: 0.7,
      declineThreshold: -0.005,
    };

    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T00:30:00Z"),
      fetcher as typeof fetch,
      undefined,
      "zh",
      fragility,
    );
    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T00:30:00Z"),
      fetcher as typeof fetch,
      undefined,
      "en",
      fragility,
    );

    const payload = JSON.parse(String(requests[0]?.body));
    const englishPayload = JSON.parse(String(requests[1]?.body));
    expect(payload.content).toMatch(/^@everyone /);
    expect(payload.content).toContain("市場狀態 BREAKING · 壓力 60/100");
    expect(payload.content).toContain("3/6 修復機制受壓");
    expect(payload.allowed_mentions).toEqual({ parse: ["everyone"] });
    expect(payload.embeds[0].title).toBe("SP500 市場狀態 · BREAKING");
    expect(payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "受壓修復機制",
          value: expect.stringContaining("VWAP 修復失敗"),
        }),
        expect.objectContaining({
          name: "資料覆蓋",
          value: "6/6 · 完整",
        }),
        expect.objectContaining({
          name: "擴展股票廣度",
          value: expect.stringContaining(
            "70% 跌幅至少 0.5%（28/40）",
          ),
        }),
      ]),
    );
    expect(englishPayload.content).toContain(
      "BREAKING · stress 60/100 · 3/6 repair mechanisms stressed",
    );
    expect(englishPayload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Expanded equity breadth",
          value: expect.stringContaining(
            "Hyperliquid xyz stock-perp proxy · context only",
          ),
        }),
      ]),
    );
  });

  it("labels a resilient zero score as zero stress", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6000,
      latestPrice: 6090,
      status: "no fresh lookback extreme rejection passed watch or alert thresholds",
      watch: null,
      signal: null,
    };
    const resilientSnapshot = {
      ...fragilitySnapshot(),
      level: "resilient" as const,
      score: 0,
      stressedIndicatorCount: 0,
    };

    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T00:30:00Z"),
      fetcher as typeof fetch,
      undefined,
      "zh",
      resilientSnapshot,
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.content).toContain(
      "市場狀態 RESILIENT · 壓力 0/100 · 0/6 修復機制受壓",
    );
    expect(payload.embeds[0].description).toContain(
      "RESILIENT · 壓力 0/100 · 0/6 個修復機制受壓",
    );
    expect(payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "市場韌性",
          value: "RESILIENT · 壓力 0/100 · 0/6 個修復機制受壓",
        }),
      ]),
    );
  });

  it("broadcasts panic but does not mention everyone below breaking", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6000,
      latestPrice: 6010,
      status: "no fresh lookback extreme rejection passed watch or alert thresholds",
      watch: null,
      signal: null,
    };

    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T01:00:00Z"),
      fetcher as typeof fetch,
      undefined,
      "zh",
      { ...fragilitySnapshot(), level: "panic", score: 80 },
    );
    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T01:30:00Z"),
      fetcher as typeof fetch,
      undefined,
      "zh",
      {
        ...fragilitySnapshot(),
        level: "fragile",
        score: 35,
        stressedIndicatorCount: 2,
      },
    );

    const panic = JSON.parse(String(requests[0]?.body));
    const fragile = JSON.parse(String(requests[1]?.body));
    expect(panic.content).toMatch(/^@everyone /);
    expect(panic.allowed_mentions).toEqual({ parse: ["everyone"] });
    expect(fragile.content).not.toContain("@everyone");
    expect(fragile.allowed_mentions).toEqual({ parse: [] });
  });

  it("withholds mentions and live decision fields when market data is stale", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6000,
      latestPrice: 6010,
      status: "alert-level modern reversal-zone setup found",
      watch: null,
      signal: opportunity("alert"),
    };
    const staleHealth: MarketDataHealth = {
      status: "stale",
      sessionScope: "rth",
      candleCount: 12,
      latestEndTime: Date.parse("2026-06-24T00:24:59.999Z"),
      expectedLatestEndTime: Date.parse("2026-06-24T00:29:59.999Z"),
      lagIntervals: 1,
      gapCount: 0,
      missingIntervals: 0,
      stateEligible: false,
      reasons: ["latest completed candle lags by 1 interval(s)"],
    };

    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T00:30:00Z"),
      fetcher as typeof fetch,
      undefined,
      "zh",
      { ...fragilitySnapshot(), level: "panic", score: 80 },
      fadingResilienceMetrics(),
      activitySnapshot(),
      confirmedFragilityPersistenceBrief(),
      staleHealth,
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.content).not.toContain("@everyone");
    expect(payload.content).toContain("資料 STALE · RTH");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].description).toContain(
      "市場資料不符合決策資格",
    );
    expect(payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "市場資料",
          value: expect.stringContaining("STALE · RTH · 不納入決策"),
        }),
      ]),
    );
    expect(payload.embeds[0].fields).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "同時偵測到機會" }),
        expect.objectContaining({ name: "市場活躍度" }),
        expect.objectContaining({ name: "BREAKING 持續性" }),
        expect.objectContaining({ name: "韌性衰退" }),
      ]),
    );
  });

  it("shows V2 confirmation metrics without changing v1 routing", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6000,
      latestPrice: 6010,
      status: "no fresh lookback extreme rejection passed watch or alert thresholds",
      watch: null,
      signal: null,
    };
    const fragile = {
      ...fragilitySnapshot(),
      level: "fragile" as const,
      score: 35,
      stressedIndicatorCount: 2,
    };

    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T01:30:00Z"),
      fetcher as typeof fetch,
      undefined,
      "zh",
      fragile,
      undefined,
      undefined,
      confirmedFragilityPersistenceBrief(),
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.content).not.toContain("@everyone");
    expect(payload.content).not.toContain("CONFIRMED");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "BREAKING 持續性",
          value: expect.stringContaining(
            "已確認 CONFIRMED · V1 BREAKING · 擴散惡化 ESCALATING\n持續：30 分鐘 · 2 次觀測",
          ),
        }),
      ]),
    );
  });

  it("shows FADING resilience on the detailed card without changing mentions", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6000,
      latestPrice: 6010,
      status: "no fresh lookback extreme rejection passed watch or alert thresholds",
      watch: null,
      signal: null,
    };

    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T00:30:00Z"),
      fetcher as typeof fetch,
      undefined,
      "zh",
      undefined,
      fadingResilienceMetrics(),
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.content).not.toContain("FADING");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "韌性衰退",
          value: "FADING · 復原 55.0/100 · 基準 75.0/100 · 衰退 Δ -20.0 · 衰退壓力 50.0/100",
        }),
      ]),
    );
  });

  it("does not add the FADING card field for a non-fading state", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6075,
      latestPrice: 6090,
      status: "no fresh lookback extreme rejection passed watch or alert thresholds",
      watch: null,
      signal: null,
    };

    await sendMarketBrief(
      "https://discord.com/api/webhooks/example/token",
      result,
      new Date("2026-06-24T00:30:00Z"),
      fetcher as typeof fetch,
      undefined,
      "en",
      undefined,
      { ...fadingResilienceMetrics(), status: "RESILIENT" },
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.embeds[0].fields).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Resilience decay" }),
      ]),
    );
  });
});

describe("sendSignal", () => {
  it("labels watch-level opportunities separately from alerts", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };

    await sendSignal(
      "https://discord.com/api/webhooks/example/token",
      opportunity("watch"),
      fetcher as typeof fetch,
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.embeds[0].title).toContain("WATCH");
    expect(payload.embeds[0].description).toContain("提早觀察級別");
    expect(payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "級別", value: "WATCH" }),
      ]),
    );
  });

  it("renders English signal copy and diagnostics when configured", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };

    await sendSignal(
      "https://discord.com/api/webhooks/example/token",
      opportunity("watch"),
      fetcher as typeof fetch,
      "en",
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.embeds[0].title).toContain(
      "Bottom reversal candidate zone",
    );
    expect(payload.embeds[0].description).toContain("Early WATCH level");
    expect(payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Level", value: "WATCH" }),
        expect.objectContaining({
          name: "Why it qualifies",
          value: "• fresh lookback low rejected",
        }),
      ]),
    );
  });

  it("shows arrival time and price separately from the signal price", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };

    await sendSignal(
      "https://discord.com/api/webhooks/example/token",
      opportunity("alert"),
      fetcher as typeof fetch,
      "en",
      {
        observedAt: Date.parse("2026-06-24T00:45:00Z"),
        observedPrice: 6091.5,
      },
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.embeds[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Delivered / current price",
          value: "2026-06-24T00:45:00.000Z / 6091.5",
        }),
      ]),
    );
  });
});

describe("sendVersionNotice", () => {
  it("sends the active worker version", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };

    await sendVersionNotice(
      "https://discord.com/api/webhooks/example/token",
      "2.1.0",
      new Date("2026-06-24T00:00:00Z"),
      fetcher as typeof fetch,
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.embeds[0].description).toContain("2.1.0");
    expect(payload.embeds[0].description).toContain("2026-06-24T00:00:00.000Z");
  });

  it("renders an English version notice when configured", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };

    await sendVersionNotice(
      "https://discord.com/api/webhooks/example/token",
      "2.1.0",
      new Date("2026-06-24T00:00:00Z"),
      fetcher as typeof fetch,
      "en",
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.embeds[0].title).toContain("updated");
    expect(payload.embeds[0].description).toContain(
      "Worker version `2.1.0` is active.",
    );
    expect(payload.embeds[0].fields[0].name).toBe("Reminder");
  });
});

describe("sendRateLimitNotice", () => {
  it("makes a skipped scan visible without claiming that no setup existed", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };

    await sendRateLimitNotice(
      "https://discord.com/api/webhooks/example/token",
      "xyz:SP500",
      new Date("2026-08-01T13:00:23Z"),
      fetcher as typeof fetch,
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.content).toContain("掃描未完成");
    expect(payload.content).toContain("下一個排程會自動重試");
    expect(payload.embeds[0].title).toContain("資料源限流");
    expect(payload.embeds[0].description).toContain(
      "這不代表當時沒有交易候選區",
    );
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("renders the degradation notice in English when configured", async () => {
    const requests: RequestInit[] = [];
    const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init ?? {});
      return new Response(null, { status: 204 });
    };

    await sendRateLimitNotice(
      "https://discord.com/api/webhooks/example/token",
      "xyz:SP500",
      new Date("2026-08-01T13:00:23Z"),
      fetcher as typeof fetch,
      "en",
    );

    const payload = JSON.parse(String(requests[0]?.body));
    expect(payload.content).toContain("scan incomplete");
    expect(payload.embeds[0].description).toContain(
      "This does not mean that no setup existed",
    );
  });
});

describe("publicScanResult", () => {
  it("localizes status text without changing machine-readable enums", () => {
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6075,
      latestPrice: 6090,
      status: "watch-level modern reversal-zone setup found; alert thresholds not yet met",
      watch: opportunity("watch"),
      signal: null,
    };

    const localized = publicScanResult(
      result,
      "zh",
      fragilitySnapshot(),
      activitySnapshot(),
    ) as {
      status: string;
      watch: { direction: string; policy: { reasons: string[] } };
      marketFragility: MarketFragilitySnapshot;
      marketActivity: MarketActivitySnapshot;
    };

    expect(localized.status).toContain("WATCH 級別");
    expect(localized.watch.direction).toBe("bullish");
    expect(localized.watch.policy.reasons[0]).toBe(
      "已通過現代反轉區市場狀態門檻",
    );
    expect(localized.marketFragility.level).toBe("breaking");
    expect(localized.marketActivity.level).toBe("ACTIVE");
  });

  it("withholds public opportunities and RVOL when inputs are ineligible", () => {
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: 12,
      sessionHigh: 6100,
      sessionLow: 6075,
      latestPrice: 6090,
      status: "alert-level modern reversal-zone setup found",
      watch: null,
      signal: opportunity("alert"),
    };
    const staleHealth: MarketDataHealth = {
      status: "stale",
      sessionScope: "rth",
      candleCount: 12,
      latestEndTime: Date.parse("2026-06-23T15:24:59.999Z"),
      expectedLatestEndTime: Date.parse("2026-06-23T15:29:59.999Z"),
      lagIntervals: 1,
      gapCount: 0,
      missingIntervals: 0,
      stateEligible: false,
      reasons: ["latest completed candle lags by 1 interval(s)"],
    };

    const publicResult = publicScanResult(
      result,
      "zh",
      fragilitySnapshot(),
      activitySnapshot(),
      staleHealth,
    ) as {
      status: string;
      signal: unknown;
      watch: unknown;
      marketActivity?: unknown;
      marketDataHealth: MarketDataHealth;
    };

    expect(publicResult.status).toContain("即時決策已停用");
    expect(publicResult.signal).toBeNull();
    expect(publicResult.watch).toBeNull();
    expect(publicResult).not.toHaveProperty("marketActivity");
    expect(publicResult.marketDataHealth.status).toBe("stale");
  });
});

function opportunity(level: "watch" | "alert"): ReversalLocation {
  return {
    level,
    direction: "bullish",
    market: "xyz:SP500",
    price: 6090,
    entryLow: 6088,
    entryHigh: 6092,
    invalidation: 6078,
    target: 6125,
    sessionHigh: 6130,
    sessionLow: 6075,
    vwap: 6110,
    priceRiskReward: 2.8,
    confidenceScore: 66,
    policy: {
      name: "modern_reversal_zone_v1",
      role: "bullish_reversal_zone",
      watchEligible: true,
      alertEligible: true,
      reasons: ["modern reversal-zone regime gate passed"],
    },
    reasons: ["fresh lookback low rejected"],
    timestamp: Date.parse("2026-06-24T00:30:00Z"),
  };
}

function activitySnapshot(): MarketActivitySnapshot {
  return {
    market: "xyz:SP500",
    sessionKey: "2026-06-23",
    level: "ACTIVE",
    sessionRvol: 1.31,
    barRvol: 1.7,
    barActivity: "elevated",
    percentile: 82,
    percentileBand: "high",
    sampleSessions: 46,
    confidence: "confirmed",
    dataQuality: "good",
    currentSlotIndex: 7,
    asOf: Date.parse("2026-06-23T15:30:00.000Z"),
    source: "hyperliquid",
  };
}

function fragilitySnapshot(): MarketFragilitySnapshot {
  return {
    level: "breaking",
    score: 60,
    stressedIndicatorCount: 3,
    availableIndicatorCount: 6,
    totalIndicatorCount: 6,
    dataQuality: "full",
    indicators: [
      {
        id: "session_loss",
        state: "stressed",
        value: -0.012,
        displayValue: "-1.20%",
        threshold: "<= -1.0%",
      },
      {
        id: "vwap_repair_failure",
        state: "stressed",
        value: -0.5,
        displayValue: "-0.50 ATR",
        threshold: "<= -0.35 ATR and 3 closes below VWAP",
      },
      {
        id: "poor_close_location",
        state: "stressed",
        value: 0.1,
        displayValue: "10%",
        threshold: "<= 25% of range",
      },
      {
        id: "downside_tail_cluster",
        state: "healthy",
        value: 1,
        displayValue: "1/11 <= -0.25%",
        threshold: ">= 2 volatility-adjusted large down returns",
      },
      {
        id: "mega_cap_breadth",
        state: "healthy",
        value: 0.3,
        displayValue: "30% (7 assets)",
        threshold: ">= 70% down at least 0.5%",
      },
      {
        id: "equity_cross_confirmation",
        state: "healthy",
        value: -0.004,
        displayValue: "SP500 -0.40% / XYZ100 -0.40%",
        threshold: "SP500 and XYZ100 both <= -0.75%",
      },
    ],
  };
}

function fadingResilienceMetrics(): ResilienceDecayMetrics {
  return {
    status: "FADING",
    recentResilience: 55,
    baselineResilience: 75,
    decayDelta: -20,
    recentEventScoreSlope: -5,
    decayScore: 50,
    scoredShockCount: 8,
    unscoredShockCount: 0,
    eventScores: [],
  };
}

function confirmedFragilityPersistenceBrief(): MarketFragilityPersistenceBrief {
  return {
    observation: {
      timestamp: Date.parse("2026-06-24T01:29:59.999Z"),
      price: 6010,
      v1Level: "breaking",
      stressedIndicatorCount: 3,
      availableIndicatorCount: 6,
      breakingStreak: 2,
      breakingStatus: "CONFIRMED",
      breakingStartedAt: Date.parse("2026-06-24T00:59:59.999Z"),
      breakingDurationMinutes: 30,
      transition: "ESCALATING",
      stressedIndicatorIds: [
        "session_loss",
        "vwap_repair_failure",
        "poor_close_location",
      ],
      persistentIndicatorIds: [
        "session_loss",
        "vwap_repair_failure",
      ],
      addedIndicatorIds: ["poor_close_location"],
      recoveredIndicatorIds: [],
      stressedFamilyIds: ["price_damage", "repair_failure"],
      mechanismHistoryAvailable: true,
    },
    metrics: {
      stateAvailable: true,
      retainedSessions: 20,
      retainedObservations: 180,
      pendingSessions: 10,
      confirmedSessions: 7,
      confirmationRate: 0.7,
    },
  };
}
