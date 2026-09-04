# Market Ondo Roadmap

Last reviewed: 2026-08-23

Market Ondo is an evidence-first, read-only market monitor.

## Product principles

1. Preserve a transparent diagnostic before attempting a predictive model.
2. Keep live market access read-only. Do not add account keys or order routes.
3. Make every behavior change pass a chronological, out-of-sample evidence
   gate. Shadow telemetry never promotes itself automatically.
4. Fail closed for eligibility and mentions when data health is uncertain, but
   fail open for the read-only monitor itself.
5. Stay inside the documented Cloudflare and Hyperliquid resource budget.

## Current baseline

The following work is already present and is not an open TODO:

- [x] TypeScript Cloudflare Worker with scheduled scans and signed Discord
  interactions.
- [x] Hyperliquid `xyz:SP500` read-only data path, data-health gate, bounded KV
  state, rate-limit handling, and US cash-session calendar.
- [x] RVOL-at-time activity labels with same-slot history.
- [x] Transparent six-mechanism fragility classifier plus shadow persistence.
- [x] Half-hour resilience diagnostic plus a five-minute prospective shadow.
- [x] Frozen reversal scanner and delivery-aware Python replay.
- [x] TypeScript/Python contract-parity tests and CI.
- [x] Rejected probability-v2 kept out of production after negative Brier Skill
  Score.

The evidence boundary is equally important:

- The frozen reversal policy has not demonstrated positive expectancy. Its
  current-stop profit factor is `0.83` on the canonical executable study.
- `BREAKING` and `PANIC` separate meaningfully from quieter states, while
  `FRAGILE` is weakly separated from `RESILIENT`.
- Two-brief fragility persistence is not a risk-escalation signal.
- The historical resilience `FADING` cohort is too sparse to evaluate.
- No current diagnostic authorizes an automated trade or an option strategy.

## Execution order

Work should proceed in this order. Later milestones depend on the evidence and
artifacts produced by earlier ones; dates are deliberately not used as a
substitute for promotion gates.

### M0 — Prospective evidence capture

Goal: preserve enough versioned, health-aware live evidence to evaluate the
diagnostics without turning rolling KV into an accidental research database.

- [ ] Define a `prospective-observation-v1` manifest containing Worker version,
  configuration/methodology fingerprint, market, session key, collection time,
  data-health and exclusion codes, diagnostic versions, and source-state hash.
- [ ] Add an operator-only local export command for the existing bounded KV
  states. Write only to ignored `reports/generated/` paths; do not add a public
  export endpoint.
- [ ] Export before the rolling windows age out and keep an append-only local
  manifest that detects duplicates, gaps, schema changes, and overlapping
  session snapshots.
- [ ] Extend offline reports to keep session-level denominators separate from
  repeated intraday observations and to exclude stale, gapped, holiday,
  early-close, or overnight rows from outcome evaluation.
- [ ] Add a prospective reversal-delivery audit: signal time, first observable
  time, entry-zone status, pre-delivery invalidation/target touch, and provider
  basis caveat. Do not model an option fill here.
- [ ] Record the prospective collection start commit and configuration in a
  short immutable methodology note before examining outcomes.

Exit gate:

- one documented command produces a hashed, versioned, locally ignored
  snapshot and reproducible report;
- collection adds no market-data request to the Worker; and
- an evaluator can distinguish unavailable, excluded, and genuinely negative
  observations without consulting private URLs or logs manually.

### M1 — Validate market activity on real venue sessions

Goal: decide whether the current RVOL bands describe Hyperliquid activity
reliably before they are used for anything beyond display.

- [ ] Review at least 30 complete, healthy RTH sessions for provisional label
  frequency and threshold churn; prefer 60 sessions for the full same-slot
  percentile review.
- [ ] Audit every 15-minute slot for history depth, missing-candle rate,
  bootstrap behavior, holiday/early-close exclusions, borderline frequency,
  and disagreement between fixed bands and percentiles.
- [ ] Document the evidence that authorizes the current `display` mode. If the
  evidence is incomplete, keep the label informational and make the incomplete
  calibration explicit.
- [ ] Predeclare any candidate threshold change, freeze it, then evaluate it on
  later sessions. Do not tune bands to manufacture a preferred frequency.
- [ ] Keep RVOL out of reversal eligibility, mention routing, and fragility
  scoring unless a separate chronological study passes its own gate.

Exit gate: publish an RVOL calibration report that either freezes the current
bands, replaces them through a versioned candidate, or recommends returning to
shadow-only display.

### M2 — Resolve the fragility evidence gap

Goal: determine whether the transparent high-stress states remain useful with
real-volume and prospective evidence, without reviving the rejected v2 model.

- [ ] Run the existing shadow report on prospective snapshots and report exact
  mechanism prevalence, correlated families, transitions, duration, and
  unique-session coverage.
- [ ] Join only healthy observations to predeclared 30-, 60-, 120-minute,
  end-of-session, next-session, and five-session outcomes.
- [ ] Run the documented aligned-volume sensitivity using lawfully obtained
  SPY, ES/MES, or prospective Hyperliquid venue volume. Record provenance,
  hashes, alignment rate, and the changed methodology fingerprint; never
  commit the data.
- [ ] Compare `BREAKING`/`PANIC` with `RESILIENT` using session-level samples,
  chronological slices, and session-block intervals. Report crisis-period
  concentration explicitly.
- [ ] Treat persistence only as path description. Do not use `CONFIRMED` to
  increase color, mentions, probability, or trade urgency.
- [ ] Create a new probability candidate only under a new versioned protocol.
  It must beat a rolling base-rate forecast with positive out-of-sample Brier
  Skill Score and survive calibration and stability checks. The failed v2
  coefficients remain retired.

Exit gate: either keep the count-based classifier as a diagnostic, promote a
predeclared candidate after all gates pass, or simplify the feature. A negative
or inconclusive result is a completed decision, not a reason to retune the same
holdout.

### M3 — Decide the future of resilience decay

Goal: use the five-minute prospective shadow to decide whether resilience adds
information or should remain presentation-only.

- [ ] Audit shadow completeness, excluded late starts, duplicate handling,
  scoring coverage, and agreement with the half-hour production path.
- [ ] Do not fit a candidate until every compared status cohort has at least 30
  independent sessions under a predeclared outcome contract.
- [ ] Define candidate thresholds on development periods only, then run frozen
  rolling-origin, non-overlapping test windows with session-level outcomes and
  session-block intervals.
- [ ] Compare against both the half-hour heuristic and a simple no-model/base-
  rate reference.
- [ ] Keep the proposed second derivative out of scope; the current recent
  window is too short for a stable curvature estimate.
- [ ] Make an explicit keep/display/retire decision. Until a prospective
  holdout passes, the five-minute path remains shadow-only and cannot alter
  alerts, colors, mentions, or reversal rules.

Exit gate: a versioned evaluation report supports one explicit product
decision; sample scarcity cannot be described as model success.

### M4 — Decide the future of the reversal scanner

Goal: stop treating a convex-looking rejection as an edge until delivery-aware
prospective evidence says otherwise.

- [ ] Keep `signal_frozen_v1` thresholds unchanged while prospective delivery
  observations accumulate.
- [ ] Re-run the canonical study with a lawfully obtained venue-continuous data
  source if one becomes available, preserving basis, volume, timestamp, and
  data-rights disclosures.
- [ ] If a v2 rule is proposed, register its features, thresholds, costs, entry
  policy, chronological split, and untouched holdout before reading final
  results. Do not optimize on the already inspected 2008–2026 sample and call
  it out of sample.
- [ ] Require positive net expectancy after delivery, slippage, cost, and
  single-position constraints; a cluster-aware interval must support the
  result, and no single fold or crisis may dominate it.
- [ ] Evaluate bullish reversal and bearish crash-monitoring paths separately.
- [ ] If the gate still fails, retire push-style `WATCH`/`ALERT` language or
  keep the feature explicitly experimental; do not loosen the gate.

Exit gate: promote, retain as experimental context, or retire the scanner based
on a written evidence decision. Option premium, Greeks, spreads, and strategy
P&L remain outside this repository.

### M5 — Controlled expansion

Goal: expand only after the single-market monitor and evidence pipeline are
stable.

- [ ] Define a provider/market capability contract before adding another
  symbol. Each market needs its own calendar, data-health rules, configuration,
  rate budget, and evidence report.
- [ ] Add release notes and semantic diagnostic versions so Discord output,
  stored state, Python replay, and methodology documents can be matched.
- [ ] Add dependency-update and supply-chain review without allowing automatic
  threshold or methodology changes.
- [ ] Repeat the security and compliance review before any public live
  dashboard, multi-server distribution, fee, personalization, account link, or
  execution capability.

Auto-execution, wallet/broker credentials, individualized recommendations, and
silent self-tuning are not roadmap items.

## Next issue-sized queue

Start here, one reviewable change at a time:

1. [ ] Freeze the `prospective-observation-v1` schema and methodology note —
  [`docs/work/0001-prospective-observation-v1/`](docs/work/0001-prospective-observation-v1/intent.md)
2. [ ] Add the local bounded-state export command and ignored output layout.
3. [ ] Build the health-aware prospective coverage report.
4. [ ] Build the 30/60-session RVOL calibration report.
5. [ ] Extend the fragility shadow report with predeclared outcome joins.
6. [ ] Add the prospective reversal delivery/fill-eligibility audit.

The queue is the backlog; starting an item does not require creating a
`docs/work/` directory. Capture its scope and verification in the pull request,
and update an existing methodology or evaluation document when the evidence
contract changes. The older work directories remain useful historical context.
See [Contributing](CONTRIBUTING.md).

## Definition of done for every milestone

These criteria apply before a milestone is considered complete, alongside each
milestone's own exit gate above.

- Runtime behavior, TypeScript/Python parity, and stored schema are tested.
- Relevant TypeScript, Python, and Worker build checks pass.
- Methodology, assumptions, data rights, resource use, and negative results are
  documented next to the feature.
- Shadow data cannot change production behavior without an explicit versioned
  code/config change.
