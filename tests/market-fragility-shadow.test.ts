import { describe, expect, it } from "vitest";

import {
  buildMarketFragilityShadowObservation,
  mechanismFamily,
  recordMarketFragilityShadow,
  shadowStateKey,
} from "../src/market-fragility-shadow";
import type {
  MarketFragilityIndicatorId,
  MarketFragilityReferenceType,
  MarketFragilitySnapshot,
} from "../src/types";

describe("market fragility persistence shadow", () => {
  it("stores mechanism and family context without changing the v1 level", () => {
    const result = buildMarketFragilityShadowObservation(
      snapshot(3, [-0.01, -0.35, 0.25, 2, 0.7, -0.0075]),
      1,
      6000,
      undefined,
    );

    expect(result).toMatchObject({
      timestamp: 1,
      price: 6000,
      v1Level: "breaking",
      breakingStatus: "PENDING",
      transition: "NEW_BREAK",
      stressedIndicatorIds: [
        "session_loss",
        "vwap_repair_failure",
        "poor_close_location",
      ],
      stressedFamilyIds: ["price_damage", "repair_failure"],
      mechanismHistoryAvailable: true,
    });
    expect(result).not.toHaveProperty("indicatorValues");
  });

  it("marks the first v1 breaking brief pending and the next one confirmed", async () => {
    const state = memoryKv();
    const first = await recordMarketFragilityShadow(
      state,
      "xyz:SP500",
      "2026-08-11",
      1,
      6000,
      snapshot(3),
    );
    const second = await recordMarketFragilityShadow(
      state,
      "xyz:SP500",
      "2026-08-11",
      2,
      5990,
      snapshot(3),
    );

    expect(first.observation).toMatchObject({
      v1Level: "breaking",
      breakingStreak: 1,
      breakingStatus: "PENDING",
    });
    expect(second.observation).toMatchObject({
      v1Level: "breaking",
      breakingStreak: 2,
      breakingStatus: "CONFIRMED",
      transition: "PERSISTENT",
    });
    expect(second.metrics).toMatchObject({
      pendingSessions: 1,
      confirmedSessions: 1,
      confirmationRate: 1,
    });
  });

  it("breaks confirmation when an expected brief is missing", () => {
    const startedAt = Date.parse("2026-08-11T14:00:00Z");
    const first = buildMarketFragilityShadowObservation(
      snapshotWithStressedIds([
        "session_loss",
        "vwap_repair_failure",
        "mega_cap_breadth",
      ]),
      startedAt,
      6000,
      undefined,
    );
    const second = buildMarketFragilityShadowObservation(
      snapshotWithStressedIds([
        "session_loss",
        "vwap_repair_failure",
        "mega_cap_breadth",
        "equity_cross_confirmation",
      ]),
      startedAt + 45 * 60_000,
      5960,
      first,
    );

    expect(second).toMatchObject({
      breakingStatus: "PENDING",
      breakingStreak: 1,
      breakingStartedAt: startedAt + 45 * 60_000,
      breakingElapsedMinutes: 0,
      breakingObservedDurationMinutes: 0,
      continuousFromPrevious: false,
      continuityBreakReason: "missing_expected_brief",
      transition: "NON_COMPARABLE",
      persistentIndicatorIds: [
        "session_loss",
        "vwap_repair_failure",
        "mega_cap_breadth",
      ],
      addedIndicatorIds: ["equity_cross_confirmation"],
      recoveredIndicatorIds: [],
      stressedFamilyIds: [
        "price_damage",
        "repair_failure",
        "breadth",
        "cross_market_confirmation",
      ],
    });
  });

  it("separates continuously observed duration from wall-clock fields", () => {
    const startedAt = Date.parse("2026-08-11T14:00:00Z");
    const first = buildMarketFragilityShadowObservation(
      snapshot(3),
      startedAt,
      6000,
      undefined,
    );
    const second = buildMarketFragilityShadowObservation(
      snapshot(3),
      startedAt + 30 * 60_000,
      5990,
      first,
    );

    expect(second).toMatchObject({
      breakingStatus: "CONFIRMED",
      breakingStreak: 2,
      breakingElapsedMinutes: 30,
      breakingObservedDurationMinutes: 30,
      continuousFromPrevious: true,
      continuityBreakReason: null,
      transition: "PERSISTENT",
    });
  });

  it("does not report unavailable stressed indicators as recovered", () => {
    const full = buildMarketFragilityShadowObservation(
      snapshotWithStates({
        session_loss: "stressed",
        vwap_repair_failure: "stressed",
        poor_close_location: "stressed",
      }),
      1,
      6000,
      undefined,
    );
    const partial = buildMarketFragilityShadowObservation(
      snapshotWithStates({
        session_loss: "stressed",
        vwap_repair_failure: "unavailable",
        poor_close_location: "unavailable",
      }),
      2,
      6000,
      full,
    );
    const restored = buildMarketFragilityShadowObservation(
      snapshotWithStates({
        session_loss: "stressed",
        vwap_repair_failure: "stressed",
        poor_close_location: "stressed",
      }),
      3,
      6000,
      partial,
    );

    expect(partial).toMatchObject({
      v1Level: "resilient",
      availableIndicatorCount: 4,
      transition: "NON_COMPARABLE",
      recoveredIndicatorIds: [],
      lostCoverageIndicatorIds: [
        "vwap_repair_failure",
        "poor_close_location",
      ],
      breakingStatus: "BELOW_THRESHOLD",
    });
    expect(restored).toMatchObject({
      v1Level: "breaking",
      transition: "NON_COMPARABLE",
      addedIndicatorIds: [],
      recoveredIndicatorIds: [],
      gainedCoverageIndicatorIds: [
        "vwap_repair_failure",
        "poor_close_location",
      ],
      breakingStatus: "PENDING",
    });
  });

  it("records genuine stressed-to-healthy recovery over joint coverage", () => {
    const stressed = buildMarketFragilityShadowObservation(
      snapshotWithStates({ session_loss: "stressed" }),
      1,
      6000,
      undefined,
    );
    const healthy = buildMarketFragilityShadowObservation(
      snapshotWithStates({ session_loss: "healthy" }),
      2,
      6000,
      stressed,
    );

    expect(healthy).toMatchObject({
      coverageComparable: true,
      transition: "IMPROVING",
      recoveredIndicatorIds: ["session_loss"],
      lostCoverageIndicatorIds: [],
    });
  });

  it("keeps a genuine repair visible while labelling changed coverage", () => {
    const partial = buildMarketFragilityShadowObservation(
      snapshotWithStates({
        session_loss: "stressed",
        mega_cap_breadth: "unavailable",
      }),
      1,
      6000,
      undefined,
    );
    const full = buildMarketFragilityShadowObservation(
      snapshotWithStates({
        session_loss: "healthy",
        mega_cap_breadth: "healthy",
      }),
      2,
      6000,
      partial,
    );

    expect(full).toMatchObject({
      transition: "NON_COMPARABLE",
      recoveredIndicatorIds: ["session_loss"],
      gainedCoverageIndicatorIds: ["mega_cap_breadth"],
    });
  });

  it("distinguishes rotating stress, recovery, and relapse", () => {
    const first = buildMarketFragilityShadowObservation(
      snapshotWithStressedIds([
        "session_loss",
        "vwap_repair_failure",
        "poor_close_location",
      ]),
      1,
      6000,
      undefined,
    );
    const rotating = buildMarketFragilityShadowObservation(
      snapshotWithStressedIds([
        "downside_tail_cluster",
        "mega_cap_breadth",
        "equity_cross_confirmation",
      ]),
      2,
      5980,
      first,
    );
    const recovered = buildMarketFragilityShadowObservation(
      snapshotWithStressedIds([]),
      3,
      6010,
      rotating,
    );
    const relapse = buildMarketFragilityShadowObservation(
      snapshotWithStressedIds([
        "session_loss",
        "mega_cap_breadth",
        "equity_cross_confirmation",
      ]),
      4,
      5950,
      recovered,
      true,
    );

    expect(rotating.transition).toBe("ROTATING");
    expect(recovered.transition).toBe("RECOVERED");
    expect(relapse.transition).toBe("RELAPSE");
  });

  it("maps correlated indicators into four diagnostic families", () => {
    expect(mechanismFamily("session_loss")).toBe("price_damage");
    expect(mechanismFamily("downside_tail_cluster")).toBe("price_damage");
    expect(mechanismFamily("vwap_repair_failure")).toBe("repair_failure");
    expect(mechanismFamily("poor_close_location")).toBe("repair_failure");
    expect(mechanismFamily("mega_cap_breadth")).toBe("breadth");
    expect(mechanismFamily("equity_cross_confirmation")).toBe(
      "cross_market_confirmation",
    );
  });

  it("resets streaks by session and ignores duplicate observations", async () => {
    const state = memoryKv();
    await recordMarketFragilityShadow(
      state,
      "xyz:SP500",
      "2026-08-11",
      1,
      6000,
      snapshot(3),
    );
    const duplicate = await recordMarketFragilityShadow(
      state,
      "xyz:SP500",
      "2026-08-11",
      1,
      5990,
      snapshot(4),
    );
    const nextSession = await recordMarketFragilityShadow(
      state,
      "xyz:SP500",
      "2026-08-12",
      2,
      6010,
      snapshot(3),
    );

    expect(duplicate.changed).toBe(false);
    expect(duplicate.ignoredReason).toBe("duplicate");
    expect(duplicate.observation).toMatchObject({
      price: 6000,
      breakingStatus: "PENDING",
    });
    expect(nextSession.observation.breakingStreak).toBe(1);
    expect(nextSession.state?.sessions).toHaveLength(2);
    expect(await state.get(shadowStateKey("xyz:SP500"))).not.toBeNull();
  });

  it("resets confirmation when v1 falls below breaking", () => {
    const pending = buildMarketFragilityShadowObservation(
      snapshot(3),
      1,
      6000,
      undefined,
    );
    const reset = buildMarketFragilityShadowObservation(
      snapshot(2),
      2,
      6010,
      pending,
    );

    expect(reset).toMatchObject({
      v1Level: "fragile",
      breakingStreak: 0,
      breakingStatus: "BELOW_THRESHOLD",
    });
  });

  it("rejects globally out-of-order rows and rebuilds malformed state", async () => {
    const state = memoryKv({
      [shadowStateKey("xyz:SP500")]: JSON.stringify({
        version: 1,
        market: "xyz:SP500",
        sessions: [
          {
            sessionKey: "2026-08-11",
            observations: [{ timestamp: 1, indicators: "invalid" }],
          },
        ],
      }),
    });
    const rebuilt = await recordMarketFragilityShadow(
      state,
      "xyz:SP500",
      "2026-08-12",
      10,
      6000,
      snapshot(2),
    );
    const stale = await recordMarketFragilityShadow(
      state,
      "xyz:SP500",
      "2026-08-11",
      9,
      5990,
      snapshot(3),
    );

    expect(rebuilt.changed).toBe(true);
    expect(rebuilt.state?.sessions).toHaveLength(1);
    expect(stale.changed).toBe(false);
    expect(stale.ignoredReason).toBe("out_of_order");
  });

  it("migrates the bounded v2 key in place without another KV namespace", async () => {
    const state = memoryKv({
      [shadowStateKey("xyz:SP500")]: JSON.stringify({
        version: 2,
        market: "xyz:SP500",
        sessions: [{
          sessionKey: "2026-08-11",
          observations: [{
            timestamp: 1,
            price: 6000,
            v1Level: "breaking",
            stressedIndicatorCount: 3,
            availableIndicatorCount: 6,
            breakingStreak: 1,
            breakingStatus: "PENDING",
          }],
        }],
      }),
    });

    const update = await recordMarketFragilityShadow(
      state,
      "xyz:SP500",
      "2026-08-11",
      2,
      5990,
      snapshot(3),
    );

    expect(update.state?.version).toBe(4);
    expect(update.state?.sessions[0]?.observations[0]).toMatchObject({
      transition: "UNAVAILABLE",
      mechanismHistoryAvailable: false,
    });
    expect(update.observation).toMatchObject({
      transition: "NON_COMPARABLE",
      mechanismHistoryAvailable: true,
      breakingStatus: "PENDING",
    });
    expect(JSON.parse(String(await state.get(shadowStateKey("xyz:SP500")))))
      .toMatchObject({ version: 4 });
  });

  it("migrates v3 identity-level availability as unknown", async () => {
    const legacyObservation = buildMarketFragilityShadowObservation(
      snapshot(3),
      1,
      6000,
      undefined,
    ) as unknown as Record<string, unknown>;
    for (const key of [
      "breakingElapsedMinutes",
      "breakingObservedDurationMinutes",
      "measurementVersion",
      "indicatorStates",
      "coverageComparable",
      "continuousFromPrevious",
      "continuityBreakReason",
      "lostCoverageIndicatorIds",
      "gainedCoverageIndicatorIds",
    ]) {
      delete legacyObservation[key];
    }
    const state = memoryKv({
      [shadowStateKey("xyz:SP500")]: JSON.stringify({
        version: 3,
        market: "xyz:SP500",
        sessions: [{
          sessionKey: "2026-08-11",
          observations: [legacyObservation],
        }],
      }),
    });

    const update = await recordMarketFragilityShadow(
      state,
      "xyz:SP500",
      "2026-08-11",
      2,
      5990,
      snapshot(3),
    );

    const migrated = update.state?.sessions[0]?.observations[0];
    expect(migrated).toMatchObject({
      measurementVersion: "legacy_unknown",
      coverageComparable: false,
      continuityBreakReason: "legacy_unknown",
      mechanismHistoryAvailable: false,
    });
    expect(migrated?.indicatorStates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "poor_close_location",
          state: "stressed",
        }),
        expect.objectContaining({
          id: "mega_cap_breadth",
          state: "unknown",
        }),
      ]),
    );
    expect(update.observation).toMatchObject({
      transition: "NON_COMPARABLE",
      breakingStatus: "PENDING",
    });
    const afterRestart = await recordMarketFragilityShadow(
      state,
      "xyz:SP500",
      "2026-08-11",
      3,
      5980,
      snapshot(3),
    );
    expect(afterRestart.state?.sessions[0]?.observations).toHaveLength(3);
    expect(afterRestart.observation.breakingStatus).toBe("CONFIRMED");
  });

  it("retains at most 60 compact sessions", async () => {
    const state = memoryKv();
    for (let index = 0; index < 61; index += 1) {
      await recordMarketFragilityShadow(
        state,
        "xyz:SP500",
        `2026-session-${String(index).padStart(2, "0")}`,
        index + 1,
        6000 + index,
        snapshot(2),
      );
    }

    const rawState = await state.get(shadowStateKey("xyz:SP500"));
    const stored = JSON.parse(String(rawState)) as {
      sessions: Array<{ sessionKey: string }>;
    };
    expect(stored.sessions).toHaveLength(60);
    expect(stored.sessions[0]?.sessionKey).toBe("2026-session-01");
    expect(String(rawState).length).toBeLessThan(100_000);
  });

  it("retains at most 16 observations in one session", async () => {
    const state = memoryKv();
    for (let index = 0; index < 17; index += 1) {
      await recordMarketFragilityShadow(
        state,
        "xyz:SP500",
        "2026-08-12",
        index + 1,
        6000 + index,
        snapshot(3),
      );
    }

    const rawState = await state.get(shadowStateKey("xyz:SP500"));
    const stored = JSON.parse(String(rawState)) as {
      sessions: Array<{
        observations: Array<{ timestamp: number; breakingStreak: number }>;
      }>;
    };
    expect(stored.sessions[0]?.observations).toHaveLength(16);
    expect(stored.sessions[0]?.observations[0]).toMatchObject({
      timestamp: 2,
      breakingStreak: 2,
    });
  });
});

const INDICATOR_IDS = [
  "session_loss",
  "vwap_repair_failure",
  "poor_close_location",
  "downside_tail_cluster",
  "mega_cap_breadth",
  "equity_cross_confirmation",
] as const satisfies readonly MarketFragilityIndicatorId[];

function snapshot(
  stressedIndicatorCount: number,
  values: readonly number[] = [-0.02, -0.7, 0.1, 3, 0.8, -0.01],
): MarketFragilitySnapshot {
  return {
    level:
      stressedIndicatorCount >= 4
        ? "panic"
        : stressedIndicatorCount === 3
          ? "breaking"
          : stressedIndicatorCount === 2
            ? "fragile"
            : "resilient",
    score: 60,
    stressedIndicatorCount,
    availableIndicatorCount: 6,
    totalIndicatorCount: 6,
    dataQuality: "full",
    observationWindow: observationWindow(),
    indicators: INDICATOR_IDS.map((id, index) => ({
      id,
      state: index < stressedIndicatorCount ? "stressed" : "healthy",
      value: values[index] ?? 0,
      displayValue: String(values[index] ?? 0),
      threshold: "test",
      referenceType: referenceType(id),
      unavailableReason: null,
    })),
  };
}

function snapshotWithStressedIds(
  stressedIds: readonly MarketFragilityIndicatorId[],
): MarketFragilitySnapshot {
  const stressed = new Set(stressedIds);
  const stressedIndicatorCount = stressed.size;
  return {
    ...snapshot(stressedIndicatorCount),
    level:
      stressedIndicatorCount >= 4
        ? "panic"
        : stressedIndicatorCount === 3
          ? "breaking"
          : stressedIndicatorCount === 2
            ? "fragile"
            : "resilient",
    stressedIndicatorCount,
    indicators: INDICATOR_IDS.map((id) => ({
      id,
      state: stressed.has(id) ? "stressed" : "healthy",
      value: stressed.has(id) ? -1 : 0,
      displayValue: stressed.has(id) ? "stressed" : "healthy",
      threshold: "test",
      referenceType: referenceType(id),
      unavailableReason: null,
    })),
  };
}

function snapshotWithStates(
  states: Partial<
    Record<
      MarketFragilityIndicatorId,
      "healthy" | "stressed" | "unavailable"
    >
  >,
): MarketFragilitySnapshot {
  const indicators = INDICATOR_IDS.map((id) => {
    const state = states[id] ?? "healthy";
    return {
      id,
      state,
      value: state === "unavailable" ? null : state === "stressed" ? -1 : 0,
      displayValue: state,
      threshold: "test",
      referenceType: referenceType(id),
      unavailableReason: state === "unavailable"
        ? "insufficient_asset_context" as const
        : null,
    };
  });
  const stressedIndicatorCount = indicators.filter(
    (indicator) => indicator.state === "stressed",
  ).length;
  const availableIndicatorCount = indicators.filter(
    (indicator) => indicator.state !== "unavailable",
  ).length;
  return {
    ...snapshot(stressedIndicatorCount),
    level: availableIndicatorCount < 4
      ? "unknown"
      : stressedIndicatorCount >= 4
        ? "panic"
        : stressedIndicatorCount === 3
          ? "breaking"
          : stressedIndicatorCount === 2
            ? "fragile"
            : "resilient",
    score: availableIndicatorCount < 4 ? null : 60,
    stressedIndicatorCount,
    availableIndicatorCount,
    dataQuality: availableIndicatorCount === 6
      ? "full"
      : availableIndicatorCount >= 4
        ? "partial"
        : "insufficient",
    indicators,
  };
}

function observationWindow(): MarketFragilitySnapshot["observationWindow"] {
  return {
    candleEndTime: 1,
    contextFetchedAt: 1,
    evaluatedAt: 1,
    sessionScope: "rth",
    contextReferencePriceType: "hyperliquid_prev_day_px",
    contextProviderTimestamp: null,
  };
}

function referenceType(
  id: MarketFragilityIndicatorId,
): MarketFragilityReferenceType {
  if (id === "session_loss") {
    return "analysis_session_open";
  }
  if (id === "vwap_repair_failure") {
    return "latest_session_vwap";
  }
  if (id === "poor_close_location") {
    return "observed_session_range";
  }
  if (id === "downside_tail_cluster") {
    return "prior_candle_close";
  }
  return "hyperliquid_prev_day_px";
}

function memoryKv(initial: Record<string, string> = {}): KVNamespace {
  const values = new Map<string, string>(Object.entries(initial));
  return {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  } as unknown as KVNamespace;
}
