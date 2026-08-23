import type { Candle, ScannerConfig } from "./types";
import { isStandardUsEquityRthSession } from "./us-market-calendar";

const EASTERN_TIME_ZONE = "America/New_York";
const CRON_INTERVAL_MINUTES = 5;
const MINUTES_PER_DAY = 24 * 60;
const FINAL_HOUR_START_MINUTE = 15 * 60;
const FINAL_HOUR_END_MINUTE = 16 * 60;
const RTH_START_MINUTE = 9 * 60 + 30;
const RTH_END_MINUTE = 16 * 60;
const TWO_HOUR_CHECKPOINT_LAST_START_MINUTE = 14 * 60;
const EASTERN_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: EASTERN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
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

export interface ScheduleDecision {
  shouldRun: boolean;
  intervalMinutes: number;
  reason: string;
}

export type AnalysisSessionKind = "rth" | "overnight";

export interface AnalysisSession {
  candles: Candle[];
  kind: AnalysisSessionKind;
  notificationsEnabled: boolean;
}

/**
 * Decide whether a five-minute Cron invocation should perform a scan.
 *
 * Hyperliquid's SP500 market is available beyond cash SPX hours, so scans are
 * no longer blocked by weekends or RTH. The New York final-hour check only
 * keeps the user's preferred faster cadence near the cash-market close.
 */
export function getScheduleDecision(
  timestamp: Date,
  config: Pick<
    ScannerConfig,
    "regularScanMinutes" | "finalHourScanMinutes"
  >,
): ScheduleDecision {
  const eastern = getEasternTimeParts(timestamp);
  const isCashFinalHour =
    isStandardUsEquityRthSession(eastern.dateKey) &&
    eastern.minuteOfDay >= FINAL_HOUR_START_MINUTE &&
    eastern.minuteOfDay < FINAL_HOUR_END_MINUTE;
  const intervalMinutes = isCashFinalHour
    ? config.finalHourScanMinutes
    : config.regularScanMinutes;
  return {
    shouldRun: eastern.minuteOfDay % intervalMinutes === 0,
    intervalMinutes,
    reason: `24/7 Hyperliquid ${intervalMinutes}-minute cadence`,
  };
}

/**
 * Find the prior Cron boundary that passed the scanner cadence gate.
 *
 * Walking the actual five-minute Cron ticks handles both sides of the
 * 15-minute/5-minute final-hour transition without overlapping analysis
 * windows or leaving candles between them.
 */
export function getPreviousScanTime(
  timestamp: Date,
  config: Pick<
    ScannerConfig,
    "regularScanMinutes" | "finalHourScanMinutes"
  >,
): Date {
  for (
    let minutesAgo = CRON_INTERVAL_MINUTES;
    minutesAgo <= MINUTES_PER_DAY;
    minutesAgo += CRON_INTERVAL_MINUTES
  ) {
    const candidate = new Date(
      timestamp.getTime() - minutesAgo * 60 * 1_000,
    );
    if (getScheduleDecision(candidate, config).shouldRun) {
      return candidate;
    }
  }

  throw new Error("unable to find a prior scanner cadence boundary");
}

/**
 * Keep non-standard cash-session briefs quieter while the perpetual market
 * remains available. This includes weekends, exchange holidays, and official
 * early-close dates.
 */
export function getBriefIntervalMinutes(
  timestamp: Date,
  weekdayIntervalMinutes: number,
): number {
  const { dateKey } = getEasternTimeParts(timestamp);
  return isStandardUsEquityRthSession(dateKey)
    ? weekdayIntervalMinutes
    : Math.max(weekdayIntervalMinutes, 60);
}

/**
 * Identify the existing five-minute boundary used for the cash-session close.
 */
export function isRthClose(timestamp: Date): boolean {
  const eastern = getEasternTimeParts(timestamp);
  return (
    isStandardUsEquityRthSession(eastern.dateKey) &&
    eastern.minuteOfDay === RTH_END_MINUTE
  );
}

/** Return whether a full two-hour checkpoint fits before the RTH close. */
export function isTwoHourCheckpointEligible(timestamp: Date): boolean {
  const eastern = getEasternTimeParts(timestamp);
  return (
    isStandardUsEquityRthSession(eastern.dateKey) &&
    eastern.minuteOfDay <= TWO_HOUR_CHECKPOINT_LAST_START_MINUTE
  );
}

/**
 * Keep candles from the current New York date for a stable intraday baseline.
 * When no current-date candles are available, fall back to the fetched lookback
 * so overnight and weekend scans can still produce a Discord brief.
 */
export function filterCurrentSession(
  candles: readonly Candle[],
  timestamp: Date,
): Candle[] {
  const currentDateKey = getEasternDateKey(timestamp);
  const currentDateCandles = candles.filter(
    (candle) => getEasternDateKey(new Date(candle.startTime)) === currentDateKey,
  );
  return currentDateCandles.length > 0 ? currentDateCandles : [...candles];
}

/**
 * Select a stable analysis session for the live perpetual market.
 *
 * RTH signals use the cash-market 09:30–16:00 New York anchor that is
 * available in the historical SPX proxy. Outside RTH, candles remain
 * available for status briefs, but notifications stay disabled until a
 * separately validated overnight policy exists.
 */
export function selectAnalysisSession(
  candles: readonly Candle[],
  timestamp: Date,
): AnalysisSession {
  const eastern = getEasternTimeParts(timestamp);
  const isRthEvaluation =
    isStandardUsEquityRthSession(eastern.dateKey) &&
    eastern.minuteOfDay >= RTH_START_MINUTE &&
    eastern.minuteOfDay <= RTH_END_MINUTE;

  if (isRthEvaluation) {
    const rthCandles = candles.filter((candle) => {
      const candleTime = getEasternTimeParts(new Date(candle.startTime));
      return (
        candleTime.dateKey === eastern.dateKey &&
        candleTime.minuteOfDay >= RTH_START_MINUTE &&
        candleTime.minuteOfDay < RTH_END_MINUTE
      );
    });
    return {
      candles: rthCandles,
      kind: "rth",
      notificationsEnabled: true,
    };
  }

  return {
    candles: selectOvernightCandles(candles),
    kind: "overnight",
    notificationsEnabled: false,
  };
}

function selectOvernightCandles(candles: readonly Candle[]): Candle[] {
  let boundaryIndex = -1;
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const candle = candles[index];
    if (candle === undefined) {
      continue;
    }
    const candleTime = getEasternTimeParts(new Date(candle.startTime));
    if (candleTime.minuteOfDay === RTH_END_MINUTE) {
      boundaryIndex = index;
      break;
    }
  }
  return boundaryIndex < 0
    ? [...candles]
    : candles.slice(boundaryIndex);
}

function getEasternTimeParts(timestamp: Date): EasternTimeParts {
  const parts = dateTimePartValues(EASTERN_TIME_FORMATTER, timestamp);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    minuteOfDay: hour * 60 + minute,
  };
}

function getEasternDateKey(timestamp: Date): string {
  const dateParts = dateTimePartValues(EASTERN_DATE_FORMATTER, timestamp);
  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

function dateTimePartValues(
  formatter: Intl.DateTimeFormat,
  timestamp: Date,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(timestamp)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }
  return values;
}
