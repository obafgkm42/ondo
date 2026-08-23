import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { renderMarketBriefChart } from "../src/chart";
import type { Candle, ReversalLocation, ScanResult } from "../src/types";

describe("renderMarketBriefChart", () => {
  it("renders a compressed png attachment for a market brief", async () => {
    const candles = Array.from({ length: 12 }, (_value, index) =>
      candle(index, 6075 + index, 6082 + index, 6070 + index, 6078 + index, 100),
    );
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: candles.length,
      sessionHigh: 6093,
      sessionLow: 6070,
      latestPrice: 6089,
      status: "no fresh lookback extreme rejection passed price-R and confidence thresholds",
      watch: null,
      signal: null,
    };

    const chart = await renderMarketBriefChart(result, candles);

    expect(chart?.contentType).toBe("image/png");
    expect(chart?.filename).toBe("SP500-brief-chart.png");
    expect(Array.from(chart?.bytes.slice(0, 8) ?? [])).toEqual([
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
    ]);
    expect(chart?.bytes.byteLength).toBeLessThan(100_000);
  });

  it("renders readable legend and marker labels into the png", async () => {
    const candles = Array.from({ length: 24 }, (_value, index) =>
      candle(
        index,
        6075 + index * 0.4,
        6082 + index,
        6070 + index,
        6078 + index,
        100,
      ),
    );
    const result: ScanResult = {
      market: "xyz:SP500",
      candleCount: candles.length,
      sessionHigh: 6102,
      sessionLow: 6095,
      latestPrice: 6098,
      status: "watching nearby convexity levels",
      watch: opportunity("watch"),
      signal: null,
    };

    const chart = await renderMarketBriefChart(result, candles);
    const decoded = decodePng(chart?.bytes ?? new Uint8Array());

    expect(
      countBrightPixels(decoded, { left: 60, top: 18, width: 330, height: 16 }),
    ).toBeGreaterThan(70);
    expect(
      countBrightPixels(decoded, {
        left: 550,
        top: 42,
        width: 86,
        height: 258,
      }),
    ).toBeGreaterThan(80);
    expect(pixelAt(decoded, 0, 0)).toEqual([10, 16, 31, 255]);
    expect(pixelAt(decoded, 100, 100)).toEqual([15, 23, 42, 255]);
    expect(pixelAt(decoded, 0, 339)).toEqual([15, 25, 42, 255]);
  });
});

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

interface PixelRegion {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function decodePng(bytes: Uint8Array): DecodedPng {
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  const idatChunks: Uint8Array[] = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = readUint32(bytes, offset);
    const type = new TextDecoder().decode(
      bytes.subarray(offset + 4, offset + 8),
    );
    if (type === "IDAT") {
      idatChunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }

  const raw = inflateSync(concatBytes(idatChunks));
  const pixels = new Uint8Array(width * height * 4);
  const scanlineWidth = width * 4 + 1;
  for (let y = 0; y < height; y += 1) {
    const rawOffset = y * scanlineWidth + 1;
    const pixelOffset = y * width * 4;
    pixels.set(raw.subarray(rawOffset, rawOffset + width * 4), pixelOffset);
  }
  return { width, height, pixels };
}

function countBrightPixels(decoded: DecodedPng, region: PixelRegion): number {
  let count = 0;
  for (let y = region.top; y < region.top + region.height; y += 1) {
    for (let x = region.left; x < region.left + region.width; x += 1) {
      const offset = (y * decoded.width + x) * 4;
      const red = decoded.pixels[offset] ?? 0;
      const green = decoded.pixels[offset + 1] ?? 0;
      const blue = decoded.pixels[offset + 2] ?? 0;
      if (red > 210 && green > 210 && blue > 210) {
        count += 1;
      }
    }
  }
  return count;
}

function pixelAt(
  decoded: DecodedPng,
  x: number,
  y: number,
): [number, number, number, number] {
  const offset = (y * decoded.width + x) * 4;
  return [
    decoded.pixels[offset] ?? 0,
    decoded.pixels[offset + 1] ?? 0,
    decoded.pixels[offset + 2] ?? 0,
    decoded.pixels[offset + 3] ?? 0,
  ];
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function candle(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): Candle {
  return {
    startTime: index * 300_000,
    endTime: index * 300_000 + 299_999,
    open,
    high,
    low,
    close,
    volume,
    tradeCount: 10,
  };
}

function opportunity(level: "watch" | "alert"): ReversalLocation {
  return {
    level,
    direction: "bullish",
    market: "xyz:SP500",
    price: 6098,
    entryLow: 6097,
    entryHigh: 6099,
    invalidation: 6095,
    target: 6102,
    sessionHigh: 6102,
    sessionLow: 6095,
    vwap: 6097,
    priceRiskReward: 2.4,
    confidenceScore: 62,
    policy: {
      name: "modern_reversal_zone_v1",
      role: "bullish_reversal_zone",
      watchEligible: true,
      alertEligible: true,
      reasons: ["modern reversal-zone regime gate passed"],
    },
    reasons: ["fresh lookback low rejected"],
    timestamp: Date.parse("2026-06-29T01:30:00+08:00"),
  };
}
