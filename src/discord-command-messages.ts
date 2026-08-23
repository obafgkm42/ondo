import { HyperliquidRateLimitError } from "./hyperliquid";
import { localizeDiagnostic } from "./i18n";
import { formatIneligibleMarketDataStatus } from "./market-data-health";
import {
  formatExpandedEquityBreadth,
  formatMarketFragilityDataQuality,
  formatMarketFragilityIndicatorLabel,
  formatMarketFragilityLevel,
  formatMarketFragilitySummary,
  marketFragilityColor,
} from "./market-fragility-format";
import { marketFragilityThresholds } from "./market-fragility";
import { formatMarketActivitySummary } from "./market-activity-format";
import type {
  Language,
  MarketDataHealth,
  MarketFragilityIndicatorId,
  MarketFragilitySnapshot,
  MarketActivitySnapshot,
  ReversalLocation,
  ScanResult,
} from "./types";

const repairMechanismOrder: readonly MarketFragilityIndicatorId[] = [
  "session_loss",
  "vwap_repair_failure",
  "poor_close_location",
  "downside_tail_cluster",
  "mega_cap_breadth",
  "equity_cross_confirmation",
];

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  timestamp?: string;
}

/** Discord message body shared by immediate and deferred interaction replies. */
export interface DiscordMessageData {
  content?: string;
  embeds?: DiscordEmbed[];
  allowed_mentions: { parse: string[] };
}

/** Read-only scan data needed by the interactive status formatter. */
export interface DiscordScannerStatus {
  scan: ScanResult;
  fragility: MarketFragilitySnapshot | null;
  activity?: MarketActivitySnapshot | null;
  dataHealth?: MarketDataHealth;
}

/**
 * Build the completed private response for `/scanner status`.
 */
export function buildDiscordStatusMessage(
  status: DiscordScannerStatus,
  language: Language,
  queriedAt: Date,
): DiscordMessageData {
  const english = language === "en";
  const fragility = status.fragility;
  const scan = status.scan;
  const stateEligible = status.dataHealth?.stateEligible ?? true;
  const indicatorLines = fragility === null
    ? english
      ? "Repair status unavailable"
      : "修復機制狀態不可用"
    : fragility.indicators.map((indicator) =>
      [
        indicatorStateIcon(indicator.state),
        formatMarketFragilityIndicatorLabel(indicator.id, language),
        indicator.displayValue,
      ].join(" ")
    ).join("\n");
  const titleLevel = fragility === null
    ? "UNKNOWN"
    : formatMarketFragilityLevel(fragility);
  const description = fragility === null
    ? english
      ? "The live scan completed, but market-fragility diagnostics were unavailable."
      : "即時掃描已完成，但市場修復狀態無法取得。"
    : formatMarketFragilitySummary(fragility, language);

  return {
    embeds: [
      {
        title: english
          ? `SP500 Scanner Status · ${titleLevel}`
          : `SP500 掃描器狀態 · ${titleLevel}`,
        description: `${description}\n${english ? "Private read-only query; not financial advice or an order instruction." : "私密唯讀查詢；不是投資建議，也不會下單。"}`,
        color: fragility === null ? 0x95a5a6 : marketFragilityColor(fragility),
        fields: [
          {
            name: english ? "Market" : "行情",
            value: `${scan.market} · ${english ? "latest" : "最新"} ${formatNullableNumber(scan.latestPrice)}\n${english ? "session" : "時段"} ${formatNullableNumber(scan.sessionLow)}–${formatNullableNumber(scan.sessionHigh)}`,
            inline: true,
          },
          {
            name: english ? "Signal" : "訊號",
            value: formatOpportunity(
              stateEligible ? scan.signal ?? scan.watch : null,
              language,
            ),
            inline: true,
          },
          ...(status.dataHealth === undefined
            ? []
            : [
                {
                  name: english ? "Input health" : "輸入資料健康度",
                  value: formatStatusDataHealth(status.dataHealth, language),
                },
              ]),
          {
            name: english ? "Repair mechanisms" : "修復機制",
            value: indicatorLines,
          },
          ...(fragility === null
            ? []
            : [
                {
                  name: english ? "Data coverage" : "資料覆蓋",
                  value: `${fragility.availableIndicatorCount}/${fragility.totalIndicatorCount} · ${formatMarketFragilityDataQuality(fragility, language)}`,
                  inline: true,
                },
              ]),
          ...(fragility?.expandedEquityBreadth === undefined
            ? []
            : [
                {
                  name: english
                    ? "Expanded equity breadth"
                    : "擴展股票廣度",
                  value: formatExpandedEquityBreadth(
                    fragility.expandedEquityBreadth,
                    language,
                  ),
                },
              ]),
          ...(!stateEligible ||
              status.activity === undefined ||
              status.activity === null
            ? []
            : [
                {
                  name: english ? "Market activity" : "市場活躍度",
                  value: formatMarketActivitySummary(
                    status.activity,
                    language,
                  ),
                },
              ]),
          {
            name: english ? "Scanner diagnostic" : "掃描診斷",
            value: status.dataHealth?.stateEligible === false
              ? formatIneligibleMarketDataStatus(
                  status.dataHealth,
                  language,
                )
              : localizeDiagnostic(scan.status, language),
          },
        ],
        timestamp: queriedAt.toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function formatStatusDataHealth(
  health: MarketDataHealth,
  language: Language,
): string {
  const english = language === "en";
  const eligibility = health.stateEligible
    ? english ? "eligible" : "可用於決策"
    : english ? "withheld" : "不納入決策";
  const asOf = health.latestEndTime === null
    ? "n/a"
    : new Date(health.latestEndTime).toISOString();
  return [
    `${health.status.toUpperCase()} · ${health.sessionScope.toUpperCase()} · ${eligibility}`,
    `${english ? "As of" : "截至"}：${asOf}`,
    `${english ? "Gaps / missing" : "缺口 / 遺漏"}：${health.gapCount} / ${health.missingIntervals}`,
  ].join("\n");
}

/**
 * Build the static repair-mechanism guide without requesting market data.
 */
export function buildDiscordRepairGuideMessage(
  language: Language,
): DiscordMessageData {
  const english = language === "en";
  return {
    embeds: [
      {
        title: english
          ? "SP500 Market-Repair Guide"
          : "SP500 市場修復機制說明書",
        description: english
          ? "The classifier counts independently observable repair failures. The score measures stress, not resilience or crash probability."
          : "分類器計算同時受壓的修復機制數量。分數衡量的是壓力，不是韌性分數或崩跌機率。",
        color: 0x3498db,
        fields: [
          ...repairMechanismOrder.map((id, index) => ({
            name: `${index + 1}. ${formatMarketFragilityIndicatorLabel(id, language)}`,
            value: `${repairMechanismDescription(id, language)}\n${english ? "Live threshold" : "即時門檻"}: \`${marketFragilityThresholds[id]}\``,
          })),
          {
            name: english ? "State levels" : "狀態分級",
            value: english
              ? "RESILIENT: 0–1 stressed · FRAGILE: 2 · BREAKING: 3 · PANIC: 4+ · UNKNOWN: fewer than 4 indicators available"
              : "RESILIENT：0–1 項受壓 · FRAGILE：2 項 · BREAKING：3 項 · PANIC：4 項以上 · UNKNOWN：可用指標少於 4 項",
          },
          {
            name: english ? "Interpretation" : "解讀原則",
            value: english
              ? "A favorable zero is shown as stress 0/100. This diagnostic does not change the frozen reversal-alert thresholds."
              : "有利的零分會標示為壓力 0/100。這項診斷不會改動既有反轉警報門檻。",
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

/**
 * Build the static command guide.
 */
export function buildDiscordHelpMessage(
  language: Language,
): DiscordMessageData {
  const english = language === "en";
  return {
    embeds: [
      {
        title: english ? "SP500 Scanner Commands" : "SP500 掃描器指令",
        description: english
          ? "All command responses are private to the person who invoked them."
          : "所有指令回覆都只有執行者本人可見。",
        color: 0x3498db,
        fields: [
          {
            name: "/scanner status",
            value: english
              ? "Run one live, read-only scan and show price, signal, and repair status."
              : "執行一次即時唯讀掃描，顯示行情、訊號與修復狀態。",
          },
          {
            name: "/scanner repair",
            value: english
              ? "Show the six repair mechanisms, thresholds, and state levels without requesting market data."
              : "顯示六項修復機制、門檻與狀態分級，不會請求市場資料。",
          },
          {
            name: "/scanner help",
            value: english
              ? "Show this command guide and privacy behavior."
              : "顯示這份指令與隱私說明。",
          },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

/**
 * Build an observable private failure response for a live status query.
 */
export function buildDiscordStatusErrorMessage(
  error: unknown,
  language: Language,
): DiscordMessageData {
  const rateLimited = error instanceof HyperliquidRateLimitError;
  const english = language === "en";
  return {
    embeds: [
      {
        title: english
          ? "SP500 status query incomplete"
          : "SP500 狀態查詢未完成",
        description: rateLimited
          ? english
            ? "Hyperliquid rate limited the live data request. Scheduled scans will continue retrying normally."
            : "Hyperliquid 限制了即時資料請求；排程掃描仍會照常繼續重試。"
          : english
            ? "The live status query failed. Check Worker logs before relying on the latest scanner state."
            : "即時狀態查詢失敗；請先查看 Worker logs，再判斷最新掃描器狀態。",
        color: 0xe67e22,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

/**
 * Build the fallback for an unsupported command payload.
 */
export function buildDiscordUnsupportedCommandMessage(
  language: Language,
): DiscordMessageData {
  return {
    content: language === "en"
      ? "Unknown command. Use `/scanner help`."
      : "不支援這個指令，請使用 `/scanner help`。",
    allowed_mentions: { parse: [] },
  };
}

/**
 * Build the response for a valid interaction from an unauthorized guild.
 */
export function buildDiscordUnauthorizedGuildMessage(
  language: Language,
): DiscordMessageData {
  return {
    content: language === "en"
      ? "This scanner command is not authorized in this server."
      : "這個伺服器未獲授權使用掃描器指令。",
    allowed_mentions: { parse: [] },
  };
}

function repairMechanismDescription(
  id: MarketFragilityIndicatorId,
  language: Language,
): string {
  const descriptions: Record<
    MarketFragilityIndicatorId,
    { en: string; zh: string }
  > = {
    session_loss: {
      en: "Checks whether the current SP500 session has suffered a material loss from its opening price.",
      zh: "檢查 SP500 目前時段相對開盤價是否已出現明顯跌幅。",
    },
    vwap_repair_failure: {
      en: "Checks whether price remains materially below VWAP instead of repairing back toward it.",
      zh: "檢查價格是否持續明顯低於 VWAP，未能向均衡價格修復。",
    },
    poor_close_location: {
      en: "Checks whether the latest close remains near the bottom of the observed session range.",
      zh: "檢查最新收盤是否仍停留在已觀察時段區間的底部。",
    },
    downside_tail_cluster: {
      en: "Checks for repeated unusually large five-minute losses after adjusting for recent volatility.",
      zh: "依近期波動調整後，檢查是否重複出現異常大的五分鐘跌幅。",
    },
    mega_cap_breadth: {
      en: "Checks whether weakness is broad across the monitored US mega-cap basket.",
      zh: "檢查跌勢是否廣泛擴散至監測中的美國大型權值股。",
    },
    equity_cross_confirmation: {
      en: "Checks whether SP500 and XYZ100 confirm material weakness at the same time.",
      zh: "檢查 SP500 與 XYZ100 是否同時確認明顯弱勢。",
    },
  };
  return descriptions[id][language];
}

function formatOpportunity(
  opportunity: ReversalLocation | null,
  language: Language,
): string {
  if (opportunity === null) {
    return language === "en"
      ? "No qualified WATCH / ALERT"
      : "暫無合格 WATCH / ALERT";
  }
  const direction = language === "en"
    ? opportunity.direction.toUpperCase()
    : opportunity.direction === "bullish"
      ? "多頭"
      : "空頭";
  return [
    `${opportunity.level.toUpperCase()} · ${direction} · ${opportunity.price.toFixed(1)}`,
    `${language === "en" ? "entry" : "觀察區"} ${opportunity.entryLow.toFixed(1)}–${opportunity.entryHigh.toFixed(1)}`,
    `${language === "en" ? "invalidation" : "失效"} ${opportunity.invalidation.toFixed(1)} · ${language === "en" ? "target" : "目標"} ${opportunity.target.toFixed(1)}`,
  ].join("\n");
}

function indicatorStateIcon(
  state: MarketFragilitySnapshot["indicators"][number]["state"],
): string {
  if (state === "stressed") {
    return "🔴";
  }
  if (state === "healthy") {
    return "🟢";
  }
  return "⚪";
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}
