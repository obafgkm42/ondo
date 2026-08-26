---
id: NNNN
title: <short title>
stage: spec
status: draft          # draft | approved | superseded
milestone: <M0-M5>
date: YYYY-MM-DD
intent: ./intent.md
---

# Spec: <short title>

## Summary

One paragraph: what the system will do after this change that it does not do
now.

## Behavior contract

The precise behavior. Be specific enough that two people implementing from
this spec would produce the same observable result.

### Inputs

Where the data comes from, at what cadence, and which existing fetch it reuses.
Adding a new Hyperliquid request needs explicit justification here.

### Outputs

What is produced, in what shape, and where it goes — Discord message, KV value,
local report file.

### States and transitions

If this introduces or changes a label or classification, enumerate every state
and what moves between them.

## Data-health handling

What happens when data is stale, gapped, on a holiday, in an early close, or
overnight. The default is: withhold the decision, keep the monitor available,
label the output as ineligible context. Say so explicitly if this change
deviates.

## Failure modes

| Failure | Behavior |
| --- | --- |
| Provider request fails | |
| KV unavailable or malformed | |
| Cross-market metadata missing | |

Fail open for the read-only monitor; fail closed for eligibility and mentions.

## What must not change

Name the things this change deliberately leaves alone. Reviewers check this
list against the diff.

- Frozen thresholds in `config/signal_frozen_v1.yaml`
- `@everyone` mention policy
- Existing KV keys and retention bounds
- Reversal signal eligibility

## Resource impact

Additional Hyperliquid requests per scan, KV reads and writes per RTH day, and
how that fits the budget in `operations.md`. State "none" if there is none.

## Acceptance criteria

Testable statements. Each one should map to at least one test in the plan.

- [ ] 
- [ ] 

## Evidence required

Which review gate this change must clear before it can alter live behavior, and
what evidence would satisfy it. If the change is presentation-only or
shadow-only, say that and say what would later justify promotion.
