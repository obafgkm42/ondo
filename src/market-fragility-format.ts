import type {
  ExpandedEquityBreadthSnapshot,
  Language,
  MarketFragilityIndicator,
  MarketFragilityIndicatorId,
  MarketFragilitySnapshot,
} from "./types";

/**
 * Format source-labelled expanded breadth without implying NYSE coverage.
 */
export function formatExpandedEquityBreadth(
  breadth: ExpandedEquityBreadthSnapshot,
  language: Language,
): string {
  const ratio = `${(breadth.declinerRatio * 100).toFixed(0)}%`;
  const threshold = `${Math.abs(breadth.declineThreshold * 100).toFixed(1)}%`;
  const count = `${breadth.declinerCount}/${breadth.assetCount}`;
  if (language === "en") {
    return [
      `${ratio} down at least ${threshold} (${count})`,
      "vs Hyperliquid prevDayPx",
      "xyz stock-perp proxy",
      "context only",
    ].join(" · ");
  }
  return [
    `${ratio} 跌幅至少 ${threshold}（${count}）`,
    "相對 Hyperliquid prevDayPx",
    "xyz 股票永續合約代理",
    "僅供背景參考",
  ].join(" · ");
}

/**
 * Format the classifier level for compact Discord surfaces.
 */
export function formatMarketFragilityLevel(
  fragility: MarketFragilitySnapshot,
): string {
  return fragility.level.toUpperCase();
}

/**
 * Label the ordinal score as stress so a favorable zero is unambiguous.
 */
export function formatMarketFragilityStressScore(
  fragility: MarketFragilitySnapshot,
  language: Language,
): string {
  const score = fragility.score === null ? "n/a" : `${fragility.score}/100`;
  return language === "en" ? `stress ${score}` : `壓力 ${score}`;
}

/**
 * Format one consistent summary across scheduled and interactive Discord UI.
 */
export function formatMarketFragilitySummary(
  fragility: MarketFragilitySnapshot,
  language: Language,
): string {
  const level = formatMarketFragilityLevel(fragility);
  const stressScore = formatMarketFragilityStressScore(fragility, language);
  const observed = [
    fragility.stressedIndicatorCount,
    fragility.availableIndicatorCount,
  ].join("/");
  if (language === "en") {
    return `${level} · ${stressScore} · ${observed} observed pressure conditions`;
  }
  return `${level} · ${stressScore} · 已觀察壓力條件 ${observed}`;
}

/** Format a value together with the measurement reference it actually uses. */
export function formatMarketFragilityIndicatorValue(
  indicator: MarketFragilityIndicator,
  fragility: MarketFragilitySnapshot,
  language: Language,
): string {
  const english = language === "en";
  const scope = fragility.observationWindow.sessionScope.toUpperCase();
  const labels = {
    analysis_session_open: english
      ? `vs ${scope} analysis-session open`
      : `相對 ${scope} 分析時段開盤`,
    latest_session_vwap: english
      ? "vs latest session VWAP"
      : "相對最新時段 VWAP",
    observed_session_range: english
      ? "within observed session range"
      : "位於已觀察時段區間",
    prior_candle_close: english
      ? "vs prior completed candle closes"
      : "相對先前已完成 K 線收盤",
    hyperliquid_prev_day_px: english
      ? "vs Hyperliquid prevDayPx"
      : "相對 Hyperliquid prevDayPx",
  } satisfies Record<MarketFragilityIndicator["referenceType"], string>;
  return `${indicator.displayValue} · ${labels[indicator.referenceType]}`;
}

/** Format observation timing without treating receipt time as provider time. */
export function formatMarketFragilityObservationWindow(
  fragility: MarketFragilitySnapshot,
  language: Language,
): string {
  const window = fragility.observationWindow;
  const scope = window.sessionScope.toUpperCase();
  const candleEnd = formatTimestamp(window.candleEndTime);
  const evaluatedAt = formatTimestamp(window.evaluatedAt);
  const firstLine = language === "en"
    ? `${scope} · candle end ${candleEnd} · evaluated ${evaluatedAt}`
    : `${scope} · K 線結束 ${candleEnd} · 評估 ${evaluatedAt}`;
  if (
    window.contextFetchedAt === null ||
    window.contextReferencePriceType === null
  ) {
    const unavailable = language === "en"
      ? "Context unavailable · price-only coverage"
      : "背景資料不可用 · 僅價格覆蓋";
    return `${firstLine}\n${unavailable}`;
  }
  const age = formatAge(
    Math.max(0, window.evaluatedAt - window.contextFetchedAt),
    language,
  );
  const providerTime = window.contextProviderTimestamp === null
    ? language === "en"
      ? "provider timestamp unavailable"
      : "供應商時間戳不可用"
    : language === "en"
      ? `provider timestamp ${formatTimestamp(window.contextProviderTimestamp)}`
      : `供應商時間戳 ${formatTimestamp(window.contextProviderTimestamp)}`;
  const contextLine = language === "en"
    ? [
        "Context: Hyperliquid prevDayPx",
        `fetched ${age} before evaluation`,
        providerTime,
      ].join(" · ")
    : [
        "背景：Hyperliquid prevDayPx",
        `評估前 ${age}取得`,
        providerTime,
      ].join(" · ");
  return `${firstLine}\n${contextLine}`;
}

/** Make unavailable mechanisms explicit instead of implying complete safety. */
export function formatMarketFragilityCoverage(
  fragility: MarketFragilitySnapshot,
  language: Language,
): string {
  const unavailable =
    fragility.totalIndicatorCount - fragility.availableIndicatorCount;
  const quality = formatMarketFragilityDataQuality(fragility, language);
  const observed = [
    fragility.availableIndicatorCount,
    fragility.totalIndicatorCount,
  ].join("/");
  if (language === "en") {
    return `${observed} observed · ${quality} · ${unavailable} unavailable`;
  }
  return `${observed} 已觀察 · ${quality} · ${unavailable} 不可用`;
}

/**
 * Localize the classifier's data-coverage label.
 */
export function formatMarketFragilityDataQuality(
  fragility: MarketFragilitySnapshot,
  language: Language,
): string {
  if (language === "en") {
    return fragility.dataQuality;
  }
  if (fragility.dataQuality === "full") {
    return "完整";
  }
  if (fragility.dataQuality === "partial") {
    return "部分";
  }
  return "不足";
}

/**
 * Localize one repair-mechanism label.
 */
export function formatMarketFragilityIndicatorLabel(
  id: MarketFragilityIndicatorId,
  language: Language,
): string {
  const englishLabels: Record<MarketFragilityIndicatorId, string> = {
    session_loss: "session loss",
    vwap_repair_failure: "VWAP repair failure",
    poor_close_location: "poor close location",
    downside_tail_cluster: "downside-tail cluster",
    mega_cap_breadth: "mega-cap breadth",
    equity_cross_confirmation: "SP500 / XYZ100 confirmation",
  };
  if (language === "en") {
    return englishLabels[id];
  }
  const chineseLabels: Record<MarketFragilityIndicatorId, string> = {
    session_loss: "時段跌幅",
    vwap_repair_failure: "VWAP 修復失敗",
    poor_close_location: "收盤承接偏弱",
    downside_tail_cluster: "下跌尾部群聚",
    mega_cap_breadth: "大型股廣度惡化",
    equity_cross_confirmation: "SP500 / XYZ100 同步走弱",
  };
  return chineseLabels[id];
}

/**
 * Map market fragility to the shared Discord severity color.
 */
export function marketFragilityColor(
  fragility: MarketFragilitySnapshot,
): number {
  if (fragility.level === "panic") {
    return 0xc0392b;
  }
  if (fragility.level === "breaking") {
    return 0xe67e22;
  }
  if (fragility.level === "fragile") {
    return 0xf1c40f;
  }
  if (fragility.level === "resilient") {
    return 0x2ecc71;
  }
  return 0x95a5a6;
}

function formatTimestamp(value: number | null): string {
  return value === null ? "n/a" : new Date(value).toISOString();
}

function formatAge(milliseconds: number, language: Language): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) {
    return language === "en" ? `${seconds}s` : `${seconds} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  return language === "en" ? `${minutes}m` : `${minutes} 分鐘`;
}
