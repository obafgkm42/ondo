---
id: 0002
title: Harden Hyperliquid rate-limit handling
stage: plan
status: draft
milestone: M0
date: 2026-09-04
spec: ./spec.md
---

# Plan: Harden Hyperliquid rate-limit handling

> **Draft — awaiting approval at the Build gate.** No runtime code changes are
> authorized until this plan is approved.

## Approach

Refactor the shared Hyperliquid info-request helper so status-specific policy is
decided before sleeping: 429 and other non-transient responses log and abort on
their first response, while 5xx responses use the approved three-attempt
exponential schedule. Keep the structured log and `Retry-After` parser private
to the provider module, then add one explicit typed-error branch at the
fragility boundary so a category rate limit suppresses later optional work.

The rejected alternative is changing or offsetting the Cron schedule. Current
evidence shows a recurring top-of-hour pattern but does not establish its
external cause, and a cadence change would alter signal observation boundaries
without first improving operation-level evidence.

## Files to change

### Live Worker (`src/`)

| File | Change |
| --- | --- |
| `src/hyperliquid.ts` | Separate 429/non-transient aborts from 5xx retries; add bounded exponential delay, jitter, safe `Retry-After` parsing, and one structured warning per failed response. |
| `src/index.ts` | Detect a typed category rate limit and immediately return price-only fragility without requesting market contexts. Preserve all other core and optional failure paths. |

### Research port (`python/`)

| File | Change |
| --- | --- |
| None | Provider retry and Worker logging are runtime transport concerns; no signal calculation or research behavior changes. |

### Documentation

| File | Change |
| --- | --- |
| `docs/operations.md` | Record the status-specific failure request budget, bounded 5xx delay, and operation-level logging contract next to the existing successful-path request counts. |

## Contract parity

No parity impact. This change does not touch a constant covered by
`python/tests/test_contract_parity.py`, `src/signal-engine.ts`, the Python signal
port, `wrangler.toml`, or `config/signal_frozen_v1.yaml`.

## Tests

| Test | File | What it pins |
| --- | --- | --- |
| First candle 429 aborts after one request | `tests/hyperliquid.test.ts` | Typed error, one attempt, no sleep/retry, and structured `abort` log. |
| 5xx failures recover within the bounded policy | `tests/hyperliquid.test.ts` | Three-attempt ceiling, 1000/2000 ms exponential bases, and 0–250 ms jitter bounds using fake timers and controlled randomness. |
| Exhausted 5xx aborts | `tests/hyperliquid.test.ts` | Final `abort` log and normal provider error after exactly three attempts. |
| `Retry-After` normalization table | `tests/hyperliquid.test.ts` | Delta-seconds, future HTTP-date, past date, malformed, absent, and 24-hour cap without logging raw values. |
| Category 429 suppresses market contexts | `tests/scheduled-scan.test.ts` | Primary candle plus one category request only; price-only brief still posts. |
| Non-429 category failure preserves fallback | `tests/scheduled-scan.test.ts` | Existing frozen-basket context request still occurs. |
| Scheduled primary 429 recovery | `tests/scheduled-scan.test.ts` | Update the existing fixture for one failed attempt while retaining Discord notice, checkpoint catch-up, incident clearing, and deduplication assertions. |

The full CI-equivalent validation remains:

```bash
npm ci
npm test
npm run typecheck
uv sync --dev
uv run pytest
```

Additional review checks:

```bash
npm run check:hygiene -- --all
git diff --check
```

## Rollout

This is direct provider-failure hardening rather than a new diagnostic mode, so
`off` / `shadow` / `display` does not apply. A later deployment requires the
full deterministic test suite and a review confirming that successful-path
requests, signal behavior, labels, mentions, KV state, and cadence did not
change. Deployment and production-log monitoring require separate user
authorization and are not part of this plan.

## Rollback

There is no configuration switch because partial activation would leave one
shared request helper with ambiguous behavior. Before deployment, discard or
revert the isolated runtime commit. After deployment, roll back to the prior
Worker version through the normal Cloudflare deployment workflow; do not alter
thresholds, modes, or KV state.

## Documentation

- Update `docs/operations.md` in the runtime commit so operators can distinguish
  successful-path request counts from 429 and 5xx failure-path behavior.
- Complete `docs/work/0002-hyperliquid-rate-limit-handling/review.md` after all
  checks pass, recording the deterministic gate result and residual unknown
  top-of-hour root cause.
