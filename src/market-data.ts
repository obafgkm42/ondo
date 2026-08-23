import {
  adaptHyperliquidRows,
  normalizeMarketBars,
  type HyperliquidBarRow,
  type MarketBarV2,
} from "market-data-pipeline";

import type { Candle } from "./types";

const SOURCE_ID = "hyperliquid";
const PRODUCER_VERSION = "0.1.0";

/**
 * Normalize one Hyperliquid response through the shared canonical contract.
 *
 * Fetching and forming-bar selection stay in the caller. The scanner keeps its
 * existing fail-fast behavior and rejects fields its domain model requires.
 */
export function normalizeHyperliquidCandles(
  rows: readonly unknown[],
  coin: string,
  intervalMs: number,
  fetchedAt: string,
): Candle[] {
  if (!rows.every(isHyperliquidRow)) {
    throw new Error("Hyperliquid returned a malformed candle");
  }
  const instrumentId = `hyperliquid:${coin}`;
  const candidates = adaptHyperliquidRows(rows, {
    sourceId: SOURCE_ID,
    intervalMs,
  });
  const dataset = normalizeMarketBars(candidates, {
    producer: {
      name: "hyperliquid-sp500-reversal-scanner",
      version: PRODUCER_VERSION,
    },
    instrument: {
      id: instrumentId,
      assetClass: "perpetual",
      venue: "hyperliquid",
      economicExposure: coin,
    },
    barSpec: {
      intervalMs,
      timestampMeaning: "bar-start",
      timestampTimeZone: "UTC",
      endTimeSemantics: "exclusive",
    },
    normalization: {
      invalidRowPolicy: "reject-batch",
      duplicatePolicy: "reject",
      volumePolicy: "required-nonnegative",
    },
    provenance: {
      priceBasis: "trade",
      adjustment: "raw",
      volumeSemantics: "provider-reported-traded-volume",
      sources: {
        [SOURCE_ID]: {
          provider: "hyperliquid",
          providerSymbol: coin,
          instrumentId,
          fetchedAt,
          sourceTimeZone: "UTC",
        },
      },
    },
  });
  return dataset.bars.map(canonicalBarToCandle);
}

/** Convert exclusive canonical boundaries to the scanner's inclusive end. */
export function canonicalBarToCandle(bar: MarketBarV2): Candle {
  if (bar.volume === null) {
    throw new Error("scanner candles require measured volume");
  }
  if (bar.tradeCount === null) {
    throw new Error("scanner candles require trade count");
  }
  return {
    startTime: bar.startTimeMs,
    endTime: bar.endTimeExclusiveMs - 1,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
    tradeCount: bar.tradeCount,
  };
}

function isHyperliquidRow(value: unknown): value is HyperliquidBarRow {
  return typeof value === "object" && value !== null;
}
