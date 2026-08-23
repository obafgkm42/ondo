#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const candles = JSON.parse(await readFile(options.input, "utf8"));
  const resampled = resampleCandles(candles, options.intervalMinutes);

  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(resampled)}\n`, "utf8");

  console.log(`Input candles: ${candles.length}`);
  console.log(`Output candles: ${resampled.length}`);
  console.log(`Output: ${options.output}`);
  if (resampled.length > 0) {
    console.log(`Range: ${new Date(resampled[0].endTime).toISOString()} to ${new Date(resampled.at(-1).endTime).toISOString()}`);
  }
}

function resampleCandles(candles, intervalMinutes) {
  const intervalMs = intervalMinutes * 60_000;
  const groups = new Map();
  for (const candle of candles) {
    const bucketStart = Math.floor(candle.startTime / intervalMs) * intervalMs;
    const existing = groups.get(bucketStart);
    if (existing === undefined) {
      groups.set(bucketStart, {
        startTime: bucketStart,
        endTime: bucketStart + intervalMs - 1,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
        tradeCount: candle.tradeCount,
      });
      continue;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += candle.volume;
    existing.tradeCount += candle.tradeCount;
  }

  return [...groups.values()].sort((left, right) => left.startTime - right.startTime);
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const [rawName, inlineValue] = arg.slice(2).split("=", 2);
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawName}`);
    }
    if (inlineValue === undefined) {
      index += 1;
    }
    values.set(rawName, value);
  }

  return {
    input: required(values, "input"),
    output: required(values, "output"),
    intervalMinutes: positiveInteger(values.get("interval-minutes"), "interval-minutes"),
  };
}

function required(values, name) {
  const value = values.get(name);
  if (value === undefined) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

function positiveInteger(rawValue, name) {
  const value = Number(rawValue);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
