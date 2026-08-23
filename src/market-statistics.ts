import type { Candle } from "./types";

/**
 * Calculate a volume-weighted typical price, falling back to mean close when
 * the venue reports no usable volume.
 */
export function calculateVwap(candles: readonly Candle[]): number {
  const totalVolume = candles.reduce(
    (total, candle) => total + candle.volume,
    0,
  );
  if (totalVolume <= 0) {
    return average(candles.map((candle) => candle.close));
  }
  return (
    candles.reduce(
      (total, candle) =>
        total +
        ((candle.high + candle.low + candle.close) / 3) * candle.volume,
      0,
    ) / totalVolume
  );
}

/**
 * Calculate recent average true range from completed candles.
 */
export function calculateAverageTrueRange(
  candles: readonly Candle[],
  window: number,
): number {
  const sample = candles.slice(-(window + 1));
  const trueRanges = sample.slice(1).map((candle, index) => {
    const previousClose = sample[index]?.close ?? candle.open;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  });
  return average(trueRanges);
}

/**
 * Calculate an arithmetic mean without emitting NaN for an empty sample.
 */
export function average(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}
