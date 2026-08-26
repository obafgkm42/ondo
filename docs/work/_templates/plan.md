---
id: NNNN
title: <short title>
stage: plan
status: draft          # draft | approved | done
milestone: <M0-M5>
date: YYYY-MM-DD
spec: ./spec.md
---

# Plan: <short title>

## Approach

Two or three sentences on the implementation strategy, and one sentence on the
alternative that was rejected and why.

## Files to change

### Live Worker (`src/`)

| File | Change |
| --- | --- |
| | |

### Research port (`python/`)

| File | Change |
| --- | --- |
| | |

If a change touches signal logic on one side only, explain why the other side
does not need it. Silent divergence between the two ports is the failure this
table exists to prevent.

## Contract parity

Does this touch a constant covered by `python/tests/test_contract_parity.py`?
If yes: list every location that must be updated together —
`src/signal-engine.ts`, the Python port, `wrangler.toml`, and
`config/signal_frozen_v1.yaml` — and note the version bump.

If no: say "no parity impact" explicitly.

## Tests

| Test | File | What it pins |
| --- | --- | --- |
| | | |

Cover the acceptance criteria from the spec, the failure modes, and at least
one data-health-degraded path.

## Rollout

Which mode this ships in — `off`, `shadow`, or `display` — and what would have
to be true to advance it. New diagnostics start at `shadow` unless the spec
argues otherwise.

## Rollback

How to disable this without a code deploy, if possible. A config-mode flip is
preferred over a revert.

## Documentation

Which files under `docs/` need updating in the same change. Methodology and
evidence live next to the feature, not in a follow-up.

- 
