#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const EXPECTED_OBSERVATIONS_PER_FULL_SESSION = 78;
const EXPECTED_MEASUREMENT_VERSION = "market-fragility-price-only/v1";

/** Build a data-minimizing operational summary from one local KV snapshot. */
export function summarizeRthShadowAcquisition(value) {
  assertSnapshot(value);
  const seenTimestamps = new Set();
  const delays = [];
  let duplicateTimestampCount = 0;
  let outOfOrderCount = 0;
  let unexpectedIntervalCount = 0;
  let negativeDelayCount = 0;

  const sessions = value.sessions.map((session) => {
    let previousTimestamp = null;
    let sessionDuplicateCount = 0;
    let sessionOutOfOrderCount = 0;
    let sessionUnexpectedIntervalCount = 0;

    for (const observation of session.observations) {
      const timestamp = observation.candleEndTime;
      if (seenTimestamps.has(timestamp)) {
        duplicateTimestampCount += 1;
        sessionDuplicateCount += 1;
      }
      seenTimestamps.add(timestamp);
      if (previousTimestamp !== null && timestamp < previousTimestamp) {
        outOfOrderCount += 1;
        sessionOutOfOrderCount += 1;
      }
      if (
        previousTimestamp !== null &&
        timestamp - previousTimestamp !== value.intervalMinutes * 60_000
      ) {
        unexpectedIntervalCount += 1;
        sessionUnexpectedIntervalCount += 1;
      }
      previousTimestamp = timestamp;

      const delay = observation.acquiredAt - timestamp;
      if (delay < 0) {
        negativeDelayCount += 1;
      } else {
        delays.push(delay);
      }
    }

    const observed = session.observations.length;
    return {
      sessionKey: session.sessionKey,
      observed,
      retainedCoveragePercent: roundPercent(
        observed / EXPECTED_OBSERVATIONS_PER_FULL_SESSION,
      ),
      duplicateTimestampCount: sessionDuplicateCount,
      outOfOrderCount: sessionOutOfOrderCount,
      unexpectedIntervalCount: sessionUnexpectedIntervalCount,
      firstCandleEndTime: isoTime(session.observations[0]?.candleEndTime),
      lastCandleEndTime: isoTime(session.observations.at(-1)?.candleEndTime),
    };
  });

  return {
    schemaVersion: value.version,
    measurementVersion: value.measurementVersion,
    source: value.source,
    market: value.market,
    intervalMinutes: value.intervalMinutes,
    retainedSessionCount: sessions.length,
    retainedObservationCount: sessions.reduce(
      (total, session) => total + session.observed,
      0,
    ),
    completeGridSessionCount: sessions.filter(
      (session) =>
        session.observed === EXPECTED_OBSERVATIONS_PER_FULL_SESSION &&
        session.duplicateTimestampCount === 0 &&
        session.outOfOrderCount === 0 &&
        session.unexpectedIntervalCount === 0,
    ).length,
    duplicateTimestampCount,
    outOfOrderCount,
    unexpectedIntervalCount,
    acquisitionDelayMs: {
      validSampleCount: delays.length,
      negativeCount: negativeDelayCount,
      p50: percentile(delays, 0.5),
      p95: percentile(delays, 0.95),
      max: delays.length === 0 ? null : Math.max(...delays),
    },
    sessions,
  };
}

function assertSnapshot(value) {
  if (!isRecord(value)) {
    throw new Error("snapshot must be a JSON object");
  }
  if (
    value.version !== 1 ||
    value.measurementVersion !== EXPECTED_MEASUREMENT_VERSION ||
    value.source !== "hyperliquid" ||
    typeof value.market !== "string" ||
    value.market.length === 0 ||
    value.intervalMinutes !== 5 ||
    !Array.isArray(value.sessions)
  ) {
    throw new Error("snapshot metadata does not match the stage B v1 contract");
  }
  for (const session of value.sessions) {
    if (
      !isRecord(session) ||
      typeof session.sessionKey !== "string" ||
      !Array.isArray(session.observations)
    ) {
      throw new Error("snapshot contains an invalid session");
    }
    for (const observation of session.observations) {
      if (
        !isRecord(observation) ||
        !Number.isFinite(observation.candleEndTime) ||
        !Number.isFinite(observation.acquiredAt)
      ) {
        throw new Error("snapshot contains an invalid observation timestamp");
      }
    }
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function percentile(values, quantile) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * quantile) - 1];
}

function roundPercent(ratio) {
  return Number((ratio * 100).toFixed(2));
}

function isoTime(value) {
  return value === undefined ? null : new Date(value).toISOString();
}

async function main() {
  const [inputPath, ...extraArguments] = process.argv.slice(2);
  if (inputPath === undefined || extraArguments.length > 0) {
    throw new Error(
      "Usage: npm run audit:rth-shadow -- <local-stage-b-snapshot.json>",
    );
  }
  const snapshot = JSON.parse(await readFile(inputPath, "utf8"));
  console.log(JSON.stringify(summarizeRthShadowAcquisition(snapshot), null, 2));
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
