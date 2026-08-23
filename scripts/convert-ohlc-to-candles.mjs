#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = await readFile(options.input, "utf8");
  const rows = raw
    .split(/\r?\n/)
    .map((line) => splitLine(line, options.delimiter))
    .filter((row) => row.some((value) => value.trim().length > 0));
  const header = rows[0]?.map(normalizeHeader) ?? [];
  const records = rows.slice(options.hasHeader ? 1 : 0);
  const candles = records.flatMap((row) => rowToCandle(row, header, options));

  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(candles)}\n`, "utf8");

  console.log(`Input rows: ${records.length}`);
  console.log(`Candles: ${candles.length}`);
  console.log(`Output: ${options.output}`);
  if (candles.length > 0) {
    console.log(`Range: ${new Date(candles[0].endTime).toISOString()} to ${new Date(candles.at(-1).endTime).toISOString()}`);
  }
}

function rowToCandle(row, header, options) {
  const date = cell(row, header, options.dateColumn);
  const time = cell(row, header, options.timeColumn);
  const open = numberCell(row, header, options.openColumn);
  const high = numberCell(row, header, options.highColumn);
  const low = numberCell(row, header, options.lowColumn);
  const close = numberCell(row, header, options.closeColumn);
  const volume = options.volumeColumn === undefined
    ? 0
    : numberCell(row, header, options.volumeColumn) ?? 0;

  if (
    date === undefined ||
    open === null ||
    high === null ||
    low === null ||
    close === null
  ) {
    return [];
  }

  const startTime = parseDateTime(
    date,
    time,
    options.dateFormat,
    options.timeZoneOffsetMinutes,
    options.timeZone,
  );
  if (startTime === null) {
    return [];
  }

  return [
    {
      startTime,
      endTime: startTime + options.intervalMinutes * 60_000 - 1,
      open,
      high,
      low,
      close,
      volume,
      tradeCount: 0,
    },
  ];
}

export function parseDateTime(
  dateValue,
  timeValue,
  dateFormat,
  timeZoneOffsetMinutes,
  timeZone,
) {
  if (dateFormat === "yyyy-mm-dd hh:mm:ss") {
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(dateValue);
    if (match === null) {
      return null;
    }

    return localDateTimeToUtc(
      {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6] ?? 0),
      },
      timeZoneOffsetMinutes,
      timeZone,
    );
  }

  const dateParts = parseDate(dateValue, dateFormat);
  if (dateParts === null) {
    return null;
  }

  const [hour, minute, second] = parseTime(timeValue ?? "00:00");
  return localDateTimeToUtc(
    {
      year: dateParts.year,
      month: dateParts.month,
      day: dateParts.day,
      hour,
      minute,
      second,
    },
    timeZoneOffsetMinutes,
    timeZone,
  );
}

function localDateTimeToUtc(parts, timeZoneOffsetMinutes, timeZone) {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  if (timeZone === undefined) {
    return localAsUtc - timeZoneOffsetMinutes * 60_000;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let candidate = localAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const displayed = Object.fromEntries(
      formatter
        .formatToParts(candidate)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, Number(part.value)]),
    );
    const displayedAsUtc = Date.UTC(
      displayed.year,
      displayed.month - 1,
      displayed.day,
      displayed.hour,
      displayed.minute,
      displayed.second,
    );
    const adjustment = localAsUtc - displayedAsUtc;
    candidate += adjustment;
    if (adjustment === 0) {
      return candidate;
    }
  }
  return candidate;
}

function parseDate(value, format) {
  if (format === "yyyy-mm-dd") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match === null ? null : {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
    };
  }

  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (match !== null && format === "mm/dd/yyyy") {
    return {
      year: Number(match[3]),
      month: Number(match[1]),
      day: Number(match[2]),
    };
  }

  return match === null ? null : {
    year: Number(match[3]),
    month: Number(match[2]),
    day: Number(match[1]),
  };
}

function parseTime(value) {
  const parts = value.split(":").map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function cell(row, header, column) {
  const index = columnIndex(header, column);
  const value = row[index]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function numberCell(row, header, column) {
  const value = cell(row, header, column);
  if (value === undefined) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function columnIndex(header, column) {
  const directIndex = Number(column);
  if (Number.isInteger(directIndex)) {
    return directIndex;
  }

  return header.indexOf(normalizeHeader(column));
}

function splitLine(line, delimiter) {
  return line.split(delimiter);
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

  const timeZone = values.get("timezone");
  if (timeZone !== undefined && values.has("timezone-offset-minutes")) {
    throw new Error("Use either --timezone or --timezone-offset-minutes, not both");
  }
  if (timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    } catch {
      throw new Error(`Invalid IANA timezone: ${timeZone}`);
    }
  }

  return {
    input: required(values, "input"),
    output: required(values, "output"),
    delimiter: values.get("delimiter") ?? ",",
    hasHeader: values.get("header") !== "false",
    dateColumn: values.get("date-column") ?? "date",
    timeColumn: values.get("time-column") ?? "time",
    openColumn: values.get("open-column") ?? "open",
    highColumn: values.get("high-column") ?? "high",
    lowColumn: values.get("low-column") ?? "low",
    closeColumn: values.get("close-column") ?? "close",
    volumeColumn: values.get("volume-column"),
    intervalMinutes: positiveInteger(values.get("interval-minutes"), "interval-minutes"),
    dateFormat: values.get("date-format") ?? "dd/mm/yyyy",
    timeZoneOffsetMinutes: integer(values.get("timezone-offset-minutes") ?? "0", "timezone-offset-minutes"),
    timeZone,
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

function integer(rawValue, name) {
  const value = Number(rawValue);
  if (!Number.isInteger(value)) {
    throw new Error(`--${name} must be an integer`);
  }
  return value;
}

function normalizeHeader(value) {
  return value.trim().toLowerCase().replaceAll(" ", "_");
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
