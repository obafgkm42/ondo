# Fragility v2 Evaluation Report

Evaluation date: 2026-08-12
Decision: `SHADOW_ONLY`

## Executive conclusion

Neither tested v2 change is authorized to alter the live classifier:

- the continuous/dynamic probability model has negative Brier Skill Score
  (BSS), meaning higher Brier loss than a training-window base-rate forecast at
  both horizons; and
- two consecutive existing v1 `BREAKING/PANIC` briefs do not identify a
  riskier post-confirmation cohort.

The Worker therefore does not contain the candidate model, coefficients, or a
probability-scoring path. The only online addition is an optional, compact
`PENDING` / `CONFIRMED` diagnostic that leaves v1 levels, colors, mentions,
Discord push text, and reversal rules unchanged.

## Reproducible scope

The canonical run used 60,262 scheduled observations from 4,653 sessions and
produced 33 rolling 24-month-context / six-month-test folds.

- run ID: `fragility-v2-513aa66d-621a0880`
- methodology fingerprint:
  `621a08809558e4897f865428d1d84d7bd17a3af0a985941bf49e6c9c780435aa`
- source observation SHA-256:
  `513aa66dad456d6ee3e4fd086e68059cfcab058a20580e0f9b67b59f8e9de2ef`

All historical periods have already been inspected, so none is represented as
an untouched prospective holdout.

## Out-of-sample probability results

Here Brier is a non-negative loss, so lower is better. BSS is
`1 - model Brier / base-rate Brier`, so positive BSS indicates improvement and
negative BSS indicates worse probability accuracy than the base-rate forecast.
A separate candidate-minus-baseline Brier-loss difference would use the
opposite sign convention: negative would favor the candidate.

| horizon | model | Brier loss (lower is better) | log loss | ROC AUC | PR AUC | ECE | BSS vs train base rate (positive is better) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 120m | count-only | 0.034038 | 0.182378 | 0.5548 | 0.0406 | 0.019160 | -2.76% |
| 120m | continuous + dynamic | 0.033580 | 0.172832 | 0.5775 | 0.0494 | 0.014278 | **-1.38%** |
| 5 sessions | count-only | 0.211071 | 0.632702 | 0.5491 | 0.3055 | 0.108616 | -3.11% |
| 5 sessions | continuous + dynamic | 0.209472 | 0.628359 | 0.5535 | 0.3079 | 0.095198 | **-2.33%** |

The candidate has lower Brier and log loss than count-only, but both BSS values
are negative relative to the simpler base-rate forecast. These are bad negative
skill values, not favorable negative loss differences, so the promotion
condition fails. No model artifact is exported for the Worker and no
probability output is shown in the live brief.

## Existing v1 persistence evaluation

The deployable diagnostic deliberately avoids the rejected model:

1. the first due brief whose existing v1 level is `BREAKING` or `PANIC` is
   `PENDING`;
2. the next due brief is `CONFIRMED` only if its existing v1 level is still
   `BREAKING` or `PANIC`; otherwise it is transient; and
3. the 120-minute outcome starts at the second brief, after confirmation would
   actually be available.

| metric | result |
| --- | ---: |
| pending sessions | 491 |
| evaluable pending sessions | 441 |
| confirmed / transient sessions | 263 / 178 |
| confirmation rate | 59.64% |
| confirmed 120m event rate | 6.84% |
| transient 120m event rate | 12.92% |
| confirmed minus transient | **-6.08 percentage points** |
| five-session block-bootstrap 95% interval | **-12.13 to -0.06 points** |
| median confirmation delay | 30 minutes |

Persistence is therefore not a risk-escalation feature. `CONFIRMED` means only
that the visible v1 condition persisted; it must not trigger a stronger color,
mention, alert, or trading action.

The earlier phase-conditioned result of +7.59 points used the candidate model's
train-only risk cutpoint and anchored the outcome at the first breaking event.
It is retained as a legacy research comparison, not evidence for a live rule.

## Other state diagnostics

| candidate state | observations | sessions | 120m event rate | 5-session event rate |
| --- | ---: | ---: | ---: | ---: |
| RESILIENT | 27,652 | 3,822 | 4.35% | 27.50% |
| FRAGILE | 7,991 | 2,356 | 4.08% | 27.85% |
| BREAKING | 1,240 | 568 | 7.39% | 42.04% |
| PANIC | 257 | 143 | 10.78% | 48.29% |

`FRAGILE` remains slightly below `RESILIENT`, so four-state 120-minute risk is
not monotonic. The incremental high-risk `WORSENING` interval also crosses
zero. These failed gates reinforce the `SHADOW_ONLY` decision.

## Online behavior and resource budget

- The probability candidate is not deployed. The parser default for the
  separate runtime persistence diagnostic remains
  `FRAGILITY_PERSISTENCE_MODE=off`; the repository deployment config opts into
  `shadow` collection only.
- `shadow` stores compact due-brief rows without changing presentation.
- `display` stores the same rows and adds one detailed Discord field; it does
  not change the compact push summary or mentions.
- The state retains at most 60 sessions and 16 observations per session, and
  stores compact mechanism IDs, families, transitions, duration, price, V1
  level/counts, and confirmation status.
- The feature makes no additional Hyperliquid request and performs no model
  fitting or logistic inference in the Worker.
- At a 30-minute brief cadence it adds at most about 13 KV reads and 13 KV
  writes per full RTH day. The separate five-minute resilience shadow is also
  an explicit deployment opt-in and can add at most 78 of each under a pure
  five-minute schedule; the configured mixed cadence lowers that ceiling to
  about 35 of each. Both prospective collectors now run only as `shadow`.

For comparison, the current Cloudflare Workers Free limits include 10 ms CPU
per Cron invocation, 100,000 KV reads/day, and 1,000 KV writes/day. Hyperliquid
documents an aggregate REST weight limit of 1,200/minute per IP. These quotas
are account/IP shared; the design stays well below them by reusing existing
candle/context responses and bounded KV state. See the official
[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Cloudflare pricing and KV quotas](https://developers.cloudflare.com/workers/platform/pricing/),
and [Hyperliquid rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits).

## Resilience decay decision

No resilience second derivative was added. With only three recent events it
would be one noisy curvature observation and would add variance to an already
sparse `FADING` cohort. The existing optional five-minute, two-hour-eligible
shadow addresses the observed data-completeness problem directly and remains
separate from the half-hour production state.
