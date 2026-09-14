# Market temperature improvement roadmap

Back to the [documentation map](../README.md).

Status: canonical development backlog. Prepared: 2026-09-13. The coverage-aware
M1 work landed on `main` in `c00b8fa`; later milestones remain open.

## Objective and scope

Make market-pressure observations trustworthy, then test whether faster and
better-aligned observations add useful information beyond simple price and
volatility baselines. Keep the four-level classifier readable and explainable.
More requests are an experimental resource, not evidence of an edge.

The operator reports an upgrade to Cloudflare Workers Standard. Account
entitlements and deployed settings have not been inspected. This handoff
defines local implementation and validation tasks; deployment, notification
policy changes, and research promotion remain separate decisions under
[`AGENTS.md`](../../AGENTS.md) and
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

Keep venue access read-only. Do not change frozen reversal thresholds, revive
the rejected probability-v2 model, add trading routes, or introduce a live
weighted classifier. New measurements start in shadow. Use existing methodology
documents for durable contract changes; update this checklist with completed
work and evidence references rather than creating another process chain.

## Baseline findings to preserve in the handoff

- `src/market-fragility.ts` counts six threshold conditions. Four describe
  SP500 price history; breadth and cross-index confirmation use asset contexts.
  These are correlated observations, not six statistically independent events.
- At least four available indicators permit a level. Losing stressed context
  indicators can lower the level even when the price path is unchanged.
  `recoveredIndicatorIds` in `src/market-fragility-shadow.ts` currently treats
  disappearance from the stressed set as recovery, including unavailability.
- Session loss uses the session open; context returns use `markPx / prevDayPx`.
  The code does not establish a common RTH anchor. Do not assume `prevDayPx`
  means the previous official cash close or the current RTH open.
- Three recent closes are compared with the latest session VWAP. That is not
  necessarily three closes below each candle's contemporaneous VWAP. Clarify
  the current contract before testing an alternative.
- Cron ticks every five minutes. Actual scans run every 15 minutes, except
  every five minutes during 15:00-16:00 New York on standard session dates.
  Scanning continues outside RTH. Briefs run every 30 minutes throughout a
  standard session date, including overnight, and hourly on nonstandard dates.
  Eligibility and mentions have separate RTH/data-health gates.
- The coordinator serializes this Worker's scans and coalesces overlapping
  manual queries. It does not reserve an upstream IP quota, provide dedicated
  egress, or guarantee exactly-once external notification delivery.

The price-only historical study found higher subsequent downside frequency in
`BREAKING/PANIC`, but only four indicators were available and VWAP used a
zero-volume fallback. `FRAGILE` was weakly separated. The v2 probability
candidate failed its base-rate comparison; two-brief confirmation did not
identify a riskier post-confirmation cohort. These are constraints on claims,
not reasons to tune the inspected sample again. See
[current evidence](../evidence/current-evidence.md),
[fragility methodology](../methodology/fragility-backtest-methodology.md), and
[v2 evaluation](../evidence/fragility-v2-evaluation-report.md).

## Request and platform budget

### Official limits checked on 2026-09-13

[Hyperliquid's limit documentation][hl-limits] specifies 1,200 aggregated REST
weight per minute per IP. Most documented `info` requests cost 20; candle
responses add weight per 60 returned items. Request counts alone therefore
understate cost. Address-based action limits do not apply to these info reads.
The published rules do not establish a guaranteed allocation for this Worker.

Use `20 + ceil(returnedCandles / 60)` as a conservative candle-weight estimate,
not a verified provider billing counter. An 18-hour five-minute window is about
216 candles, or 24 estimated units. `metaAndAssetCtxs` is budgeted at 20.
`perpCategories` is used by this repo but its endpoint-specific weight was not
established by the documentation checked here: reserve 20 provisionally,
record this uncertainty, and do not raise its frequency without verification.

[Workers Standard pricing][cf-pricing] includes 10 million Worker requests and
30 million CPU milliseconds monthly. These are platform usage allowances,
not Hyperliquid quotas; external fetches are not billed as inbound Worker
requests. KV and Durable Object usage need their own estimates. The
[Workers limits page][cf-limits] lists 30 seconds of Cron CPU for intervals
below one hour. This deployment also runs scan work inside a Durable Object;
check its applicable limits rather than assigning it the Cron CPU allowance.
Confirm actual configuration before changing any resource limit.

### Proposed experiment ladder

All counts below are successful endpoint calls on a normal 24-hour standard
session date. They exclude manual requests, retries, RVOL bootstrap, deployment
work, and failures. Preserve overnight policy. Cache category metadata first.

| Stage | Candle calls/day | Context calls/day | Category calls/day | Total |
| --- | ---: | ---: | ---: | ---: |
| Current baseline | 104 | 48 | 48 | 200 |
| A: category cache only | 104 | 48 | 1 | 153 |
| B: five-minute RTH acquisition | 148 | 48 | 1 | 197 |
| C: B plus 15-minute RTH contexts | 148 | 61 | 1 | 210 |

Derivation: baseline has 96 quarter-hour scans plus eight extra final-hour
scans. Five-minute RTH acquisition adds 44 scans. Stage C adds 13 context
refreshes between existing half-hour boundaries. Categories have one planned
refresh per 24 hours; cold starts and recovery must still obey admission limits.
Assert exact boundary counts with the scheduler simulator before rollout.

At the provisional weights above, planned daily weight is approximately
4,416 / 3,476 / 4,532 / 4,792 respectively. A candle-plus-context tick is about
44 units; a category refresh adds 20. Daily totals do not prove minute-level
safety. A 30-day, 15-minute RVOL bootstrap can return about 2,881 candles and
cost about 69 estimated units in one request; reserve it separately.

Stage B can provide faster four-indicator shadow observations without more
daily calls than today's uncached baseline. It does not provide fresh six-item
observations every five minutes. Stage C is optional after B's operational
review. Full five-minute context polling, per-constituent candle fan-out, and
WebSocket ingestion are deferred until a specific evidence gap justifies them.

## Implementation checklist

### M1 - Correct missing-data and transition semantics

Primary files: `src/market-fragility-shadow.ts`, `src/types.ts`, relevant
formatters, Python shadow-report parser, and their tests.

- [x] Store per-indicator availability and reason, alongside stressed/healthy
  state. Version the persisted schema; migrate older rows as unknown where
  identity-level availability cannot be reconstructed.
- [x] Mark recovery only for an observed `stressed -> healthy` transition.
  Treat `stressed -> unavailable` as lost coverage. Compare transitions only
  over jointly observable indicators and compatible measurement definitions.
- [x] Break confirmation chains across missing expected briefs or incompatible
  coverage; distinguish elapsed wall time from continuously observed duration.
  A timestamp gap must not silently become continuous confirmation.
- [x] Keep the frozen count/level mapping, but label cross-coverage level changes
  as non-comparable. Never display a data-loss transition as improving/recovered.
  Do not normalize four-item counts onto a six-item scale or invent values.
- [x] Cover unchanged prices with `3/6 -> 1/4 -> 3/6`, partial-to-full recovery,
  genuine stressed-to-healthy recovery, insufficient data, skipped briefs,
  duplicate ticks, restart, and legacy schemas. Verify TypeScript/Python parity
  where both consume the new contract.

Done when all synthetic coverage-loss cases produce zero false recovery or
escalation claims, and unrelated healthy-data classifications remain unchanged.

### M2 - Make observation windows and presentation explicit

Primary files: `src/market-fragility.ts`, `src/hyperliquid.ts`, formatters,
`src/types.ts`, and `docs/methodology/fragility-backtest-methodology.md`.

- [x] Record candle end, context fetch completion, evaluation time, session
  scope, reference-price type, and any provider timestamp actually available.
  A local fetch timestamp does not establish the age of an underlying oracle.
- [x] Label current context returns with their actual provider reference.
  Verify `prevDayPx` semantics from authoritative documentation or provider
  confirmation before calling them cash-day or rolling-24-hour returns.
- [x] Keep same-RTH-anchor returns as a separately versioned shadow candidate.
  An observed post-open mark may be labelled a sampled anchor, never an exact
  09:30 open. Missed anchors remain missing; do not reconstruct them from a
  later quote. Avoid adding nine per-market candle requests to solve anchoring.
- [x] Make partial coverage and cached-context age prominent. Describe
  `RESILIENT` as few observed pressure conditions, not proven recovery or safety.
  Treat the six-item score as ordinal and expanded stock-perp breadth as a
  venue-specific proxy. Keep activity/RVOL separate from downside pressure.
- [x] Show existing mechanism families as explanatory context only. Do not
  change level weights, thresholds, colors, mentions, or reversal eligibility.
- [x] Test gap-down/rebound, gap-up/selloff, tiny-range quiet trading, missing
  anchors, changing VWAP, stale context, DST, holidays, and early closes.

Done when every displayed return has an unambiguous window and unavailable
inputs cannot look like favorable readings. Any formula alternative remains
shadow until M6; wording improvements alone do not establish predictive skill.

### M3 - Bound provider traffic before increasing cadence

Primary files: `src/scan-coordinator.ts`, `src/hyperliquid.ts`,
`src/scan-service.ts`, configuration/types, and `docs/operations/runtime.md`.

- [x] Add a versioned 24-hour category cache in existing coordinated storage.
  A failed refresh must not fan out into repeated category calls. Bound stale
  fallback at 72 hours and label its age; after expiry omit expanded breadth.
  Continue filtering delisted markets using current asset metadata.
- [x] Admit scheduled, manual, retry, category, and bootstrap requests through
  one coordinator budget. Start with at most 240 estimated weight units per
  rolling 60 seconds and one in-flight Hyperliquid call. This is a local
  engineering ceiling, not a claim of upstream capacity or a market threshold.
- [x] Reserve a conservative response-size bound before each candle request;
  count each attempted HTTP request, including failed attempts. Reconcile
  response-size estimates conservatively and log estimate uncertainty.
- [x] Retain one attempt on 429. Persist `blockedUntil` across ticks/restarts;
  respect valid Retry-After within the existing bounded parsing contract. Use a
  60-second fallback when absent/invalid and allow one probe after expiry.
  Extend cooldown on a failed probe; do not sleep inside a Worker to retry.
- [x] Keep at most three total attempts for 5xx, all subject to admission and
  the invocation deadline. Defer optional context/bootstrap when budget is
  insufficient; a context 429 suppresses further Hyperliquid calls that tick.
- [x] Keep concurrent manual-query coalescing and add a bounded manual refresh
  policy: at most one new upstream refresh per 60 seconds. During cooldown or
  admission denial return clearly timestamped cached/partial output or an
  unavailable result, never bypass the budget. Preserve authentication.
- [x] Persist cooldown and budget reservations safely across eviction; bound
  queued work, discard obsolete ticks, and prioritize the next valid scheduled
  scan over repeated manual queries. Do not replay a backlog as a request burst.
- [x] Test rolling-minute boundaries, 429 with every Retry-After variant, 5xx,
  category expiry, large bootstrap responses, cold starts, storage failure,
  concurrent manual/cron work, and lost responses. No direct fallback may
  bypass coordinated admission. Budget-state failure suppresses fresh fetches
  while keeping labelled degraded status available.

Done when deterministic request traces stay inside the configured ceiling,
cooldown makes zero upstream calls, and baseline healthy scans are not starved.
Do not change regions, rotate IPs, or add identities to evade upstream limits.

### M4 - Separate acquisition, shadow evaluation, and notifications

Depends on M1-M3. Primary files: scheduling/configuration, scan service,
coordinator, shadow collectors, and their integration tests.

- [x] Add an explicit opt-in five-minute RTH acquisition mode for stage B.
  Retain the current five-minute cron and current non-RTH acquisition policy.
  Reuse one SP500 candle response for all diagnostics at each acquired tick.
- [x] Keep original reversal evaluation/delivery opportunities on the existing
  15-minute/final-hour-five-minute grid. Faster acquisition must not silently
  create earlier alerts, alter entry eligibility, or advance its catch-up
  watermark. Maintain separate scheduling/watermarks for shadow work.
- [x] Preserve half-hour live fragility/resilience and existing Discord cadence.
  New five-minute price-only observations have a separate identity; contexts
  reused between refreshes carry their true age and coverage. Never backfill
  past shadow rows using newly fetched cross-market values.
- [x] Give the faster collector its own versioned storage key and bounds: at
  most 78 observation opportunities per full RTH session and 60 retained
  sessions, with an explicit byte-size ceiling. Do not write five-minute rows
  into the existing 16-row half-hour schema. Test retention and export before
  enabling collection; keep legacy live state intact for rollback.
- [ ] Implement stage C only as a separate opt-in context-sampling mode after
  stage B passes operational review. Reuse each batch context response across
  all requested symbols. Avoid changing two experimental factors together.
- [x] Differentially replay identical timestamped provider responses through
  baseline and candidate. With shadow enabled, existing live signal payloads,
  mentions, eligibility, and half-hour outputs must match, except explicitly
  approved M1/M2 data-quality wording. More live alerts is a regression here.
- [x] Assert the daily request table, peak weights, first eligible observation,
  09:30/15:00/16:00 boundaries, DST, closure dates, delays, and catch-up behavior.

Done when shadow captures the intended grid without changing the frozen live
delivery policy. Disabling acquisition/context experiments restores baseline
scheduling while retaining M1's correctness fixes and M3's protections.

### M5 - Build prospective evidence that can actually be replayed

Depends on M1/M2; extend for M4 when enabled. Reuse the private research workflow
and existing shadow report rather than treating rolling KV as a full archive.

- [ ] Define one versioned private observation schema containing per-mechanism
  values, states, thresholds, availability/reasons, coverage mask, anchors,
  source/receipt/evaluation times, raw v1 result, corrected transition, data
  health, sampling mode, and code/config fingerprints.
- [ ] Capture eligible and excluded observation opportunities, plus bounded
  request/latency/429 telemetry. Record historical corrections explicitly;
  never rewrite what was available at a decision timestamp.
- [ ] Export bounded state to private durable research storage before eviction.
  State the retention/export schedule and verify completeness. Retain the
  lawful candle/context inputs needed for replay and future outcome labels;
  classification rows alone cannot reconstruct an intrahorizon price path.
- [ ] Estimate KV, coordinator storage, archive bytes/operations, Worker/DO CPU,
  and logs separately at stages A-C, with manual/retry/bootstrap scenarios.
  Use paid capacity for reliable evidence retention before increasing polling.
- [ ] Keep raw observations, production logs, account details, and third-party
  data out of Git. Commit only synthetic fixtures, schemas, and sanitized
  aggregate methodology/evidence. No new paid storage service is presumed.
- [ ] Test export interruption, duplicate ingestion, schema migration, missing
  sessions, bounded retention, and replay reproducibility from a manifest.

Done when an offline reader can distinguish an absent observation, a rejected
input, a cached input, and an observed healthy market without guessing.

### M6 - Test incremental usefulness and decide what may ship

Depends on M5. Primary files: Python fragility studies and evaluation/report
code; update existing methodology/evidence documents with the frozen protocol.

- [ ] Register candidates before examining evaluation outcomes. Compare v1,
  corrected transitions, alternate anchors, and cadence changes separately.
  Include a session-loss-only baseline and a simple time-of-day/return/
  volatility baseline. Fit any baseline on past training data only.
- [ ] Use 120-minute minimum path return <= -1% as the primary existing outcome;
  30/60-minute and five-session outcomes are secondary. Preserve complete-path
  requirements and label the distinction between path loss and close return.
  Anchor outcomes at actual observation availability/delivery, not an earlier
  candle timestamp. Simulate measured acquisition and notification latency.
- [ ] Compare price-only methods on identical four-item coverage. Test complete
  six-item observations separately using prospectively archived context and
  real venue volume. Do not transfer price-proxy event rates to the live market.
- [ ] Separate higher sampling frequency from predictive information. First
  compare candidates on the common half-hour grid; then measure extra early
  detections on a common five-minute opportunity grid. Count unavailable and
  suppressed opportunities so a high failure rate cannot improve precision by
  silently removing difficult cases.
- [ ] Freeze a simulated notification policy before testing, such as one first
  eligible BREAKING/PANIC notification per session. Evaluate both methods with
  the same policy and report any other cadence policy separately. Production
  notifications remain unchanged while this comparison runs offline.
- [ ] Report session-level recall, precision, false-alert sessions, lead time,
  missed episodes, alert count, state churn, and forward loss distributions.
  For a probability candidate also require Brier skill versus a train-only
  base rate and calibration; ordinal levels alone are not probabilities.
- [ ] Use chronological folds, purge training outcomes crossing test boundaries,
  and retain an untouched prospective holdout. Cluster paired comparisons by
  session and use moving blocks long enough for overlapping outcomes. Report
  annual/volatility slices and crisis concentration, not only pooled rows.
- [ ] Size the prospective study before collection/evaluation using a declared
  minimum useful effect and session-level power analysis. Freeze its end date,
  maximum duration, and analysis schedule. Prior inspected history is exploratory;
  a fixed 30-session collection marker is not evidence of adequate power.

Proposed acceptance targets to freeze before inspecting candidate outcomes:

- **M1 correctness:** zero false repair from unavailable inputs in regression
  cases.
- **M3 operations:** zero local budget/cooldown violations; all retries accounted
  for.
- **Faster observation:** median paired lead-time gain of at least five minutes,
  with its 95% interval above zero. Report the common-detection denominator and
  missed events; conditional lead time alone cannot establish an improvement.
- **Cadence guardrails:** recall loss no greater than two percentage points and
  additional false-alert sessions no greater than 0.1 per session, each checked
  with a one-sided 95% bound.
- **New pressure measurement:** recall gain of at least five percentage points
  at a fixed baseline false-alert budget, with the paired 95% recall-gain
  interval above zero.

These are proposed research acceptance targets, not validated market constants.
Choose and freeze one primary comparison; predeclare multiplicity treatment
for other candidates. If the available sample cannot resolve the target, report
`INCONCLUSIVE` and retain shadow status. A negative result is a valid outcome.

Risk-filter usefulness needs its own fixed policy comparison, including avoided
losses, missed profitable opportunities, time excluded, turnover, drawdown,
slippage, and costs. Predictive separation alone does not authorize a trading
gate. Profitability claims still require the existing
[promotion gate](../methodology/backtest-evaluation-plan.md).

## Validation, rollout, and agent completion record

- [ ] Run focused regression/integration tests for each milestone. Before an
  implementation PR run `npm ci`, `npm test`, `npm run typecheck`,
  `uv sync --dev --locked`, `uv run pytest`, and the full hygiene check.
  The locked Python sync follows the current CI workflow. Run Ruff formatting
  and checks when modifying Python, as required by the coding instructions.
- [ ] Validate the Worker bundle and coordinator behavior locally with mocked
  provider responses. Never use an upstream stress test to validate the limiter.
- [ ] After deployment is authorized, start with stage A, then a ten-full-session
  stage B operational pilot. This pilot checks delivery, resource use, data
  coverage, and failures; it is not the statistical edge evaluation.
- [ ] Record baseline and pilot request traces, estimated peak rolling weight,
  429s by endpoint, context age, p50/p95 scan latency, missed observations,
  duplicate notifications, KV/DO operations, CPU, and estimated monthly cost.
  Suggested pilot gates: >= 99% eligible scheduled observations captured,
  p95 availability delay <= 60 seconds, and no duplicate notification regression.
- [ ] Disable the higher-frequency experiment on any budget bypass, duplicate
  delivery regression, three consecutive scheduled 429s, or failure of the
  pilot availability gates. Preserve cooldown and correctness fixes. Investigate
  sanitized evidence before trying a new configuration; no automatic escalation.
- [ ] Move to stage C only if stage B passes operational gates and fresher context
  is required by the registered research question. An operational pass permits
  continued shadow collection, not new live mentions or classifier promotion.
- [ ] For each milestone, record commit, scope, tests, schema/config changes,
  request-budget delta, remaining uncertainty, and rollback behavior in its PR.
  Distinguish local tests, deployed runtime evidence, and completed research.

Suggested implementation order: M1, M2, M3, M5, M6 protocol registration,
M4 stage B, then M6 evaluation after the frozen collection window.
An agent should take one bounded milestone at a time and commit its tested unit
before proceeding. Do not mark a research task complete merely because the
collector, report generator, or test suite has been delivered.

### M1 completion record

- Scope: availability-aware fragility shadow schema v4, continuity-safe
  confirmation and transition semantics, Discord/log labelling, legacy v2/v3
  migration, and matching offline Python parsing/reporting.
- Validation: `npm test`, `npm run typecheck`, `uv run pytest`, focused schema
  migration tests, and Ruff formatting/checks passed locally.
- Runtime contract: no classifier threshold, level mapping, mention, color,
  reversal-eligibility, schedule, or provider-request change.
- Request-budget delta: zero; the existing brief uses the same fetched candles,
  contexts, and one bounded KV read/write pair.
- Remaining uncertainty: local tests do not prove deployed KV migration or
  Discord presentation. Deployment and runtime observation remain separate.
- Rollback: reverting the code restores v3 behavior; a v3 Worker cannot consume
  already-written v4 shadow rows and would rebuild this bounded diagnostic
  history. The read-only monitor and frozen classifier remain available.

### M2 completion record

- Scope: explicit indicator reference types; candle, context-receipt,
  evaluation, session-scope, and provider-time metadata; source-labelled
  `prevDayPx` returns; prominent context age and unavailable coverage; and
  neutral observed-pressure wording for `RESILIENT`.
- Provider contract: official documentation exposes `prevDayPx` but does not
  define its window or a context timestamp. The runtime records the literal
  field basis and `null` provider time rather than inferring either property.
- Shadow boundary: `fragility-rth-anchor-shadow-v1` is reserved as a separate
  future protocol. M2 does not compute, persist, display, or promote it.
- Runtime contract: classifier constants, level mapping, colors, mentions,
  reversal eligibility, scheduling, and request count are unchanged.
- Validation: focused fragility, Hyperliquid, Discord, interaction, and shadow
  tests plus TypeScript typecheck passed locally. Existing market-hours tests
  retain DST, holiday, and early-close coverage.
- Request-budget delta: zero; the existing context response is timestamped
  after parsing and no new provider or storage operation is added.
- Rollback: reverting M2 restores the earlier unlabeled presentation without
  changing stored shadow schema v4 or the frozen classifier.

[hl-limits]: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
[cf-pricing]: https://developers.cloudflare.com/workers/platform/pricing/
[cf-limits]: https://developers.cloudflare.com/workers/platform/limits/
