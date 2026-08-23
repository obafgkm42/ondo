import type {
  Language,
  MarketActivityDataQuality,
  MarketActivitySnapshot,
} from "./types";

const EASTERN_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Format a structured bilingual diagnostic for Discord cards. */
export function formatMarketActivitySummary(
  activity: MarketActivitySnapshot,
  language: Language,
): string {
  const english = language === "en";
  const asOf = `${EASTERN_TIME_FORMATTER.format(new Date(activity.asOf))} ET`;
  const history = english
    ? `${activity.sampleSessions} historical sessions`
    : `${activity.sampleSessions} 個歷史交易日`;
  const quality = formatMarketActivityDataQuality(
    activity.dataQuality,
    language,
  );

  if (activity.level === "FORMING") {
    return english
      ? [
          "Status: FORMING",
          "Detail: opening volume profile still forming",
          `History: ${history}`,
          `Through: ${asOf}`,
        ].join("\n")
      : [
          "狀態：FORMING（形成中）",
          "說明：開盤成交輪廓形成中",
          `歷史樣本：${history}`,
          `截至：${asOf}`,
        ].join("\n");
  }
  if (activity.level === "UNKNOWN" || activity.sessionRvol === null) {
    return english
      ? [
          "Status: UNKNOWN",
          "Reason: market activity data unavailable",
          `History: ${history}`,
          `Data quality: ${quality}`,
        ].join("\n")
      : [
          "狀態：UNKNOWN（未知）",
          "原因：市場活躍度資料不足",
          `歷史樣本：${history}`,
          `資料品質：${quality}`,
        ].join("\n");
  }

  const confidence = english
    ? activity.confidence
    : formatConfidence(activity.confidence);
  return [
    `${english ? "Status" : "狀態"}：${formatActivityLevel(activity, language)}`,
    ...formatDetailedActivityMetrics(
      activity,
      activity.sessionRvol,
      language,
    ),
    `${english ? "Confidence" : "可信度"}：${confidence}`,
    `${english ? "Through" : "截至"}：${asOf}`,
  ].join("\n");
}

/** Keep the activity state visible near the start of mobile push previews. */
export function formatMarketActivityNotificationSummary(
  activity: MarketActivitySnapshot,
  language: Language,
): string {
  const english = language === "en";
  if (activity.level === "FORMING") {
    return english
      ? "Volume FORMING | Opening profile forming"
      : "量能 FORMING｜開盤輪廓形成中";
  }
  if (activity.level === "UNKNOWN" || activity.sessionRvol === null) {
    return english
      ? "Volume UNKNOWN | Insufficient history"
      : "量能 UNKNOWN｜歷史資料不足";
  }

  const latestBar = formatCompactLatestBar(activity, language);
  return english
    ? [
        `Volume ${formatActivityLevel(activity, language)}`,
        `Cumulative ${activity.sessionRvol.toFixed(2)}x`,
        ...(latestBar === null ? [] : [latestBar]),
      ].join(" | ")
    : [
        `量能 ${formatActivityLevel(activity, language)}`,
        `累積 ${activity.sessionRvol.toFixed(2)}x`,
        ...(latestBar === null ? [] : [latestBar]),
      ].join("｜");
}

/** Localize the sample-depth label without changing its machine value. */
export function formatMarketActivityDataQuality(
  quality: MarketActivityDataQuality,
  language: Language,
): string {
  if (language === "en") {
    return quality;
  }
  const labels: Record<MarketActivityDataQuality, string> = {
    insufficient: "資料不足",
    provisional: "初步",
    limited: "有限",
    good: "良好",
    full: "完整",
  };
  return labels[quality];
}

function formatConfidence(
  confidence: MarketActivitySnapshot["confidence"],
): string {
  const labels: Record<MarketActivitySnapshot["confidence"], string> = {
    unavailable: "不可用",
    provisional: "初步",
    borderline: "臨界",
    confirmed: "確認",
    mixed: "分歧",
  };
  return labels[confidence];
}

function formatActivityLevel(
  activity: MarketActivitySnapshot,
  language: Language,
): string {
  if (language === "en") {
    return activity.level;
  }
  const labels: Record<MarketActivitySnapshot["level"], string> = {
    DEADWATER: "死水",
    QUIET: "清淡",
    NORMAL: "正常",
    ACTIVE: "活躍",
    SURGE: "激增",
    FORMING: "形成中",
    UNKNOWN: "未知",
  };
  return `${activity.level}（${labels[activity.level]}）`;
}

function formatDetailedActivityMetrics(
  activity: MarketActivitySnapshot,
  sessionRvol: number,
  language: Language,
): string[] {
  const english = language === "en";
  const cumulative = english
    ? `Cumulative volume: ${sessionRvol.toFixed(2)}x (vs. historical same-time average)`
    : `今日累積量：${sessionRvol.toFixed(2)}x（相較過去同時刻均值）`;
  const percentile = activity.percentile === null
    ? english
      ? `Historical percentile: pending (sample: ${activity.sampleSessions} sessions)`
      : `歷史位置：百分位待累積（樣本：${activity.sampleSessions} 日）`
    : english
      ? `Historical percentile: ${Math.round(activity.percentile)}/100 (sample: ${activity.sampleSessions} sessions)`
      : `歷史位置：第 ${Math.round(activity.percentile)} 百分位（樣本：${activity.sampleSessions} 日）`;
  const latestBar = activity.barRvol === null || activity.barActivity === null
    ? english
      ? "Latest 15m: comparison unavailable"
      : "最近 15 分鐘：無可用同期比較"
    : english
      ? `Latest 15m: ${activity.barRvol.toFixed(2)}x (vs. historical same-slot average; ${activity.barActivity.toUpperCase()})`
      : `最近 15 分鐘：${activity.barRvol.toFixed(2)}x（相較過去同時段均值；${formatBarActivity(activity.barActivity)}）`;
  return [cumulative, percentile, latestBar];
}

function formatCompactLatestBar(
  activity: MarketActivitySnapshot,
  language: Language,
): string | null {
  if (activity.barRvol === null || activity.barActivity === null) {
    return null;
  }
  return language === "en"
    ? `15m ${activity.barRvol.toFixed(2)}x ${activity.barActivity.toUpperCase()}`
    : `15m ${activity.barRvol.toFixed(2)}x ${formatBarActivity(activity.barActivity)}`;
}

function formatBarActivity(
  activity: NonNullable<MarketActivitySnapshot["barActivity"]>,
): string {
  const labels: Record<
    NonNullable<MarketActivitySnapshot["barActivity"]>,
    string
  > = {
    ordinary: "一般",
    elevated: "明顯放量",
    burst: "爆量",
  };
  return labels[activity];
}
