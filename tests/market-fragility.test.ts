import { describe, expect, it } from "vitest";

import { analyzeMarketFragility } from "../src/market-fragility";
import { formatExpandedEquityBreadth } from "../src/market-fragility-format";
import type { Candle, MarketAssetContext } from "../src/types";

describe("analyzeMarketFragility", () => {
  it("classifies a repairing market as resilient", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100.1, 100.2, 100.15, 100.3, 100.4, 100.5]),
      healthyContexts(),
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
    );

    expect(result.level).toBe("panic");
    expect(result.score).toBe(100);
    expect(result.stressedIndicatorCount).toBe(6);
  });

  it("reports unknown rather than guessing from insufficient data", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 99.9]),
      [],
    );

    expect(result.level).toBe("unknown");
    expect(result.score).toBeNull();
    expect(result.dataQuality).toBe("insufficient");
    expect(result.availableIndicatorCount).toBe(0);
  });

  it("keeps a price-only result visible as partial data", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100.1, 100.2, 100.15, 100.3, 100.4, 100.5]),
      [],
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
        fundingRate: 0,
        premium: 0,
        dayNotionalVolume: 1_000_000,
      })),
    ];

    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100.1, 100.2, 100.15, 100.3, 100.4, 100.5]),
      contexts,
      stockCoins,
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
      "75% down at least 0.5% (9/12) · Hyperliquid xyz stock-perp proxy · context only",
    );
    expect(
      formatExpandedEquityBreadth(result.expandedEquityBreadth!, "zh"),
    ).toBe(
      "75% 跌幅至少 0.5%（9/12）· Hyperliquid xyz 股票永續合約代理 · 僅供背景參考",
    );
  });

  it("omits expanded breadth when fewer than ten stock perps are valid", () => {
    const result = analyzeMarketFragility(
      candlesFromCloses([100, 100.1, 100.2, 100.15, 100.3, 100.4, 100.5]),
      healthyContexts(),
      ["xyz:AAPL", "xyz:MSFT"],
    );

    expect(result.expandedEquityBreadth).toBeUndefined();
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
    fundingRate: 0,
    premium: 0,
    dayNotionalVolume: 1_000_000,
  }));
}

function stressedIds(
  result: ReturnType<typeof analyzeMarketFragility>,
): string[] {
  return result.indicators
    .filter((indicator) => indicator.state === "stressed")
    .map((indicator) => indicator.id);
}
