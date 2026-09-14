import { describe, expect, it } from "vitest";

import { analyzeMarketFragility } from "../src/market-fragility";
import {
  formatExpandedEquityBreadth,
  formatMarketFragilityIndicatorValue,
  formatMarketFragilityObservationWindow,
} from "../src/market-fragility-format";
import type { Candle, MarketAssetContext } from "../src/types";

describe("analyzeMarketFragility", () => {
  it("classifies a repairing market as resilient", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100.1, 100.2, 100.15, 100.3, 100.4, 100.5]),
      healthyContexts(),
      analysisOptions(),
    );

    expect(result.level).toBe("resilient");
    expect(result.score).toBe(0);
    expect(result.dataQuality).toBe("full");
    expect(result.stressedIndicatorCount).toBe(0);
  });

  it("uses breadth and cross-index confirmation for a fragile state", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100.1, 100.2, 100.15, 100.3, 100.4, 100.5]),
      stressedContexts(),
      analysisOptions(),
    );

    expect(result.level).toBe("fragile");
    expect(result.score).toBe(35);
    expect(stressedIds(result)).toEqual([
      "mega_cap_breadth",
      "equity_cross_confirmation",
    ]);
  });

  it("classifies three simultaneous repair failures as breaking", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 99, 98.5, 98, 98.3, 98.6, 98.9]),
      stressedContexts(),
      analysisOptions(),
    );

    expect(result.level).toBe("breaking");
    expect(result.score).toBe(60);
    expect(result.stressedIndicatorCount).toBe(3);
  });

  it("classifies clustered price failures and weak breadth as panic", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([
        100,
        99.95,
        99.9,
        99.45,
        99.4,
        99.35,
        98.9,
        98.85,
        98.8,
      ]),
      stressedContexts(),
      analysisOptions(),
    );

    expect(result.level).toBe("panic");
    expect(result.score).toBe(100);
    expect(result.stressedIndicatorCount).toBe(6);
  });

  it("reports unknown rather than guessing from insufficient data", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 99.9]),
      [],
      analysisOptions(),
    );

    expect(result.level).toBe("unknown");
    expect(result.score).toBeNull();
    expect(result.dataQuality).toBe("insufficient");
    expect(result.availableIndicatorCount).toBe(0);
    expect(result.indicators.map((indicator) => indicator.unavailableReason))
      .toEqual([
        "insufficient_price_candles",
        "insufficient_price_candles",
        "insufficient_price_candles",
        "insufficient_price_candles",
        "insufficient_asset_context",
        "missing_cross_asset_context",
      ]);
  });

  it("keeps a price-only result visible as partial data", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100.1, 100.2, 100.15, 100.3, 100.4, 100.5]),
      [],
      analysisOptions(),
    );

    expect(result.level).toBe("resilient");
    expect(result.dataQuality).toBe("partial");
    expect(result.availableIndicatorCount).toBe(4);
  });

  it("adds expanded stock-perp breadth without changing the classifier", () => {
    const stockCoins = Array.from(
      { length: 12 },
      (_, index) => `xyz:STOCK${index}`,
    );
    const contexts = [
      ...healthyContexts(),
      ...stockCoins.map((coin, index) => ({
        coin,
        markPrice: index < 9 ? 99 : 101,
        oraclePrice: index < 9 ? 99 : 101,
        previousDayPrice: 100,
        referencePriceType: "hyperliquid_prev_day_px" as const,
        fetchedAt: Date.parse("2026-07-31T14:04:58.000Z"),
        providerTimestamp: null,
        fundingRate: 0,
        premium: 0,
        dayNotionalVolume: 1_000_000,
      })),
    ];

    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100.1, 100.2, 100.15, 100.3, 100.4, 100.5]),
      contexts,
      analysisOptions(stockCoins),
    );

    expect(result.level).toBe("resilient");
    expect(result.stressedIndicatorCount).toBe(0);
    expect(result.availableIndicatorCount).toBe(6);
    expect(result.expandedEquityBreadth).toEqual({
      source: "hyperliquid_xyz_stock_perps",
      assetCount: 12,
      declinerCount: 9,
      declinerRatio: 0.75,
      declineThreshold: -0.005,
    });
    expect(
      formatExpandedEquityBreadth(result.expandedEquityBreadth!, "en"),
    ).toBe(
      "75% down at least 0.5% (9/12) · vs Hyperliquid prevDayPx · " +
        "xyz stock-perp proxy · context only",
    );
    expect(
      formatExpandedEquityBreadth(result.expandedEquityBreadth!, "zh"),
    ).toBe(
      "75% 跌幅至少 0.5%（9/12） · 相對 Hyperliquid prevDayPx · " +
        "xyz 股票永續合約代理 · 僅供背景參考",
    );
  });

  it("omits expanded breadth when fewer than ten stock perps are valid", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100.1, 100.2, 100.15, 100.3, 100.4, 100.5]),
      healthyContexts(),
      analysisOptions(["xyz:AAPL", "xyz:MSFT"]),
    );

    expect(result.expandedEquityBreadth).toBeUndefined();
  });

  it("records observation timing and labels undocumented context basis", () => {
    const candles = candlesFromCloses([
      100,
      99.8,
      99.6,
      99.4,
      99.2,
      99,
    ]);
    const result = analyzeMarketFragility(
      candles,
      stressedContexts(),
      analysisOptions(),
    );

    expect(result.observationWindow).toEqual({
      candleEndTime: candles.at(-1)?.endTime,
      contextFetchedAt: Date.parse("2026-07-31T14:04:58.000Z"),
      evaluatedAt: Date.parse("2026-07-31T14:05:00.000Z"),
      sessionScope: "rth",
      contextReferencePriceType: "hyperliquid_prev_day_px",
      contextProviderTimestamp: null,
    });
    expect(
      formatMarketFragilityObservationWindow(result, "en"),
    ).toContain(
      "Context: Hyperliquid prevDayPx · fetched 2s before evaluation",
    );
    expect(
      formatMarketFragilityIndicatorValue(
        result.indicators[0]!,
        result,
        "en",
      ),
    ).toContain("vs RTH analysis-session open");
    expect(
      formatMarketFragilityIndicatorValue(
        result.indicators[4]!,
        result,
        "en",
      ),
    ).toContain("vs Hyperliquid prevDayPx");
  });

  it("shows price-only scope without inventing context timestamps", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100, 100, 100, 100, 100]),
      [],
      {
        evaluatedAt: Date.parse("2026-12-25T15:00:00.000Z"),
        sessionScope: "overnight",
      },
    );

    expect(result.observationWindow.contextFetchedAt).toBeNull();
    expect(result.observationWindow.contextProviderTimestamp).toBeNull();
    expect(
      formatMarketFragilityObservationWindow(result, "en"),
    ).toContain("OVERNIGHT");
    expect(
      formatMarketFragilityObservationWindow(result, "en"),
    ).toContain("Context unavailable · price-only coverage");
  });

  it("withholds a partial provider timestamp from mixed contexts", () => {
    const contexts = healthyContexts();
    contexts[0] = {
      ...contexts[0]!,
      providerTimestamp: Date.parse("2026-07-31T14:04:57.000Z"),
    };

    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100, 100, 100, 100, 100]),
      contexts,
      analysisOptions(),
    );

    expect(result.observationWindow.contextProviderTimestamp).toBeNull();
  });

  it("keeps a gap-up selloff separate from prevDayPx context returns", () => {
    const candles = candlesFromCloses([104, 103, 102, 101, 100, 99]);
    candles[0]!.open = 105;
    const result = analyzeMarketFragility(
      candles,
      healthyContexts(),
      analysisOptions(),
    );

    expect(result.indicators[0]).toMatchObject({
      state: "stressed",
      referenceType: "analysis_session_open",
    });
    expect(result.indicators[4]).toMatchObject({
      state: "healthy",
      referenceType: "hyperliquid_prev_day_px",
    });
  });

  it("keeps a gap-down rebound separate from prevDayPx context returns", () => {
    const candles = candlesFromCloses([96, 97, 98, 99, 100, 101]);
    candles[0]!.open = 95;
    const result = analyzeMarketFragility(
      candles,
      stressedContexts(),
      analysisOptions(),
    );

    expect(result.indicators[0]?.state).toBe("healthy");
    expect(result.indicators[4]?.state).toBe("stressed");
    expect(result.indicators[5]?.state).toBe("stressed");
  });

  it("shows stale context receipt age without inventing provider time", () => {
    const contexts = healthyContexts().map((context) => ({
      ...context,
      fetchedAt: Date.parse("2026-07-31T13:55:00.000Z"),
    }));
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100, 100, 100, 100, 100]),
      contexts,
      analysisOptions(),
    );

    const formatted = formatMarketFragilityObservationWindow(result, "en");
    expect(formatted).toContain("fetched 10m before evaluation");
    expect(formatted).toContain("provider timestamp unavailable");
  });

  it("labels the current VWAP comparison rather than implying history", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100, 100, 99, 98, 97]),
      [],
      analysisOptions(),
    );
    const vwapIndicator = result.indicators[1]!;

    expect(vwapIndicator.referenceType).toBe("latest_session_vwap");
    expect(
      formatMarketFragilityIndicatorValue(vwapIndicator, result, "en"),
    ).toContain("vs latest session VWAP");
  });

  it("keeps tiny-range quiet trading as low observed pressure", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([
        100,
        100.001,
        100,
        99.999,
        100,
        100.001,
      ]),
      healthyContexts(),
      analysisOptions(),
    );

    expect(result.level).toBe("resilient");
    expect(result.score).toBe(0);
    expect(result.stressedIndicatorCount).toBe(0);
  });
});

function candlesFromCloses(closes: readonly number[]): Candle[] {
  const startTime = Date.parse("2026-07-31T13:30:00.000Z");
  return closes.map((close, index) => {
    const open = index === 0 ? close : (closes[index - 1] ?? close);
    return {
      startTime: startTime + index * 300_000,
      endTime: startTime + index * 300_000 + 299_999,
      open,
      high: Math.max(open, close) + 0.05,
      low: Math.min(open, close) - 0.05,
      close,
      volume: 100,
      tradeCount: 10,
    };
  });
}

function healthyContexts(): MarketAssetContext[] {
  return contextsWithReturn(0.01);
}

function stressedContexts(): MarketAssetContext[] {
  return contextsWithReturn(-0.01);
}

function contextsWithReturn(assetReturn: number): MarketAssetContext[] {
  return [
    "xyz:SP500",
    "xyz:XYZ100",
    "xyz:AAPL",
    "xyz:MSFT",
    "xyz:NVDA",
    "xyz:AMZN",
    "xyz:GOOGL",
    "xyz:META",
    "xyz:TSLA",
  ].map((coin) => ({
    coin,
    markPrice: 100 * (1 + assetReturn),
    oraclePrice: 100 * (1 + assetReturn),
    previousDayPrice: 100,
    referencePriceType: "hyperliquid_prev_day_px",
    fetchedAt: Date.parse("2026-07-31T14:04:58.000Z"),
    providerTimestamp: null,
    fundingRate: 0,
    premium: 0,
    dayNotionalVolume: 1_000_000,
  }));
}

function analysisOptions(
  expandedEquityCoins: readonly string[] = [],
): {
  evaluatedAt: number;
  sessionScope: "rth";
  expandedEquityCoins: readonly string[];
} {
  return {
    evaluatedAt: Date.parse("2026-07-31T14:05:00.000Z"),
    sessionScope: "rth",
    expandedEquityCoins,
  };
}

function stressedIds(
  result: ReturnType<typeof analyzeMarketFragility>,
): string[] {
  return result.indicators
    .filter((indicator) => indicator.state === "stressed")
    .map((indicator) => indicator.id);
}
