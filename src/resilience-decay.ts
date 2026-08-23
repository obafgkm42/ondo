import type {
  ResilienceDecayMetrics,
  ResilienceDecayState,
  ResilienceEventScore,
  ResiliencePriceSnapshot,
  ResilienceShockEvent,
} from "./types";

const RESILIENCE_STATE_PREFIX = "resilience-decay";
const RESILIENCE_STATE_VERSION = 2 as const;
const SHOCK_DROP_THRESHOLD = 0.006;
const CHECKPOINT_ONE_HOUR_MS = 60 * 60 * 1_000;
const CHECKPOINT_TWO_HOURS_MS = 2 * 60 * 60 * 1_000;
const MAX_SESSION_SNAPSHOTS = 78;
const MAX_COMPLETED_SHOCKS = 12;
const FADING_RECENT_RESILIENCE_MINIMUM = 55;
const FADING_DECAY_DELTA_THRESHOLD = -15;
const METRIC_COMPARISON_TOLERANCE = 1e-9;
const ONE_HOUR_SCORE_WEIGHT = 0.35;
const TWO_HOUR_SCORE_WEIGHT = 0.45;
const CLOSE_SCORE_WEIGHT = 0.2;

export interface ResilienceDecayUpdate {
  state: ResilienceDecayState | null;
  changed: boolean;
  approximateCpuMs: number;
  shockStarted: boolean;
  shockCompleted: boolean;
  ignoredReason: "duplicate" | "out_of_order" | null;
  recordedSnapshotCount: number;
  ignoredSnapshotCount: number;
}

export interface ResilienceDecayUpdateOptions {
  keyPrefix?: string;
  requireTwoHourEligibleStart?: boolean;
}

/**
 * Record one 30-minute SPX snapshot in the bounded resilience event log.
 *
 * The state writer stores raw observations; metric calculation remains a
 * separate pure step so it does not add another KV operation.
 */
export async function updateResilienceDecayState(
  state: KVNamespace | undefined,
  market: string,
  snapshot: ResiliencePriceSnapshot,
  options: ResilienceDecayUpdateOptions = {},
): Promise<ResilienceDecayUpdate> {
  return updateResilienceDecayStateBatch(
    state,
    market,
    [snapshot],
    options,
  );
}

/**
 * Record an ordered snapshot batch with one KV read and at most one write.
 *
 * Catch-up batches keep the decay sampling grid stable after a missed Worker
 * invocation or a status-brief cadence change.
 */
export async function updateResilienceDecayStateBatch(
  state: KVNamespace | undefined,
  market: string,
  snapshots: readonly ResiliencePriceSnapshot[],
  options: ResilienceDecayUpdateOptions = {},
): Promise<ResilienceDecayUpdate> {
  if (state === undefined) {
    return {
      state: null,
      changed: false,
      approximateCpuMs: 0,
      shockStarted: false,
      shockCompleted: false,
      ignoredReason: null,
      recordedSnapshotCount: 0,
      ignoredSnapshotCount: 0,
    };
  }

  const stateKey = resilienceStateKey(market, options.keyPrefix);
  const rawState = await state.get(stateKey);
  let nextState = parseState(rawState, market);
  const processingStartedAt = performance.now();
  const ignoredReasons = new Set<"duplicate" | "out_of_order">();
  let recordedSnapshotCount = 0;
  let ignoredSnapshotCount = 0;
  let shockStarted = false;
  let shockCompleted = false;

  for (const snapshot of snapshots) {
    const ignoredReason = snapshotIgnoredReason(nextState, snapshot);
    if (ignoredReason !== null) {
      ignoredReasons.add(ignoredReason);
      ignoredSnapshotCount += 1;
      continue;
    }
    const update = applySnapshot(nextState, market, snapshot, options);
    nextState = update.state;
    recordedSnapshotCount += 1;
    shockStarted ||= update.shockStarted;
    shockCompleted ||= update.shockCompleted;
  }

  const serializedState =
    nextState === null ? null : JSON.stringify(nextState);
  const changed = serializedState !== rawState;
  if (changed && serializedState !== null) {
    await state.put(stateKey, serializedState);
  }
  const ignoredReason =
    recordedSnapshotCount === 0 && ignoredReasons.size === 1
      ? [...ignoredReasons][0] ?? null
      : null;

  return {
    state: nextState,
    changed,
    approximateCpuMs: elapsedMilliseconds(processingStartedAt),
    shockStarted,
    shockCompleted,
    ignoredReason,
    recordedSnapshotCount,
    ignoredSnapshotCount,
  };
}

/**
 * Calculate resilience metrics from the raw event log without writing state.
 *
 * A recovery ratio is the fraction of the distance from an event trough back
 * to its pre-shock session high. The decay score is pressure-oriented: zero
 * means no measured decay, while higher values mean stronger deterioration.
 */
export function calculateResilienceMetrics(
  state: ResilienceDecayState,
): ResilienceDecayMetrics {
  const eventScores = [...state.completedShocks]
    .sort((left, right) => left.startedAt - right.startedAt)
    .flatMap((event) => {
      const score = calculateResilienceEventScore(event);
      return score === null ? [] : [score];
    });
  const recentScores =
    eventScores.length >= 3 ? eventScores.slice(-3) : [];
  const baselineScores =
    eventScores.length >= 8 ? eventScores.slice(-8, -3) : [];
  const recentResilience = meanEventScores(recentScores);
  const baselineResilience = meanEventScores(baselineScores);
  const decayDelta =
    recentResilience === null || baselineResilience === null
      ? null
      : recentResilience - baselineResilience;
  const recentEventScoreSlope = calculateEventScoreSlope(recentScores);
  const decayScore = calculateDecayScore(
    decayDelta,
    recentEventScoreSlope,
  );

  return {
    status: classifyResilience(
      recentResilience,
      baselineResilience,
      decayDelta,
      recentEventScoreSlope,
    ),
    recentResilience,
    baselineResilience,
    decayDelta,
    recentEventScoreSlope,
    decayScore,
    scoredShockCount: eventScores.length,
    unscoredShockCount:
      state.completedShocks.length - eventScores.length,
    eventScores,
  };
}

/**
 * Calculate the weighted score for one shock when all three observations exist.
 */
export function calculateResilienceEventScore(
  event: ResilienceShockEvent,
): ResilienceEventScore | null {
  const oneHourRecoveryRatio = calculateRecoveryRatio(
    event,
    event.oneHourPrice,
    event.oneHourTroughPrice,
  );
  const twoHourRecoveryRatio = calculateRecoveryRatio(
    event,
    event.twoHourPrice,
    event.twoHourTroughPrice,
  );
  const closeRecoveryRatio = calculateRecoveryRatio(
    event,
    event.closePrice,
    event.closeTroughPrice,
  );
  if (
    oneHourRecoveryRatio === null ||
    twoHourRecoveryRatio === null ||
    closeRecoveryRatio === null
  ) {
    return null;
  }

  return {
    eventId: event.id,
    oneHourRecoveryRatio,
    twoHourRecoveryRatio,
    closeRecoveryRatio,
    eventScore:
      oneHourRecoveryRatio * ONE_HOUR_SCORE_WEIGHT * 100 +
      twoHourRecoveryRatio * TWO_HOUR_SCORE_WEIGHT * 100 +
      closeRecoveryRatio * CLOSE_SCORE_WEIGHT * 100,
  };
}

function applySnapshot(
  previousState: ResilienceDecayState | null,
  market: string,
  snapshot: ResiliencePriceSnapshot,
  options: ResilienceDecayUpdateOptions,
): {
  state: ResilienceDecayState;
  shockStarted: boolean;
  shockCompleted: boolean;
} {
  if (
    previousState === null ||
    previousState.sessionKey !== snapshot.sessionKey
  ) {
    const previousSession = previousState ?? emptyState(market, snapshot);
    const finalized = finalizePreviousSession(previousSession);
    const nextState: ResilienceDecayState = {
      version: RESILIENCE_STATE_VERSION,
      market,
      sessionKey: snapshot.sessionKey,
      snapshots: [],
      activeShock: null,
      completedShocks: finalized.completedShocks,
    };
    return appendSnapshot(nextState, snapshot, options);
  }

  return appendSnapshot(previousState, snapshot, options);
}

function appendSnapshot(
  state: ResilienceDecayState,
  snapshot: ResiliencePriceSnapshot,
  options: ResilienceDecayUpdateOptions,
): {
  state: ResilienceDecayState;
  shockStarted: boolean;
  shockCompleted: boolean;
} {
  const snapshots = [...state.snapshots, snapshot].slice(
    -MAX_SESSION_SNAPSHOTS,
  );
  const currentSessionEvents = state.completedShocks.filter(
    (event) => event.sessionKey === snapshot.sessionKey,
  );
  const olderCompletedShocks = state.completedShocks.filter(
    (event) => event.sessionKey !== snapshot.sessionKey,
  );
  const observedCompletedShocks = currentSessionEvents.map((event) =>
    observeEvent(event, snapshot),
  );
  let activeShock =
    state.activeShock === null
      ? null
      : observeEvent(state.activeShock, snapshot);
  let shockStarted = false;
  let shockCompleted = false;

  if (activeShock !== null) {
    const shouldCompleteAtClose = snapshot.isSessionClose;
    const hasRecovered =
      snapshot.price >=
      activeShock.sessionHighAtTrigger * (1 - SHOCK_DROP_THRESHOLD);
    if (shouldCompleteAtClose || hasRecovered) {
      const completedEvent = completeEvent(
        activeShock,
        snapshot,
        shouldCompleteAtClose ? "session_close" : "recovered",
      );
      observedCompletedShocks.push(completedEvent);
      activeShock = null;
      shockCompleted = true;
    }
  }

  if (
    activeShock === null &&
    !shockCompleted &&
    (!options.requireTwoHourEligibleStart ||
      snapshot.twoHourCheckpointEligible === true) &&
    isShockTrigger(snapshot)
  ) {
    const startedEvent = startEvent(snapshot);
    if (snapshot.isSessionClose) {
      observedCompletedShocks.push(
        completeEvent(startedEvent, snapshot, "session_close"),
      );
      shockCompleted = true;
    } else {
      activeShock = startedEvent;
    }
    shockStarted = true;
  }

  const closeObservedEvents = snapshot.isSessionClose
    ? observedCompletedShocks.map((event) =>
        event.closePrice === null || event.closeTroughPrice === null
          ? {
              ...event,
              closePrice: event.closePrice ?? snapshot.price,
              closeTroughPrice:
                event.closeTroughPrice ?? event.troughPrice,
            }
          : event,
      )
    : observedCompletedShocks;
  const completedShocks = trimCompletedShocks([
    ...olderCompletedShocks,
    ...closeObservedEvents,
  ]);

  return {
    state: {
      ...state,
      snapshots,
      activeShock,
      completedShocks,
    },
    shockStarted,
    shockCompleted,
  };
}

function finalizePreviousSession(state: ResilienceDecayState): {
  completedShocks: ResilienceShockEvent[];
} {
  const lastSnapshot = state.snapshots.at(-1);
  if (lastSnapshot === undefined) {
    return { completedShocks: trimCompletedShocks(state.completedShocks) };
  }

  const completedEvents = state.completedShocks
    .filter((event) => event.sessionKey === state.sessionKey)
    .map((event) =>
      finalizeEventAtClose(observeEvent(event, lastSnapshot), lastSnapshot),
    );
  const olderCompletedShocks = state.completedShocks.filter(
    (event) => event.sessionKey !== state.sessionKey,
  );
  const allEvents = [...olderCompletedShocks, ...completedEvents];
  if (state.activeShock !== null) {
    allEvents.push(
      finalizeEventAtClose(
        observeEvent(state.activeShock, lastSnapshot),
        lastSnapshot,
      ),
    );
  }
  return { completedShocks: trimCompletedShocks(allEvents) };
}

function observeEvent(
  event: ResilienceShockEvent,
  snapshot: ResiliencePriceSnapshot,
): ResilienceShockEvent {
  // A recovered event is complete. Freezing its trough prevents a later,
  // separate sell-off from rewriting the severity of the earlier shock.
  const canUpdateTrough = event.completedAt === null;
  const troughPrice =
    canUpdateTrough && snapshot.price < event.troughPrice
      ? snapshot.price
      : event.troughPrice;
  const troughAt =
    canUpdateTrough && snapshot.price < event.troughPrice
      ? snapshot.timestamp
      : event.troughAt;
  const recordOneHour =
    event.oneHourPrice === null &&
    snapshot.timestamp >= event.startedAt + CHECKPOINT_ONE_HOUR_MS;
  const recordTwoHours =
    event.twoHourPrice === null &&
    snapshot.timestamp >= event.startedAt + CHECKPOINT_TWO_HOURS_MS;

  return {
    ...event,
    troughPrice,
    troughAt,
    oneHourPrice: recordOneHour ? snapshot.price : event.oneHourPrice,
    oneHourTroughPrice: recordOneHour
      ? troughPrice
      : event.oneHourTroughPrice,
    twoHourPrice: recordTwoHours ? snapshot.price : event.twoHourPrice,
    twoHourTroughPrice: recordTwoHours
      ? troughPrice
      : event.twoHourTroughPrice,
  };
}

function startEvent(snapshot: ResiliencePriceSnapshot): ResilienceShockEvent {
  return {
    id: `${snapshot.sessionKey}:${snapshot.timestamp}`,
    sessionKey: snapshot.sessionKey,
    startedAt: snapshot.timestamp,
    triggerPrice: snapshot.price,
    sessionHighAtTrigger: snapshot.sessionHigh,
    troughPrice: snapshot.price,
    troughAt: snapshot.timestamp,
    oneHourPrice: null,
    oneHourTroughPrice: null,
    twoHourPrice: null,
    twoHourTroughPrice: null,
    closePrice: null,
    closeTroughPrice: null,
    recoveredAt: null,
    completedAt: null,
    completionReason: null,
  };
}

function completeEvent(
  event: ResilienceShockEvent,
  snapshot: ResiliencePriceSnapshot,
  reason: "recovered" | "session_close",
): ResilienceShockEvent {
  return {
    ...event,
    closePrice: snapshot.isSessionClose ? snapshot.price : event.closePrice,
    closeTroughPrice: snapshot.isSessionClose
      ? event.troughPrice
      : event.closeTroughPrice,
    recoveredAt:
      reason === "recovered" ? snapshot.timestamp : event.recoveredAt,
    completedAt: snapshot.timestamp,
    completionReason: reason,
  };
}

function finalizeEventAtClose(
  event: ResilienceShockEvent,
  closeSnapshot: ResiliencePriceSnapshot,
): ResilienceShockEvent {
  return {
    ...event,
    closePrice: closeSnapshot.price,
    closeTroughPrice: event.troughPrice,
    completedAt: event.completedAt ?? closeSnapshot.timestamp,
    completionReason: event.completionReason ?? "session_close",
  };
}

function isShockTrigger(snapshot: ResiliencePriceSnapshot): boolean {
  return (
    snapshot.price <= snapshot.sessionHigh * (1 - SHOCK_DROP_THRESHOLD)
  );
}

function calculateRecoveryRatio(
  event: ResilienceShockEvent,
  recoveryPrice: number | null,
  checkpointTroughPrice: number | null,
): number | null {
  if (
    recoveryPrice === null ||
    checkpointTroughPrice === null ||
    !Number.isFinite(recoveryPrice) ||
    !Number.isFinite(checkpointTroughPrice)
  ) {
    return null;
  }
  const recoveryRange =
    event.sessionHighAtTrigger - checkpointTroughPrice;
  if (recoveryRange <= 0) {
    return null;
  }
  return clamp(
    (recoveryPrice - checkpointTroughPrice) / recoveryRange,
    0,
    1,
  );
}

function meanEventScores(
  scores: readonly ResilienceEventScore[],
): number | null {
  if (scores.length === 0) {
    return null;
  }
  return (
    scores.reduce((total, score) => total + score.eventScore, 0) /
    scores.length
  );
}

function calculateEventScoreSlope(
  scores: readonly ResilienceEventScore[],
): number | null {
  if (scores.length < 2) {
    return null;
  }
  const xMean = (scores.length - 1) / 2;
  const yMean =
    scores.reduce((total, score) => total + score.eventScore, 0) /
    scores.length;
  let numerator = 0;
  let denominator = 0;
  scores.forEach((score, index) => {
    const xOffset = index - xMean;
    numerator += xOffset * (score.eventScore - yMean);
    denominator += xOffset * xOffset;
  });
  return denominator === 0 ? null : numerator / denominator;
}

function calculateDecayScore(
  decayDelta: number | null,
  recentEventScoreSlope: number | null,
): number | null {
  if (decayDelta === null || recentEventScoreSlope === null) {
    return null;
  }
  return clamp(
    2 * Math.max(0, -decayDelta) +
      2 * Math.max(0, -recentEventScoreSlope),
    0,
    100,
  );
}

function classifyResilience(
  recentResilience: number | null,
  baselineResilience: number | null,
  decayDelta: number | null,
  recentEventScoreSlope: number | null,
): ResilienceDecayMetrics["status"] {
  if (
    recentResilience === null ||
    baselineResilience === null ||
    decayDelta === null ||
    recentEventScoreSlope === null
  ) {
    return "INSUFFICIENT_DATA";
  }
  if (
    recentResilience + METRIC_COMPARISON_TOLERANCE <
    FADING_RECENT_RESILIENCE_MINIMUM
  ) {
    return "FRAGILE";
  }
  if (
    decayDelta <=
    FADING_DECAY_DELTA_THRESHOLD + METRIC_COMPARISON_TOLERANCE
  ) {
    return "FADING";
  }
  return "RESILIENT";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function emptyState(
  market: string,
  snapshot: ResiliencePriceSnapshot,
): ResilienceDecayState {
  return {
    version: RESILIENCE_STATE_VERSION,
    market,
    sessionKey: snapshot.sessionKey,
    snapshots: [],
    activeShock: null,
    completedShocks: [],
  };
}

function trimCompletedShocks(
  completedShocks: readonly ResilienceShockEvent[],
): ResilienceShockEvent[] {
  return completedShocks.slice(-MAX_COMPLETED_SHOCKS);
}

function snapshotIgnoredReason(
  state: ResilienceDecayState | null,
  snapshot: ResiliencePriceSnapshot,
): ResilienceDecayUpdate["ignoredReason"] {
  const latestSnapshot = state?.snapshots.at(-1);
  if (latestSnapshot === undefined) {
    return null;
  }
  if (snapshot.timestamp === latestSnapshot.timestamp) {
    return "duplicate";
  }
  return snapshot.timestamp < latestSnapshot.timestamp
    ? "out_of_order"
    : null;
}

function parseState(
  rawState: string | null,
  market: string,
): ResilienceDecayState | null {
  if (rawState === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(rawState);
    if (!isResilienceDecayState(parsed, market)) {
      return null;
    }
    return normalizeState(parsed);
  } catch {
    return null;
  }
}

type StoredResilienceShockEvent = Omit<
  ResilienceShockEvent,
  | "oneHourTroughPrice"
  | "twoHourTroughPrice"
  | "closeTroughPrice"
> & {
  oneHourTroughPrice?: number | null;
  twoHourTroughPrice?: number | null;
  closeTroughPrice?: number | null;
};

interface StoredResilienceDecayState {
  version: 1 | 2;
  market: string;
  sessionKey: string;
  snapshots: ResiliencePriceSnapshot[];
  activeShock: StoredResilienceShockEvent | null;
  completedShocks: StoredResilienceShockEvent[];
}

function isResilienceDecayState(
  value: unknown,
  market: string,
): value is StoredResilienceDecayState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<StoredResilienceDecayState>;
  return (
    (candidate.version === 1 ||
      candidate.version === RESILIENCE_STATE_VERSION) &&
    candidate.market === market &&
    typeof candidate.sessionKey === "string" &&
    Array.isArray(candidate.snapshots) &&
    candidate.snapshots.length <= MAX_SESSION_SNAPSHOTS &&
    candidate.snapshots.every(isResiliencePriceSnapshot) &&
    Array.isArray(candidate.completedShocks) &&
    candidate.completedShocks.every((event) =>
      isResilienceShockEvent(event, candidate.version ?? 1),
    ) &&
    (candidate.activeShock === null ||
      isResilienceShockEvent(
        candidate.activeShock,
        candidate.version ?? 1,
      ))
  );
}

function normalizeState(
  state: StoredResilienceDecayState,
): ResilienceDecayState {
  return {
    ...state,
    version: RESILIENCE_STATE_VERSION,
    activeShock:
      state.activeShock === null
        ? null
        : normalizeShockEvent(state.activeShock),
    completedShocks: state.completedShocks.map(normalizeShockEvent),
  };
}

function normalizeShockEvent(
  event: StoredResilienceShockEvent,
): ResilienceShockEvent {
  return {
    ...event,
    oneHourTroughPrice: normalizeCheckpointTrough(
      event.oneHourTroughPrice,
    ),
    twoHourTroughPrice: normalizeCheckpointTrough(
      event.twoHourTroughPrice,
    ),
    closeTroughPrice: normalizeCheckpointTrough(
      event.closeTroughPrice,
    ),
  };
}

function normalizeCheckpointTrough(value: unknown): number | null {
  return isPositiveFiniteNumber(value) ? value : null;
}

function isResiliencePriceSnapshot(
  value: unknown,
): value is ResiliencePriceSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const snapshot = value as Partial<ResiliencePriceSnapshot>;
  return (
    typeof snapshot.sessionKey === "string" &&
    isFiniteNumber(snapshot.timestamp) &&
    isPositiveFiniteNumber(snapshot.price) &&
    isPositiveFiniteNumber(snapshot.sessionHigh) &&
    isPositiveFiniteNumber(snapshot.sessionLow) &&
    snapshot.sessionLow <= snapshot.price &&
    snapshot.price <= snapshot.sessionHigh &&
    typeof snapshot.isSessionClose === "boolean" &&
    (snapshot.twoHourCheckpointEligible === undefined ||
      typeof snapshot.twoHourCheckpointEligible === "boolean")
  );
}

function isResilienceShockEvent(
  value: unknown,
  version: 1 | 2,
): value is StoredResilienceShockEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Partial<ResilienceShockEvent>;
  const checkpointTroughsAreValid =
    version === 1 ||
    (isNullablePositiveFiniteNumber(event.oneHourTroughPrice) &&
      isNullablePositiveFiniteNumber(event.twoHourTroughPrice) &&
      isNullablePositiveFiniteNumber(event.closeTroughPrice));
  return (
    typeof event.id === "string" &&
    typeof event.sessionKey === "string" &&
    isFiniteNumber(event.startedAt) &&
    isPositiveFiniteNumber(event.triggerPrice) &&
    isPositiveFiniteNumber(event.sessionHighAtTrigger) &&
    isPositiveFiniteNumber(event.troughPrice) &&
    isFiniteNumber(event.troughAt) &&
    isNullablePositiveFiniteNumber(event.oneHourPrice) &&
    isNullablePositiveFiniteNumber(event.twoHourPrice) &&
    isNullablePositiveFiniteNumber(event.closePrice) &&
    checkpointTroughsAreValid &&
    isNullableFiniteNumber(event.recoveredAt) &&
    isNullableFiniteNumber(event.completedAt) &&
    (event.completionReason === null ||
      event.completionReason === "recovered" ||
      event.completionReason === "session_close")
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function isNullableFiniteNumber(
  value: unknown,
): value is number | null {
  return value === null || isFiniteNumber(value);
}

function isNullablePositiveFiniteNumber(
  value: unknown,
): value is number | null {
  return value === null || isPositiveFiniteNumber(value);
}

function resilienceStateKey(
  market: string,
  keyPrefix = RESILIENCE_STATE_PREFIX,
): string {
  return `${keyPrefix}:${market}`;
}

function elapsedMilliseconds(startedAt: number): number {
  return Number(Math.max(0, performance.now() - startedAt).toFixed(3));
}
