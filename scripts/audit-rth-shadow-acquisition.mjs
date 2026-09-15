#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const EXPECTED_OBSERVATIONS_PER_FULL_SESSION = 78;
const EXPECTED_MEASUREMENT_VERSION = "market-fragility-price-only/v1";

/** Build a data-minimizing operational summary from one local KV snapshot. */
export function summarizeRthShadowAcquisition(value, expectedSessionKeys = []) {
  assertSnapshot(value);
  assertExpectedSessionKeys(expectedSessionKeys);
  const seenTimestamps = new Set();
  let duplicateTimestampCount = 0;
  let outOfOrderCount = 0;
  let unexpectedIntervalCount = 0;

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
    }

    const observed = session.observations.length;
    const uniqueObserved = new Set(
      session.observations.map((observation) => observation.candleEndTime),
    ).size;
    return {
      sessionKey: session.sessionKey,
      observed,
      uniqueObserved,
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
    acquisitionDelayMs: summarizeAcquisitionDelays(
      value.sessions.flatMap((session) => session.observations),
    ),
    pilotWindow: buildPilotWindow(
      value.sessions,
      sessions,
      expectedSessionKeys,
    ),
    sessions,
  };
}

function buildPilotWindow(storedSessions, sessions, expectedSessionKeys) {
  if (expectedSessionKeys.length === 0) {
    return null;
  }
  const sessionsByKey = new Map(
    sessions.map((session) => [session.sessionKey, session]),
  );
  const observedUniqueObservationCount = expectedSessionKeys.reduce(
    (total, sessionKey) =>
      total + Math.min(
        sessionsByKey.get(sessionKey)?.uniqueObserved ?? 0,
        EXPECTED_OBSERVATIONS_PER_FULL_SESSION,
      ),
    0,
  );
  const expectedObservationCount =
    expectedSessionKeys.length * EXPECTED_OBSERVATIONS_PER_FULL_SESSION;
  const expectedKeySet = new Set(expectedSessionKeys);
  const expectedSessions = sessions.filter((session) =>
    expectedKeySet.has(session.sessionKey)
  );
  const acquisitionDelayMs = summarizeAcquisitionDelays(
    storedSessions
      .filter((session) => expectedKeySet.has(session.sessionKey))
      .flatMap((session) => session.observations),
  );
  const timestampAnomalyCount = expectedSessions.reduce(
    (total, session) =>
      total + session.duplicateTimestampCount + session.outOfOrderCount +
        session.unexpectedIntervalCount,
    0,
  );
  const capturePercent = roundPercent(
    observedUniqueObservationCount / expectedObservationCount,
  );
  const criteria = {
    hasTenSessionWindow: expectedSessionKeys.length >= 10,
    captureAtLeast99Percent: capturePercent >= 99,
    p95DelayAtMost60Seconds:
      acquisitionDelayMs.p95 !== null && acquisitionDelayMs.p95 <= 60_000,
    hasNoTimestampAnomalies:
      timestampAnomalyCount === 0 && acquisitionDelayMs.negativeCount === 0,
  };
  return {
    expectedSessionCount: expectedSessionKeys.length,
    expectedObservationCount,
    observedUniqueObservationCount,
    capturePercent,
    missingSessionKeys: expectedSessionKeys.filter(
      (sessionKey) => !sessionsByKey.has(sessionKey),
    ),
    unexpectedSessionKeys: sessions
      .map((session) => session.sessionKey)
      .filter((sessionKey) => !expectedKeySet.has(sessionKey)),
    acquisitionDelayMs,
    timestampAnomalyCount,
    acquisitionGate: {
      status: !criteria.hasTenSessionWindow
        ? "pending"
        : Object.values(criteria).every(Boolean) ? "pass" : "fail",
      criteria,
      notAssessed: [
        "provider_request_budget",
        "provider_429s",
        "duplicate_notifications",
        "worker_resource_usage",
      ],
    },
  };
}

function summarizeAcquisitionDelays(observations) {
  const delays = observations
    .map((observation) => observation.acquiredAt - observation.candleEndTime)
    .filter((delay) => delay >= 0);
  return {
    validSampleCount: delays.length,
    negativeCount: observations.length - delays.length,
    p50: percentile(delays, 0.5),
    p95: percentile(delays, 0.95),
    max: delays.length === 0 ? null : Math.max(...delays),
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
      !isIsoDateKey(session.sessionKey) ||
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

function assertExpectedSessionKeys(value) {
  if (
    !Array.isArray(value) ||
    value.some((sessionKey) => !isIsoDateKey(sessionKey)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("expected sessions must be unique YYYY-MM-DD strings");
  }
}

function isIsoDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
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
  const [inputPath, expectedSessionsPath, ...extraArguments] =
    process.argv.slice(2);
  if (inputPath === undefined || extraArguments.length > 0) {
    throw new Error(
      "Usage: npm run audit:rth-shadow -- <snapshot.json> " +
        "[expected-sessions.json]",
    );
  }
  const snapshot = JSON.parse(await readFile(inputPath, "utf8"));
  const expectedSessionKeys = expectedSessionsPath === undefined
    ? []
    : JSON.parse(await readFile(expectedSessionsPath, "utf8"));
  console.log(
    JSON.stringify(
      summarizeRthShadowAcquisition(snapshot, expectedSessionKeys),
      null,
      2,
    ),
  );
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
