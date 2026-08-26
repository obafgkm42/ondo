---
id: NNNN
title: <short title>
stage: incident
date: YYYY-MM-DD
severity: low          # low | medium | high
---

# Incident: <short title>

## Summary

What happened, in two sentences.

## Timeline

| Time (UTC) | Event |
| --- | --- |
| | |

## Data-health state

What the data-health gate reported during the incident, and whether it behaved
correctly. A gate that stayed green through bad data is itself a finding.

## Blast radius

- Were Discord alerts affected? Were any sent that should not have been?
- Was `@everyone` triggered?
- Was KV state corrupted, and is it self-healing?
- Was any research artifact contaminated?

## Root cause

Why it happened. Not "the API failed" — why the failure was not absorbed.

## Fix

What was changed, and the commit or work item.

## Follow-up

Prevention, not just repair. If this was a fail-open path that should have
failed closed, that is a spec change, not a patch.

- [ ] 
