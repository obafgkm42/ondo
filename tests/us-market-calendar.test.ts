import { describe, expect, it } from "vitest";

import { isStandardUsEquityRthSession } from "../src/us-market-calendar";

describe("isStandardUsEquityRthSession", () => {
  it("excludes NYSE holidays across fixed and calculated rules", () => {
    expect(isStandardUsEquityRthSession("2026-01-19")).toBe(false);
    expect(isStandardUsEquityRthSession("2026-04-03")).toBe(false);
    expect(isStandardUsEquityRthSession("2026-07-03")).toBe(false);
    expect(isStandardUsEquityRthSession("2027-12-24")).toBe(false);
    expect(isStandardUsEquityRthSession("2028-01-03")).toBe(true);
  });

  it("excludes official early-close dates from full-session history", () => {
    expect(isStandardUsEquityRthSession("2025-07-03")).toBe(false);
    expect(isStandardUsEquityRthSession("2026-11-27")).toBe(false);
    expect(isStandardUsEquityRthSession("2026-12-24")).toBe(false);
    expect(isStandardUsEquityRthSession("2028-07-03")).toBe(false);
  });

  it("accepts an ordinary weekday and rejects weekends or invalid dates", () => {
    expect(isStandardUsEquityRthSession("2026-06-23")).toBe(true);
    expect(isStandardUsEquityRthSession("2026-06-21")).toBe(false);
    expect(isStandardUsEquityRthSession("2026-02-30")).toBe(false);
  });
});
