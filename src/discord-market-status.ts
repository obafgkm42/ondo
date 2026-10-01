import {
  formatMarketFragilityMechanismLines,
} from "./market-fragility-format";
import {
  formatCompactMarketActivitySummary,
  formatMarketActivityLabel,
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

/** Format price and the short activity state for every Discord status card. */
export function buildDiscordMarketStatusDescription(
  result: ScanResult,
  language: Language,
  dataHealth?: MarketDataHealth,
  fragilityUnavailable = false,
  activity?: MarketActivitySnapshot | null,
): string {
  const english = language === "en";
  const latestPrice = formatNullableNumber(result.latestPrice);
  const sessionLow = formatNullableNumber(result.sessionLow);
  const sessionHigh = formatNullableNumber(result.sessionHigh);
  const priceSummary = english
    ? `Latest ${latestPrice} · session ${sessionLow}–${sessionHigh}`
    : `最新 ${latestPrice} · 日內 ${sessionLow}–${sessionHigh}`;
  const description = activity == null || dataHealth?.stateEligible === false
    ? priceSummary
    : `${priceSummary} · ${english ? "Volume: " : "量能："}${formatMarketActivityLabel(activity, language)}`;
  if (fragilityUnavailable) {
    return english
      ? `${description} · repair status unavailable`
      : `${description} · 修復機制狀態不可用`;
  }
  if (dataHealth?.stateEligible !== false) {
    return description;
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

/** A single presentation input for scheduled briefs and interactive replies. */
export function buildDiscordMarketStatus(
  result: ScanResult,
  language: Language,
  fragility: MarketFragilitySnapshot | null | undefined,
  activity: MarketActivitySnapshot | null | undefined,
  dataHealth?: MarketDataHealth,
  extraFields: DiscordMarketStatusField[] = [],
) {
  const stateEligible = dataHealth?.stateEligible ?? true;
  const effectiveActivity = stateEligible ? activity ?? undefined : undefined;
  return {
    stateEligible,
    activity: effectiveActivity,
    description: buildDiscordMarketStatusDescription(
      result, language, dataHealth, fragility === null, effectiveActivity,
    ),
    fields: buildDiscordMarketStatusFields(
      fragility, effectiveActivity, dataHealth, language, extraFields,
    ),
  };
}
