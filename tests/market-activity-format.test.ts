import { describe, expect, it } from "vitest";

import {
  formatMarketActivityNotificationSummary,
  formatMarketActivitySummary,
} from "../src/market-activity-format";
import type { MarketActivitySnapshot } from "../src/types";

describe("formatMarketActivitySummary", () => {
  it("renders factor, percentile, burst, confidence, and New York as-of time", () => {
    expect(
      formatMarketActivitySummary(activitySnapshot(), "zh"),
    ).toBe(
      "狀態：ACTIVE（活躍）\n今日累積量：1.31x（相較過去同時刻均值）\n歷史位置：第 82 百分位（樣本：46 日）\n最近 15 分鐘：1.70x（相較過去同時段均值；明顯放量）\n可信度：確認\n截至：11:30 ET",
    );
  });

  it("explains an insufficient snapshot without inventing an RVOL value", () => {
    expect(
      formatMarketActivitySummary(
        {
          ...activitySnapshot(),
          level: "UNKNOWN",
          sessionRvol: null,
          barRvol: null,
          barActivity: null,
          percentile: null,
          percentileBand: null,
          sampleSessions: 3,
          confidence: "unavailable",
          dataQuality: "insufficient",
        },
        "en",
      ),
    ).toBe(
      "Status: UNKNOWN\nReason: market activity data unavailable\nHistory: 3 historical sessions\nData quality: insufficient",
    );
  });
});

describe("formatMarketActivityNotificationSummary", () => {
  it("puts the cumulative state, rank, and latest bar in the preview", () => {
    expect(
      formatMarketActivityNotificationSummary(activitySnapshot(), "zh"),
    ).toBe("量能 ACTIVE（活躍）｜累積 1.31x｜15m 1.70x 明顯放量");
  });

  it("shows sample depth without inventing unavailable RVOL values", () => {
    const unavailableSnapshot: MarketActivitySnapshot = {
      ...activitySnapshot(),
      level: "UNKNOWN",
      sessionRvol: null,
      barRvol: null,
      barActivity: null,
      percentile: null,
      percentileBand: null,
      sampleSessions: 3,
      confidence: "unavailable",
      dataQuality: "insufficient",
    };

    expect(
      formatMarketActivityNotificationSummary(unavailableSnapshot, "zh"),
    ).toBe("量能 UNKNOWN｜歷史資料不足");
    expect(
      formatMarketActivityNotificationSummary(unavailableSnapshot, "en"),
    ).toBe("Volume UNKNOWN | Insufficient history");
  });

  it("keeps the forming state concise", () => {
    expect(
      formatMarketActivityNotificationSummary(
        {
          ...activitySnapshot(),
          level: "FORMING",
          sessionRvol: null,
          barRvol: null,
          barActivity: null,
          percentile: null,
          percentileBand: null,
        },
        "zh",
      ),
    ).toBe("量能 FORMING｜開盤輪廓形成中");
  });
});

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
