import type {
  Candle,
  MarketActivityBurstLevel,
  MarketActivityConfidence,
  MarketActivityDataQuality,
  MarketActivityLevel,
  MarketActivityPercentileBand,
  MarketActivitySession,
  MarketActivitySnapshot,
} from "./types";
import { isStandardUsEquityRthSession } from "./us-market-calendar";

export const MARKET_ACTIVITY_INTERVAL_MINUTES = 15 as const;
export const MARKET_ACTIVITY_SLOT_COUNT = 26;
export const MARKET_ACTIVITY_BASELINE_SESSIONS = 10;
export const MARKET_ACTIVITY_MAX_HISTORY_SESSIONS = 60;

const EASTERN_TIME_ZONE = "America/New_York";
const RTH_START_MINUTE = 9 * 60 + 30;
const RTH_END_MINUTE = 16 * 60;
const MINIMUM_PROVISIONAL_SESSIONS = 5;
const MINIMUM_PERCENTILE_SESSIONS = 20;
const MINIMUM_COMPLETED_FORMING_SLOTS = 2;
const BORDERLINE_DISTANCE = 0.05;
const DEADWATER_UPPER_BOUND = 0.65;
const QUIET_UPPER_BOUND = 0.85;
const NORMAL_UPPER_BOUND = 1.2;
const ACTIVE_UPPER_BOUND = 1.6;
const ELEVATED_BAR_RVOL = 1.5;
const BURST_BAR_RVOL = 2;
const EASTERN_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

interface EasternTimeParts {
  dateKey: string;
  weekday: string;
  minuteOfDay: number;
}

interface SlotCandle {
  candle: Candle;
  position: number;
}

/** One RTH session assembled from provider candles before completeness checks. */
export interface RthVolumeSession {
  sessionKey: string;
  slotVolumes: Array<number | null>;
  slotEndTimes: Array<number | null>;
}

/**
 * Aggregate aligned five- or fifteen-minute candles into 26 RTH volume slots.
 *
 * Five-minute slots require exactly three contiguous candles. Missing candles
 * remain null so data gaps cannot be mistaken for low market activity.
 */
export function aggregateRthVolumeSessions(
  candles: readonly Candle[],
  sourceIntervalMinutes: 5 | 15,
): RthVolumeSession[] {
  const groupedSessions = new Map<string, Map<number, SlotCandle[]>>();
  const intervalMilliseconds = sourceIntervalMinutes * 60 * 1_000;

  for (const candle of candles) {
    if (!isUsableCandle(candle, intervalMilliseconds)) {
      continue;
    }
    const eastern = getEasternTimeParts(new Date(candle.startTime));
    if (
      eastern.weekday === "Sat" ||
      eastern.weekday === "Sun" ||
      !isStandardUsEquityRthSession(eastern.dateKey) ||
      eastern.minuteOfDay < RTH_START_MINUTE ||
      eastern.minuteOfDay >= RTH_END_MINUTE
    ) {
      continue;
    }
    const minuteOffset = eastern.minuteOfDay - RTH_START_MINUTE;
    if (minuteOffset % sourceIntervalMinutes !== 0) {
      continue;
    }
    const slotIndex = Math.floor(
      minuteOffset / MARKET_ACTIVITY_INTERVAL_MINUTES,
    );
    if (slotIndex < 0 || slotIndex >= MARKET_ACTIVITY_SLOT_COUNT) {
      continue;
    }
    const position = Math.floor(
      (minuteOffset % MARKET_ACTIVITY_INTERVAL_MINUTES) /
        sourceIntervalMinutes,
    );
    const sessionSlots = groupedSessions.get(eastern.dateKey) ?? new Map();
    const slotCandles = sessionSlots.get(slotIndex) ?? [];
    slotCandles.push({ candle, position });
    sessionSlots.set(slotIndex, slotCandles);
    groupedSessions.set(eastern.dateKey, sessionSlots);
  }

  return [...groupedSessions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sessionKey, slots]) => {
      const slotVolumes: Array<number | null> = Array(
        MARKET_ACTIVITY_SLOT_COUNT,
      ).fill(null);
      const slotEndTimes: Array<number | null> = Array(
        MARKET_ACTIVITY_SLOT_COUNT,
      ).fill(null);
      for (const [slotIndex, slotCandles] of slots) {
        const aggregate = aggregateCompleteSlot(
          slotCandles,
          sourceIntervalMinutes,
        );
        if (aggregate !== null) {
          slotVolumes[slotIndex] = aggregate.volume;
          slotEndTimes[slotIndex] = aggregate.endTime;
        }
      }
      return { sessionKey, slotVolumes, slotEndTimes };
    });
}

/** Convert only complete 26-slot sessions into durable history entries. */
export function completedMarketActivitySessions(
  sessions: readonly RthVolumeSession[],
): MarketActivitySession[] {
  return sessions.flatMap((session) => {
    if (!session.slotVolumes.every(isNonNegativeFiniteNumber)) {
      return [];
    }
    return [
      {
        sessionKey: session.sessionKey,
        slotVolumes: session.slotVolumes.map((volume) => Number(volume)),
      },
    ];
  });
}

/** Select the New York calendar-date session for a live or post-close query. */
export function selectCurrentRthVolumeSession(
  sessions: readonly RthVolumeSession[],
  timestamp: Date,
): RthVolumeSession | null {
  const sessionKey = getEasternTimeParts(timestamp).dateKey;
  return sessions.find((session) => session.sessionKey === sessionKey) ?? null;
}

/**
 * Compare the current cumulative RTH volume with the same time in history.
 *
 * The current session is always excluded from both the rolling mean and the
 * percentile population, preventing a completed close from entering its own
 * denominator.
 */
export function calculateMarketActivitySnapshot(
  market: string,
  currentSession: RthVolumeSession | null,
  history: readonly MarketActivitySession[],
  evaluatedAt: Date,
): MarketActivitySnapshot {
  const eligibleHistory = [...history]
    .filter(
      (session) =>
        session.sessionKey !== currentSession?.sessionKey &&
        isCompleteStoredSession(session),
    )
    .sort((left, right) => left.sessionKey.localeCompare(right.sessionKey))
    .slice(-MARKET_ACTIVITY_MAX_HISTORY_SESSIONS);
  const sampleSessions = eligibleHistory.length;
  const dataQuality = classifyDataQuality(sampleSessions);
  const latestSlotIndex = findLatestContiguousSlot(currentSession);

  if (currentSession !== null && hasCompletedSlotGap(currentSession)) {
    return unavailableSnapshot(
      market,
      currentSession.sessionKey,
      sampleSessions,
      dataQuality,
      evaluatedAt.getTime(),
      "UNKNOWN",
    );
  }

  if (currentSession === null || latestSlotIndex === null) {
    return unavailableSnapshot(
      market,
      currentSession?.sessionKey ?? null,
      sampleSessions,
      dataQuality,
      evaluatedAt.getTime(),
      currentSession === null ? "UNKNOWN" : "FORMING",
    );
  }

  const asOf = currentSession.slotEndTimes[latestSlotIndex] ??
    evaluatedAt.getTime();
  if (latestSlotIndex + 1 < MINIMUM_COMPLETED_FORMING_SLOTS) {
    return unavailableSnapshot(
      market,
      currentSession.sessionKey,
      sampleSessions,
      dataQuality,
      asOf,
      "FORMING",
      latestSlotIndex,
    );
  }
  if (sampleSessions < MINIMUM_PROVISIONAL_SESSIONS) {
    return unavailableSnapshot(
      market,
      currentSession.sessionKey,
      sampleSessions,
      dataQuality,
      asOf,
      "UNKNOWN",
      latestSlotIndex,
    );
  }

  const baselineSessions = eligibleHistory.slice(
    -MARKET_ACTIVITY_BASELINE_SESSIONS,
  );
  const currentCumulativeVolume = cumulativeVolume(
    currentSession.slotVolumes,
    latestSlotIndex,
  );
  const historicalCumulativeVolumes = baselineSessions.map((session) =>
    cumulativeVolume(session.slotVolumes, latestSlotIndex)
  );
  const cumulativeBaseline = mean(historicalCumulativeVolumes);
  if (
    currentCumulativeVolume === null ||
    cumulativeBaseline === null ||
    cumulativeBaseline <= 0
  ) {
    return unavailableSnapshot(
      market,
      currentSession.sessionKey,
      sampleSessions,
      dataQuality,
      asOf,
      "UNKNOWN",
      latestSlotIndex,
    );
  }

  const sessionRvol = currentCumulativeVolume / cumulativeBaseline;
  const currentBarVolume = currentSession.slotVolumes[latestSlotIndex];
  const barBaseline = mean(
    baselineSessions.map((session) => session.slotVolumes[latestSlotIndex]),
  );
  const barRvol =
    currentBarVolume !== null &&
    currentBarVolume !== undefined &&
    barBaseline !== null &&
    barBaseline > 0
      ? currentBarVolume / barBaseline
      : null;
  const percentilePopulation = eligibleHistory.map((session) =>
    cumulativeVolume(session.slotVolumes, latestSlotIndex)
  ).filter((volume): volume is number => volume !== null);
  const percentile =
    percentilePopulation.length >= MINIMUM_PERCENTILE_SESSIONS
      ? percentileRank(currentCumulativeVolume, percentilePopulation)
      : null;
  const percentileBand = percentile === null
    ? null
    : classifyPercentileBand(percentile);
  const level = classifyMarketActivityLevel(sessionRvol);

  return {
    market,
    sessionKey: currentSession.sessionKey,
    level,
    sessionRvol,
    barRvol,
    barActivity: classifyBarActivity(barRvol),
    percentile,
    percentileBand,
    sampleSessions,
    confidence: classifyConfidence(
      level,
      sessionRvol,
      percentileBand,
      sampleSessions,
    ),
    dataQuality,
    currentSlotIndex: latestSlotIndex,
    asOf,
    source: "hyperliquid",
  };
}

/** Apply the fixed five-level cumulative RVOL classification. */
export function classifyMarketActivityLevel(
  sessionRvol: number,
): Exclude<MarketActivityLevel, "FORMING" | "UNKNOWN"> {
  if (sessionRvol < DEADWATER_UPPER_BOUND) {
    return "DEADWATER";
  }
  if (sessionRvol < QUIET_UPPER_BOUND) {
    return "QUIET";
  }
  if (sessionRvol < NORMAL_UPPER_BOUND) {
    return "NORMAL";
  }
  return sessionRvol < ACTIVE_UPPER_BOUND ? "ACTIVE" : "SURGE";
}

/** Return whether a scheduled scan reached a new completed 15-minute slot. */
export function isMarketActivityEvaluationTime(timestamp: Date): boolean {
  const eastern = getEasternTimeParts(timestamp);
  return (
    eastern.weekday !== "Sat" &&
    eastern.weekday !== "Sun" &&
    eastern.minuteOfDay >= RTH_START_MINUTE + MARKET_ACTIVITY_INTERVAL_MINUTES &&
    eastern.minuteOfDay <= RTH_END_MINUTE &&
    (eastern.minuteOfDay - RTH_START_MINUTE) %
        MARKET_ACTIVITY_INTERVAL_MINUTES ===
      0
  );
}

/** Restrict automatic history bootstrap work to the first post-close hour. */
export function isMarketActivityBootstrapTime(timestamp: Date): boolean {
  const eastern = getEasternTimeParts(timestamp);
  return (
    eastern.weekday !== "Sat" &&
    eastern.weekday !== "Sun" &&
    eastern.minuteOfDay > RTH_END_MINUTE &&
    eastern.minuteOfDay < RTH_END_MINUTE + 60
  );
}

function aggregateCompleteSlot(
  slotCandles: readonly SlotCandle[],
  sourceIntervalMinutes: 5 | 15,
): { volume: number; endTime: number } | null {
  const expectedCount = MARKET_ACTIVITY_INTERVAL_MINUTES /
    sourceIntervalMinutes;
  if (slotCandles.length !== expectedCount) {
    return null;
  }
  const ordered = [...slotCandles].sort(
    (left, right) => left.position - right.position,
  );
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    if (entry === undefined || entry.position !== index) {
      return null;
    }
    const previous = ordered[index - 1];
    if (
      previous !== undefined &&
      entry.candle.startTime !==
        previous.candle.startTime + sourceIntervalMinutes * 60 * 1_000
    ) {
      return null;
    }
  }
  const lastCandle = ordered.at(-1)?.candle;
  if (lastCandle === undefined) {
    return null;
  }
  return {
    volume: ordered.reduce((total, entry) => total + entry.candle.volume, 0),
    endTime: lastCandle.endTime,
  };
}

function findLatestContiguousSlot(
  session: RthVolumeSession | null,
): number | null {
  if (session === null) {
    return null;
  }
  let latestSlotIndex = -1;
  for (const [index, volume] of session.slotVolumes.entries()) {
    if (volume === null) {
      return latestSlotIndex < 0 ? null : latestSlotIndex;
    }
    latestSlotIndex = index;
  }
  return latestSlotIndex < 0 ? null : latestSlotIndex;
}

function hasCompletedSlotGap(session: RthVolumeSession): boolean {
  let foundMissingSlot = false;
  for (const volume of session.slotVolumes) {
    if (volume === null) {
      foundMissingSlot = true;
    } else if (foundMissingSlot) {
      return true;
    }
  }
  return false;
}

function cumulativeVolume(
  slotVolumes: readonly (number | null | undefined)[],
  throughSlotIndex: number,
): number | null {
  let total = 0;
  for (let index = 0; index <= throughSlotIndex; index += 1) {
    const volume = slotVolumes[index];
    if (!isNonNegativeFiniteNumber(volume)) {
      return null;
    }
    total += volume;
  }
  return total;
}

function mean(values: readonly (number | null | undefined)[]): number | null {
  if (values.length === 0 || !values.every(isFiniteNumber)) {
    return null;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentileRank(value: number, population: readonly number[]): number {
  let lowerCount = 0;
  let equalCount = 0;
  for (const observation of population) {
    if (observation < value) {
      lowerCount += 1;
    } else if (observation === value) {
      equalCount += 1;
    }
  }
  return ((lowerCount + equalCount * 0.5) / population.length) * 100;
}

function classifyPercentileBand(
  percentile: number,
): MarketActivityPercentileBand {
  if (percentile <= 10) {
    return "extreme_low";
  }
  if (percentile <= 25) {
    return "low";
  }
  if (percentile < 75) {
    return "typical";
  }
  return percentile < 90 ? "high" : "extreme_high";
}

function classifyBarActivity(
  barRvol: number | null,
): MarketActivityBurstLevel | null {
  if (barRvol === null) {
    return null;
  }
  if (barRvol >= BURST_BAR_RVOL) {
    return "burst";
  }
  return barRvol >= ELEVATED_BAR_RVOL ? "elevated" : "ordinary";
}

function classifyDataQuality(
  sampleSessions: number,
): MarketActivityDataQuality {
  if (sampleSessions < MINIMUM_PROVISIONAL_SESSIONS) {
    return "insufficient";
  }
  if (sampleSessions < MARKET_ACTIVITY_BASELINE_SESSIONS) {
    return "provisional";
  }
  if (sampleSessions < 30) {
    return "limited";
  }
  return sampleSessions < MARKET_ACTIVITY_MAX_HISTORY_SESSIONS
    ? "good"
    : "full";
}

function classifyConfidence(
  level: Exclude<MarketActivityLevel, "FORMING" | "UNKNOWN">,
  sessionRvol: number,
  percentileBand: MarketActivityPercentileBand | null,
  sampleSessions: number,
): MarketActivityConfidence {
  if (sampleSessions < MARKET_ACTIVITY_BASELINE_SESSIONS) {
    return "provisional";
  }
  if (
    [
      DEADWATER_UPPER_BOUND,
      QUIET_UPPER_BOUND,
      NORMAL_UPPER_BOUND,
      ACTIVE_UPPER_BOUND,
    ].some((boundary) => Math.abs(sessionRvol - boundary) <= BORDERLINE_DISTANCE)
  ) {
    return "borderline";
  }
  if (percentileBand === null) {
    return "provisional";
  }
  const factorDirection =
    level === "DEADWATER" || level === "QUIET"
      ? "low"
      : level === "NORMAL"
        ? "typical"
        : "high";
  const percentileDirection =
    percentileBand === "extreme_low" || percentileBand === "low"
      ? "low"
      : percentileBand === "typical"
        ? "typical"
        : "high";
  return factorDirection === percentileDirection ? "confirmed" : "mixed";
}

function unavailableSnapshot(
  market: string,
  sessionKey: string | null,
  sampleSessions: number,
  dataQuality: MarketActivityDataQuality,
  asOf: number,
  level: "FORMING" | "UNKNOWN",
  currentSlotIndex: number | null = null,
): MarketActivitySnapshot {
  return {
    market,
    sessionKey,
    level,
    sessionRvol: null,
    barRvol: null,
    barActivity: null,
    percentile: null,
    percentileBand: null,
    sampleSessions,
    confidence: level === "FORMING" ? "provisional" : "unavailable",
    dataQuality,
    currentSlotIndex,
    asOf,
    source: "hyperliquid",
  };
}

function isCompleteStoredSession(session: MarketActivitySession): boolean {
  return (
    isStandardUsEquityRthSession(session.sessionKey) &&
    session.slotVolumes.length === MARKET_ACTIVITY_SLOT_COUNT &&
    session.slotVolumes.every(isNonNegativeFiniteNumber)
  );
}

function isUsableCandle(
  candle: Candle,
  expectedIntervalMilliseconds: number,
): boolean {
  const duration = candle.endTime - candle.startTime + 1;
  return (
    candle.startTime % 60_000 === 0 &&
    Math.abs(duration - expectedIntervalMilliseconds) <= 1 &&
    isNonNegativeFiniteNumber(candle.volume)
  );
}

function getEasternTimeParts(timestamp: Date): EasternTimeParts {
  const values: Record<string, string> = {};
  for (const part of EASTERN_TIME_FORMATTER.formatToParts(timestamp)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }
  return {
    dateKey: `${values.year}-${values.month}-${values.day}`,
    weekday: values.weekday ?? "",
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}
