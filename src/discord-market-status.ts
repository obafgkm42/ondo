import {
  formatMarketFragilityMechanismLines,
} from "./market-fragility-format";
import {
  formatCompactMarketActivitySummary,
} from "./market-activity-format";
import type {
  Language,
  MarketActivitySnapshot,
  MarketDataHealth,
  MarketFragilitySnapshot,
  ScanResult,
} from "./types";

interface DiscordMarketStatusField {
  name: string;
  value: string;
  inline?: boolean;
}

/** Format the price description consistently for every Discord status card. */
export function buildDiscordMarketStatusDescription(
  result: ScanResult,
  language: Language,
  dataHealth?: MarketDataHealth,
  fragilityUnavailable = false,
): string {
  const english = language === "en";
  const latestPrice = formatNullableNumber(result.latestPrice);
  const sessionLow = formatNullableNumber(result.sessionLow);
  const sessionHigh = formatNullableNumber(result.sessionHigh);
  const priceSummary = english
    ? `Latest ${latestPrice} · session ${sessionLow}–${sessionHigh}`
    : `最新 ${latestPrice} · 日內 ${sessionLow}–${sessionHigh}`;
  if (fragilityUnavailable) {
    return english
      ? `${priceSummary} · repair status unavailable`
      : `${priceSummary} · 修復機制狀態不可用`;
  }
  if (dataHealth?.stateEligible !== false) {
    return priceSummary;
  }
  return english
    ? `${priceSummary} · market data ineligible for decisions`
    : `${priceSummary} · 市場資料不符合決策資格`;
}

/** Build the fields shared by scheduled and interactive status cards. */
export function buildDiscordMarketStatusFields(
  fragility: MarketFragilitySnapshot | null | undefined,
  activity: MarketActivitySnapshot | null | undefined,
  dataHealth: MarketDataHealth | undefined,
  language: Language,
  extraFields: DiscordMarketStatusField[] = [],
): DiscordMarketStatusField[] {
  const english = language === "en";
  const stateEligible = dataHealth?.stateEligible ?? true;
  return [
    ...(fragility == null
      ? []
      : [
          {
            name: english ? "Market pressure" : "市場壓力",
            value: formatMarketFragilityScore(fragility),
            inline: true,
          },
          {
            name: english ? "Mechanisms under stress" : "受壓機制",
            value: [
              fragility.stressedIndicatorCount,
              fragility.totalIndicatorCount,
            ].join(" / "),
            inline: true,
          },
        ]),
    ...(!stateEligible || activity == null
      ? []
      : [{
          name: english ? "Market activity" : "市場活躍度",
          value: formatCompactMarketActivitySummary(activity, language),
          inline: true,
        }]),
    ...extraFields,
    ...(fragility === undefined
      ? []
      : [{
          name: english ? "Six repair mechanisms" : "六個修復機制",
          value: fragility === null
            ? english ? "Repair status unavailable" : "修復機制狀態不可用"
            : formatMarketFragilityMechanismLines(fragility, language),
        }]),
  ];
}

/** Format the ordinal market-pressure score for Discord cards. */
export function formatMarketFragilityScore(
  fragility: MarketFragilitySnapshot,
): string {
  return fragility.score === null ? "n/a" : `${fragility.score}/100`;
}

function formatNullableNumber(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}
