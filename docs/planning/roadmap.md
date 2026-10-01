# Market temperature improvement roadmap

Back to the [documentation map](../README.md).

This is the canonical backlog. M1-M3 and M4 stage B are implemented;
implementation history remains in Git and pull requests. The deployed
**ten-session operational pilot is still open**, as are stage C, M5 and M6.
Local tests and delivered tooling are not deployed or research evidence.

## Current contracts

- [Runtime](../operations/runtime.md): schedules, provider budgets, storage,
  coordination, modes and rollback. Confirm actual deployment settings before
  changing resource limits; account entitlements have not been inspected.
- [Current evidence](../evidence/current-evidence.md): results and limitations.
- [Fragility methodology](../methodology/fragility-backtest-methodology.md):
  coverage, anchors, transitions and frozen classifier semantics.
- [Promotion gate](../methodology/backtest-evaluation-plan.md): requirements
  for behavior changes. The rejected probability-v2 model remains excluded.
- [Contributing](../../CONTRIBUTING.md): implementation and review workflow.

## M4 remaining work

- [ ] Run and review the deployed ten-session stage B pilot using the existing
  acquisition audit tooling. Check intended observation coverage, bounded
  storage, request budget/cooldown and unchanged live delivery policy.
- [ ] Implement stage C as a separate opt-in context-sampling experiment only
  after stage B operational review. Reuse each context response across symbols;
  keep source ages and coverage explicit and do not backfill historical context.
- [ ] Preserve the existing overnight policy, half-hour live outputs, reversal
  delivery grid and catch-up watermark. Disable the experimental mode to
  restore baseline acquisition while keeping correctness and traffic guards.

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

## Validation and rollout

- [ ] Run focused regression/integration tests for each milestone. Before an
  implementation PR follow the full validation commands in
  [CONTRIBUTING.md](../../CONTRIBUTING.md). Run Ruff formatting and checks
  when modifying Python.
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

Next: review the stage B pilot, register M5/M6 protocols, then evaluate after
the frozen collection window. Delivered tooling does not complete research.
