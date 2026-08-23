const nonStandardSessionCache = new Map<number, ReadonlySet<string>>();

/**
 * Return whether a date is a full 09:30-16:00 US equity core session.
 *
 * Hyperliquid can keep trading on exchange holidays and early-close dates, so
 * its candle completeness alone is not enough for an RTH-at-time baseline.
 */
export function isStandardUsEquityRthSession(dateKey: string): boolean {
  const date = parseDateKey(dateKey);
  if (date === null) {
    return false;
  }
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) {
    return false;
  }
  return !nonStandardSessionDates(date.getUTCFullYear()).has(dateKey);
}

function nonStandardSessionDates(year: number): ReadonlySet<string> {
  const cached = nonStandardSessionCache.get(year);
  if (cached !== undefined) {
    return cached;
  }

  const dates = new Set<string>();
  addDate(dates, observedFixedHoliday(year, 0, 1, false));
  addDate(dates, nthWeekdayOfMonth(year, 0, 1, 3));
  addDate(dates, nthWeekdayOfMonth(year, 1, 1, 3));
  addDate(dates, addUtcDays(calculateEasterSunday(year), -2));
  addDate(dates, lastWeekdayOfMonth(year, 4, 1));
  addDate(dates, observedFixedHoliday(year, 5, 19, true));
  addDate(dates, observedFixedHoliday(year, 6, 4, true));
  addDate(dates, nthWeekdayOfMonth(year, 8, 1, 1));
  const thanksgiving = nthWeekdayOfMonth(year, 10, 4, 4);
  addDate(dates, thanksgiving);
  addDate(dates, observedFixedHoliday(year, 11, 25, true));

  // Early closes are excluded rather than mixed into the 26-slot baseline.
  const julyThird = utcDate(year, 6, 3);
  if (isWeekday(julyThird)) {
    addDate(dates, julyThird);
  }
  addDate(dates, addUtcDays(thanksgiving, 1));
  const christmasEve = utcDate(year, 11, 24);
  if (
    christmasEve.getUTCDay() >= 1 &&
    christmasEve.getUTCDay() <= 4
  ) {
    addDate(dates, christmasEve);
  }

  nonStandardSessionCache.set(year, dates);
  return dates;
}

function observedFixedHoliday(
  year: number,
  monthIndex: number,
  day: number,
  observeSaturdayOnFriday: boolean,
): Date {
  const holiday = utcDate(year, monthIndex, day);
  if (holiday.getUTCDay() === 0) {
    return addUtcDays(holiday, 1);
  }
  if (holiday.getUTCDay() === 6 && observeSaturdayOnFriday) {
    return addUtcDays(holiday, -1);
  }
  return holiday;
}

function nthWeekdayOfMonth(
  year: number,
  monthIndex: number,
  weekday: number,
  occurrence: number,
): Date {
  const first = utcDate(year, monthIndex, 1);
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return utcDate(year, monthIndex, 1 + offset + (occurrence - 1) * 7);
}

function lastWeekdayOfMonth(
  year: number,
  monthIndex: number,
  weekday: number,
): Date {
  const last = utcDate(year, monthIndex + 1, 0);
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return addUtcDays(last, -offset);
}

function calculateEasterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month - 1, day);
}

function parseDateKey(dateKey: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    return null;
  }
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || formatDateKey(date) !== dateKey
    ? null
    : date;
}

function utcDate(year: number, monthIndex: number, day: number): Date {
  return new Date(Date.UTC(year, monthIndex, day));
}

function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1_000);
}

function isWeekday(date: Date): boolean {
  return date.getUTCDay() >= 1 && date.getUTCDay() <= 5;
}

function addDate(dates: Set<string>, date: Date): void {
  dates.add(formatDateKey(date));
}

function formatDateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}
