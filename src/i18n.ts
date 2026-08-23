import type { Language } from "./types";

const ZH_STATIC_DIAGNOSTICS: Readonly<Record<string, string>> = {
  "no completed lookback candle": "沒有已完成的回看 K 線",
  "qualified alert-level modern reversal-zone signal":
    "已偵測到符合 ALERT 級別的現代反轉區訊號",
  "watch-level modern reversal-zone setup found; alert thresholds not yet met":
    "已偵測到 WATCH 級別的現代反轉區形態；尚未達到 ALERT 門檻",
  "fresh rejection found, but regime policy kept it out of reversal-zone alerts":
    "已偵測到新的拒絕形態，但市場狀態政策未讓它進入反轉區警示",
  "no fresh lookback extreme rejection passed watch or alert thresholds":
    "沒有新的回看極值拒絕形態通過 WATCH 或 ALERT 門檻",
  "no fresh lookback extreme rejection passed price-R and confidence thresholds":
    "沒有新的回看極值拒絕形態通過價格盈虧比與信心分門檻",
  "reversal candle range is expanded versus recent ATR":
    "反轉 K 線區間相對近期 ATR 明顯擴張",
  "bullish-first policy: bottom reversals are the primary trade signal":
    "多頭優先政策：底部反轉是主要交易訊號",
  "modern reversal-zone regime gate passed":
    "已通過現代反轉區市場狀態門檻",
  "held back because the reversal zone is not sufficiently displaced or risk is too wide":
    "未達門檻：反轉區偏離幅度不足或風險範圍過寬",
  "bearish policy: retained only as a stricter crash/stress monitor":
    "空頭政策：僅保留為較嚴格的崩跌／壓力監測",
  "bearish crash-monitor regime gate passed":
    "已通過空頭崩跌監測市場狀態門檻",
  "held back because bearish reversals need expanded stress conditions":
    "未達門檻：空頭反轉需要更明顯的壓力擴張條件",
};

interface DiagnosticPattern {
  pattern: RegExp;
  translate: (match: RegExpMatchArray) => string;
}

const ZH_DIAGNOSTIC_PATTERNS: readonly DiagnosticPattern[] = [
  {
    pattern: /^waiting for (\d+) completed lookback candles$/,
    translate: (match) => `等待 ${match[1]} 根已完成的回看 K 線`,
  },
  {
    pattern: /^fresh lookback (low|high) rejected$/,
    translate: (match) =>
      `新的回看${match[1] === "low" ? "低點" : "高點"}遭到拒絕`,
  },
  {
    pattern: /^close remained in the outer (.+)% of the observed range$/,
    translate: (match) => `收盤仍位於觀察區間外側 ${match[1]}%`,
  },
  {
    pattern: /^invalidation is (.+) points away$/,
    translate: (match) => `失效點距離 ${match[1]} 點`,
  },
  {
    pattern: /^mean-reversion target (.+) offers (.+)R in underlying price$/,
    translate: (match) =>
      `均值回歸目標 ${match[1]} 提供標的價格 ${match[2]}R`,
  },
  {
    pattern: /^rejection wick is (.+)% of candle range$/,
    translate: (match) => `拒絕影線佔 K 線區間 ${match[1]}%`,
  },
  {
    pattern: /^volume is (.+)x the recent average$/,
    translate: (match) => `成交量為近期平均的 ${match[1]} 倍`,
  },
  {
    pattern: /^new extreme extended (.+) ATR beyond the prior extreme$/,
    translate: (match) => `新極值超出前一極值 ${match[1]} ATR`,
  },
  {
    pattern: /^distance from VWAP is (.+) ATR$/,
    translate: (match) => `距離 VWAP ${match[1]} ATR`,
  },
  {
    pattern: /^session range is (.+) ATR$/,
    translate: (match) => `交易時段區間為 ${match[1]} ATR`,
  },
  {
    pattern: /^risk is (.+) ATR$/,
    translate: (match) => `風險為 ${match[1]} ATR`,
  },
];

/**
 * Localize a stable scanner diagnostic without changing signal-engine output.
 */
export function localizeDiagnostic(
  diagnostic: string,
  language: Language,
): string {
  if (language === "en") {
    return diagnostic;
  }

  const staticTranslation = ZH_STATIC_DIAGNOSTICS[diagnostic];
  if (staticTranslation !== undefined) {
    return staticTranslation;
  }

  for (const translator of ZH_DIAGNOSTIC_PATTERNS) {
    const match = diagnostic.match(translator.pattern);
    if (match !== null) {
      return translator.translate(match);
    }
  }

  return diagnostic;
}
