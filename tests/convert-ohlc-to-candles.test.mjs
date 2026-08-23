import { describe, expect, it } from "vitest";

import { parseDateTime } from "../scripts/convert-ohlc-to-candles.mjs";

describe("convert OHLC timestamps", () => {
  it("uses IANA timezone rules across Central Time daylight saving changes", () => {
    const winter = parseDateTime(
      "2025-01-06 08:30:00",
      undefined,
      "yyyy-mm-dd hh:mm:ss",
      0,
      "America/Chicago",
    );
    const summer = parseDateTime(
      "2025-07-07 08:30:00",
      undefined,
      "yyyy-mm-dd hh:mm:ss",
      0,
      "America/Chicago",
    );

    expect(new Date(winter).toISOString()).toBe("2025-01-06T14:30:00.000Z");
    expect(new Date(summer).toISOString()).toBe("2025-07-07T13:30:00.000Z");
  });
});
