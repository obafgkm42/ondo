import type { Language, ResilienceDecayMetrics } from "./types";

/**
 * Format the detailed card line for a materially fading resilience state.
 */
export function formatResilienceDecayCardSummary(
  metrics: ResilienceDecayMetrics,
  language: Language,
): string {
  const recent = formatMetric(metrics.recentResilience);
  const baseline = formatMetric(metrics.baselineResilience);
  const delta = formatSignedMetric(metrics.decayDelta);
  const decayScore = formatMetric(metrics.decayScore);
  if (language === "en") {
    return `${metrics.status} · recovery ${recent}/100 vs baseline ${baseline}/100 · decay Δ ${delta} · decay pressure ${decayScore}/100`;
  }
  return `${metrics.status} · 復原 ${recent}/100 · 基準 ${baseline}/100 · 衰退 Δ ${delta} · 衰退壓力 ${decayScore}/100`;
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

function formatSignedMetric(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  return value >= 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
}
