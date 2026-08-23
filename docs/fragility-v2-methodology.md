# Market Fragility v2 Methodology

Fragility v2 is a research and prospective-shadow layer for the periodic
market-repair classifier. It replaces equal-weight failure counting in the
research model with calibrated downside probabilities and separates risk level
from causal repair phase. It does not replace the live v1 classifier.

## Research questions

The evaluation asks three distinct questions:

1. Do indicator identity, continuous severity, and recent repair history add
   out-of-sample information beyond the number of failed mechanisms?
2. Does a `BREAKING` label become more specific when it requires both elevated
   risk and evidence that repair is worsening?
3. Does an existing v1 `BREAKING/PANIC` state that remains present at the next
   due brief identify a meaningfully riskier post-confirmation cohort?

The predeclared outcomes remain the v1 forward-path events: a further `1.0%`
minimum decline within 120 completed minutes and a further `2.0%` minimum
decline over the next five complete sessions. These are diagnostic labels, not
trade exits.

## Candidate models

Every rolling fold compares three L2-regularized logistic models:

- `count_only`: stressed-indicator count plus RTH time fraction;
- `weighted_flags`: the four price-indicator flags plus time fraction; and
- `continuous_dynamic`: the four flags plus four normalized severity margins,
  time fraction, prior stressed count, and the current consecutive failure
  streak.

Each continuous margin is zero at its frozen v1 threshold. Positive values
mean deeper stress and negative values mean distance on the healthy side. The
historical source contains only the four price indicators; breadth and
cross-index features remain explicitly unavailable.

## Chronological training and calibration

The outer evaluation uses 24 months of context followed by a non-overlapping
six-month test window, advancing six months at a time. Within each context
window, sessions are split chronologically:

- first 60%: coefficient fit;
- next 20%: select L2 strength from `0.001`, `0.01`, `0.1`, and `1.0` by
  Brier score; and
- final 20%: Platt-style probability calibration and state/phase parameter
  estimation.

No test observation participates in feature normalization, coefficient fit,
regularization selection, calibration, risk cutpoints, or phase thresholds.
All observations from one session share one unit of total weight so a session
with many briefs cannot dominate a fold.

## Risk level and repair phase

The four familiar labels remain as an output vocabulary, but the candidate is
defined by two axes:

- calibrated downside-risk level; and
- `IMPROVING`, `STABLE`, or `WORSENING` causal repair phase.

Risk cutpoints are derived only from the calibration segment and match that
segment's frozen-v1 `FRAGILE`, `BREAKING`, and `PANIC` prevalence. This
preserves an alert-budget comparison without optimizing cutpoints on future
outcomes.

Repair phase uses a one-sided CUSUM over changes in calibrated risk. Its drift
and threshold come from the calibration segment. Two consecutive briefs with
at least three stressed indicators also force `WORSENING`. Candidate
`BREAKING` therefore requires risk above its train-only cutpoint and a
`WORSENING` phase. Candidate `PANIC` requires the higher risk cutpoint plus
either `WORSENING` or at least four stressed mechanisms.

The deployable persistence test does not use the candidate probability model.
It uses the first existing v1 `BREAKING/PANIC` brief in each session. A case is
confirmed when the next due brief remains v1 `BREAKING/PANIC`; otherwise it is
transient. The 120-minute outcome is anchored at that next brief so price
movement during the confirmation wait is excluded. The uncertainty interval
uses circular moving blocks of five consecutive sessions.

## Evaluation metrics

Probability quality is reported separately from state separation:

- Brier loss and Brier Skill Score (BSS) versus the fold's training base rate;
- log loss;
- ROC AUC and precision-recall AUC;
- expected calibration error, calibration intercept, and calibration slope;
- paired candidate-minus-count-only Brier-loss and log-loss differences; and
- five-session moving-block 95% intervals over session-level loss differences.

The signs have different meanings and must always be labeled explicitly:

- Brier loss is a mean squared probability error in the range 0 to 1. Lower is
  better, and the loss itself cannot be negative.
- `Brier loss difference = candidate loss - baseline loss`. A negative
  difference favors the candidate; a positive difference favors the baseline.
- `BSS = 1 - candidate loss / baseline loss`. A positive BSS favors the
  candidate; a negative BSS means negative skill and favors the baseline.

Therefore a negative Brier-loss difference is an improvement, while a negative
BSS is a deterioration. Reports must not shorten either metric to an ambiguous
"negative Brier" result.

State diagnostics report observation count, independent-session count, 120-
minute and five-session downside-event rates, monotonic 120-minute risk, phase
separation, and the existing-v1 two-brief confirmation interval. Event rates
first average within session and then weight sessions equally.

Promotion requires all of the following:

- positive BSS versus the training-window base rate at both horizons;
- Brier and log-loss improvement over count-only with upper 95% interval below
  zero at both horizons;
- at least 30 independent sessions in `BREAKING` and `PANIC`;
- monotonic 120-minute risk across the four states;
- a positive lower 95% interval for `BREAKING` minus `FRAGILE` risk;
- a positive lower 95% interval for `WORSENING` versus non-worsening among
  observations already above the `BREAKING` risk cutpoint;
- a positive lower 95% interval for confirmed-minus-transient existing v1
  `BREAKING/PANIC`; and
- prospective shadow observations not used in model development.

One failed check keeps the decision at `SHADOW_ONLY`.

## Prospective persistence contract

`FRAGILITY_PERSISTENCE_MODE=shadow` stores a bounded 60-session log with at
most 16 observations per session under the existing KV key. Each due RTH brief
records the existing V1 level, exact stressed mechanism IDs and correlated
families, additions, repairs, price, elapsed `BREAKING/PANIC` duration, and a
forward-only mechanism transition. The first qualifying observation is
`PENDING`; the next qualifying observation is `CONFIRMED`. Duplicate and
out-of-order observations are ignored and malformed state is rebuilt. Schema
v2 rows migrate in place to v3 without another KV namespace or another
steady-state operation.

`FRAGILITY_PERSISTENCE_MODE=display` stores the same bounded rows and adds one
detailed Discord field. It does not add `CONFIRMED` to the push preview and
cannot change V1 colors, mentions, or reversal eligibility. The legacy
`FRAGILITY_V2_MODE` variable remains a compatibility alias.

The Worker does not contain or run the historical candidate coefficients. This
is an explicit consequence of negative out-of-sample BSS, meaning its Brier
loss is higher than the training-window base-rate forecast. Shadow
failures are fail-open and the default mode remains `off`.

## Free-tier resource contract

The diagnostic reuses the V1 fragility result and latest candle already loaded
for the due brief. It makes no additional Hyperliquid request and performs no
probability-model inference. At a 30-minute cadence it adds at most about 13 KV
reads and at most 13 writes per full RTH day. The bounded state retains IDs and
transitions rather than the six full indicator value objects.

Cloudflare currently documents 10 ms CPU per Free-plan Cron invocation,
100,000 KV reads/day, and 1,000 KV writes/day. Hyperliquid documents 1,200 REST
weight/minute per IP. Quotas are shared, so both prospective collectors retain
parser defaults of `off` and require explicit deployment opt-in. This
repository config opts both into bounded `shadow` collection without adding a
provider request.

## Reproducible command

First create a canonical v1 observation CSV, then run:

```bash
uv run fragility-v2-evaluate \
  --input-observations backtest/fragility-price-only-v1/events/fragility_observations.csv \
  --output-dir backtest/fragility-v2-shadow \
  --context-months 24 \
  --test-months 6 \
  --bootstrap-runs 1000 \
  --bootstrap-block-sessions 5
```

The ignored output directory contains the complete JSON payload and a rendered
Markdown report. The current frozen result is summarized in
[Fragility v2 evaluation report](fragility-v2-evaluation-report.md).

## Resilience curvature decision

Resilience decay remains a separate event-level diagnostic. Its existing
recent-score slope is already a first-order rate-of-change feature. A second
difference is not added to the live or shadow score: with only three recent
events it is effectively one noisy curvature observation, amplifies event-path
sampling error, and adds another selection degree of freedom to a sparse
`FADING` cohort.

The implemented resilience improvement is structural instead: shadow the
five-minute path and reject starts that cannot reach the two-hour checkpoint.
A curvature term can be reconsidered only as a predeclared ablation after the
prospective shadow cohort is large enough for rolling-origin evaluation.
