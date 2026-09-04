---
id: 0002
title: Harden Hyperliquid rate-limit handling
stage: review
milestone: M0
date: 2026-09-04
decision: PROMOTE
plan: ./plan.md
---

# Review: Harden Hyperliquid rate-limit handling

Evaluation date: 2026-09-04
Decision: `PROMOTE`

## Executive conclusion

Promote the status-specific retry policy to a reviewable runtime commit. The
diff reduces first-response HTTP 429 amplification from three attempts to one,
preserves bounded recovery for 5xx responses, and makes the failed operation
observable without changing successful-path requests, scan cadence, diagnostic
classification, signal eligibility, KV state, or Discord routing.

This decision authorizes the local code change. It does not authorize a push or
Cloudflare deployment.

## Gate applied

This change is governed by the Hyperliquid request-budget gate in
[`sdlc.md`](../../sdlc.md), not a predictive promotion gate. The required
evidence is deterministic: exact request counts, bounded retry timing, safe log
shape, optional-context fail-open behavior, scheduled recovery, full Worker
tests, TypeScript typecheck, Python contract parity, and repository hygiene.

## Evidence

| Metric | Result | Threshold | Pass? |
| --- | --- | --- | --- |
| Primary candle requests after a first 429 | 1 | Exactly 1 | Yes |
| Optional info requests after category 429 | `candleSnapshot`, `perpCategories`; no `metaAndAssetCtxs` | At most 2 total | Yes |
| 5xx attempt ceiling | 3 | At most 3 | Yes |
| Tested 5xx delays with controlled jitter | 1000 ms, 2250 ms | 1000–1250 ms, 2000–2250 ms | Yes |
| `Retry-After` cases | delta, future date, past date, negative, malformed, absent, capped | All specified cases | Yes |
| TypeScript tests | 182 passed across 21 files | All pass | Yes |
| TypeScript typecheck | Passed | Pass | Yes |
| Python tests and contract parity | 71 passed | All pass | Yes |
| Whole-tree hygiene | 134 files, clean | No findings | Yes |
| Whitespace/error check | `git diff --check` passed | Pass | Yes |

Dependency preparation also completed successfully with `npm ci` and
`uv sync --dev`, matching the CI workflow before the test commands ran.

## What the evidence does not show

The deterministic tests do not identify why production Hyperliquid candle
requests began returning 429 at top-of-hour boundaries. They do not establish a
Cloudflare egress IP, shared rate bucket, congestion window, or reliable
presence of `Retry-After`. Those require observation after a separately
authorized deployment.

No chronological or out-of-sample market study was run because the change does
not modify a diagnostic, threshold, prediction, alert criterion, or market-data
interpretation.

## Residual limitations

- A top-of-hour candle 429 still causes that scheduled boundary to produce no
  brief or reversal evaluation; existing catch-up applies only after recovery.
- `Retry-After` is diagnostic-only and does not schedule a delayed retry.
- A 5xx sequence can add up to 3.5 seconds of wall-clock delay before failure.
- Existing incident state resets after any later successful scheduled scan, so
  recurring failures separated by recoveries can still notify more than once in
  six hours. Changing that lifecycle was explicitly out of scope.

## Follow-up

- [ ] After a separately authorized deployment, inspect structured
      `hyperliquid_request_failed` logs at `xx:00` and `xx:30` boundaries.
- [ ] Decide from observed operation/status/`Retry-After` evidence whether a
      cadence-offset proposal deserves a new work item; do not change Cron under
      this one.
