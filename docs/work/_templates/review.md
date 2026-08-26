---
id: NNNN
title: <short title>
stage: review
milestone: <M0-M5>
date: YYYY-MM-DD
decision: SHADOW_ONLY   # PROMOTE | SHADOW_ONLY | RETIRE
plan: ./plan.md
---

# Review: <short title>

Evaluation date: YYYY-MM-DD
Decision: `<PROMOTE | SHADOW_ONLY | RETIRE>`

## Executive conclusion

State the decision first and the reasoning second. If nothing is authorized to
change in the live Worker, say that in the first sentence.

## Gate applied

Which review gate from [`sdlc.md`](../../sdlc.md) governs this change, and the
specific criteria it had to meet.

## Evidence

The numbers. Include sample sizes, the chronological split, and the interval —
not just point estimates. Name the artifact paths the results came from.

| Metric | Result | Threshold | Pass? |
| --- | --- | --- | --- |
| | | | |

## What the evidence does not show

Required. Sample scarcity, survivorship, proxy-data limits, crisis-period
concentration, and anything the study could not test. Sparse data is never
described as model success.

## Residual limitations

What remains unknown after this change ships, and what would resolve it.

## Follow-up

- [ ] 
