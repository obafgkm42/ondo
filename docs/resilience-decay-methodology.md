# Resilience Decay Methodology

Resilience decay is an event-level diagnostic for the Hyperliquid
`xyz:SP500` proxy. It asks whether comparable intraday drawdowns are repairing
less effectively than earlier drawdowns. It is not a crash probability, trade
signal, or permission to change the frozen reversal rules.

## Live observation contract

The Worker derives a fixed half-hour grid from completed five-minute RTH
candles. Every scheduled RTH scan rebuilds the available grid and writes all
new boundaries as one ordered batch. This makes sampling independent of
`BRIEF_INTERVAL_MINUTES`, catches up after a missed scan, and retains one KV
read plus at most one write per invocation.

A shock starts when a half-hour close is at least `0.6%` below the cumulative
session high. While the event is active, the trough follows the lowest observed
half-hour close. The event completes at the first of:

- recovery to within `0.6%` of the pre-shock session high; or
- the New York cash-session close.

Completion freezes the event trough. A separate sell-off can start another
event, but it cannot rewrite the severity of the completed event.

## Event score

At one hour, two hours, and the session close, the Worker records both the
checkpoint price and the trough known at that checkpoint. This prevents a low
that occurs later from leaking into an earlier recovery ratio.

For checkpoint `h`:

```text
recovery(h) = clamp(
  (price(h) - trough_known_at_h)
  / (pre_shock_session_high - trough_known_at_h),
  0,
  1
)
```

An event is scored only when all three checkpoints are available:

```text
event score = 35% * one-hour recovery
            + 45% * two-hour recovery
            + 20% * close recovery
```

The stored score is expressed on a `0–100` scale. Late-session shocks that
cannot reach the two-hour checkpoint remain unscored rather than receiving
renormalized weights. Logs report both scored and unscored shock counts so this
complete-case rule is visible.

## Decay classification

Classification requires eight scored shocks:

- recent resilience: mean of the latest three scored shocks;
- baseline resilience: mean of the preceding five scored shocks;
- decay delta: recent minus baseline;
- recent slope: ordinary least-squares slope across the three recent scores;
- decay pressure: `2 * negative decay delta + 2 * negative slope`, clamped to
  `0–100`.

Statuses are deterministic:

- `INSUFFICIENT_DATA`: fewer than eight comparable scored shocks;
- `FRAGILE`: recent resilience is below `55`;
- `FADING`: recent resilience is at least `55` and decay delta is at most
  `-15`; and
- `RESILIENT`: neither condition is met.

Only `FADING` is eligible for the detailed Discord field. It does not alter
compact content, colors, mentions, fragility levels, or signal decisions.

## Five-minute prospective shadow

`RESILIENCE_DECAY_SHADOW_MODE=shadow` also rebuilds a five-minute observation
path from the candles already fetched for the scheduled scan. It writes to
`resilience-decay-shadow-5m:<market>`, leaving the production half-hour key and
metrics unchanged. A shadow event may start only when its timestamp is early
enough to reach the two-hour checkpoint by 16:00 New York time. Excluded late
starts remain visible through the predeclared policy rather than being scored
with renormalized weights.

The shadow path uses the same event and checkpoint equations, bounded state,
runtime validation, duplicate handling, and fail-open behavior as production.
It adds no provider request and cannot affect messages or signal decisions.
The parser default remains `off`; this repository's deployment config opts into
`shadow` prospective collection. Under the configured 15-minute cadence and
five-minute final hour, a standard full RTH day can add at most about 35 KV
reads and 35 writes. Even the more conservative every-five-minute upper bound
is 78 of each. The current-session snapshot array is explicitly capped at the
78 five-minute RTH boundaries, while completed shocks are capped at 12.

## State compatibility and data quality

State schema v2 stores a trough alongside each checkpoint. Version-one events
are migrated without inventing historical troughs; affected checkpoint values
therefore remain unscored and age out naturally. Duplicate and out-of-order
snapshots are ignored. Persisted snapshots and events are runtime-validated
before use; an invalid state is rebuilt from the next valid batch.

## Verification

The TypeScript tests cover:

- shock start, trough, recovery, close, and session rollover;
- checkpoint-specific troughs and absence of future leakage;
- trough freezing across a later independent sell-off;
- duplicate, out-of-order, catch-up, bounded-state, and v1 migration behavior;
- score weights, minimum sample size, slope, pressure bounds, and exact status
  thresholds;
- the scheduled Worker-to-KV path; and
- Discord field and mention-routing regressions.

Run the executable checks with:

```bash
npm test
npm run typecheck
uv run pytest
```

## Historical replay

The schema-v1 Python event study mirrors the live half-hour observation grid,
freezes checkpoint-visible troughs, and uses future candles only after the
session-close classification has been recorded. Run it on lawfully obtained
five-minute candles with:

```bash
uv run resilience-decay-backtest \
  --input path/to/SPX_full_5min_CT.json \
  --output-dir backtest/resilience-decay-v1 \
  --source-label selected-local-SPX-5m-cache \
  --source-timezone America/Chicago \
  --source-timestamp-mode naive-local \
  --session-timezone America/New_York \
  --bootstrap-runs 1000 \
  --bootstrap-block-sessions 5
```

For a quick implementation check, use `--bootstrap-runs 0` together with
`--skip-sensitivity`. That mode is not the canonical statistical report.
Generated output is ignored by Git and includes the complete input hash,
methodology fingerprint, event and session CSV files, fixed chronological
60/20/20 slices, one-at-a-time sensitivity rows, and circular moving-block
intervals over consecutive session dates.

The first 2008–2026 audit produced 4,653 session observations and 3,266 shocks,
of which 2,393 (73.27%) were fully scored. The current live thresholds produced
only one `FADING` session and none in the final chronological slice. Predictive
differences and their intervals are therefore suppressed: the current
classification is computable but not statistically identifiable.

The sensitivity audit also made the structural limitations measurable:

- five-minute path sampling found 6,771 shocks versus 3,266 on the live
  half-hour grid, so half-hour closes materially undercount fast paths;
- requiring a possible two-hour checkpoint reduced the cohort to 2,395 shocks
  and raised complete-case coverage from 73.27% to 99.92%;
- removing the absolute recent-score floor produced enough `FADING` sessions
  to calculate separation, but that variant was inspected on the existing
  holdout, changed direction between chronological slices, and is not a clean
  holdout-selected replacement; and
- session-weighted scores, one classification row per session, and session-
  block resampling prevent same-day shocks from being treated as independent
  evidence.

## Calibration plan

No live threshold changes follow directly from the first audit. A version-two
candidate should proceed in this order:

1. shadow a five-minute event path beside the unchanged live half-hour state;
2. reject event starts that cannot reach the two-hour checkpoint, while
   reporting excluded late-session shocks separately;
3. define candidate score and decay thresholds using development periods only,
   with a minimum of 30 independent sessions in every compared status cohort;
4. evaluate frozen candidates in rolling-origin, non-overlapping test windows
   using session-level outcomes and session-block intervals; and
5. require prospective data not used in this audit before a candidate can
   affect alerts, mentions, colors, or trade decisions.

A resilience second derivative is not part of this candidate. The current
three-event recent window already estimates a first-order slope; taking its
second difference would leave one high-variance curvature observation and add
another selection degree of freedom to a historically sparse status cohort.
It should be reconsidered only as a predeclared rolling-origin ablation after
the five-minute prospective cohort is sufficiently large.

The existing 60/20/20 slices are an audit of the frozen heuristic, not a valid
optimizer. Because all three slices and the sensitivity grid have now been
inspected, the final slice must not be relabeled as an untouched holdout for a
newly selected rule.

## Known limitations

- The `0.6%`, weight, `55`, and `-15` parameters are transparent heuristics;
  the historical audit shows that their `FADING` cohort is too sparse to
  evaluate.
- Half-hour closes can miss faster intrainterval lows and recoveries.
- Multiple shocks from one session remain dependent event inputs even though
  reported prediction rows and uncertainty use session-level units.
- Requiring a two-hour checkpoint selects against late-session shocks.
- Eight events remains only a live calculation minimum. Research differences
  are suppressed until both compared cohorts contain at least 30 independent
  sessions.
- `xyz:SP500` is a venue-specific perpetual proxy, not official cash SPX.

These limitations are why resilience decay remains presentation-only.
