---
id: 0001
title: Freeze the prospective-observation-v1 schema
stage: intent
status: accepted
milestone: M0
date: 2026-08-26
---

# Intent: Freeze the prospective-observation-v1 schema

## Problem

The Worker collects prospective evidence — fragility shadow persistence and the
five-minute resilience shadow path — into bounded, rolling KV state. That state
ages out by design: the fragility shadow retains a bounded window, and the
resilience shadow keeps at most 78 current-session snapshots and 12 completed
shocks.

So the evidence the roadmap's later milestones depend on is being continuously
destroyed. M1, M2, and M3 each require dozens of independent healthy sessions
(M3 asks for at least 30 per compared cohort), and today there is no way to
accumulate them. Every export is also an undated, unversioned JSON blob: two
exports taken a week apart cannot be checked for overlap, gaps, or a schema
change in between.

The failure mode this must avoid is subtler than data loss. If observations are
exported without recording the Worker version, configuration, and methodology
that produced them, a later evaluation will silently mix incomparable rows and
report a result that looks clean. That is worse than having no data.

## Why now

It is the first item in the roadmap's issue-sized queue, and it gates the
other three evidence milestones. It is also time-sensitive in a way the rest
of the queue is not: every day without it is prospective evidence that cannot
be recovered afterwards.

Committing the schema before examining any outcomes is what makes the later
studies prospective rather than retrospective. Freezing it after looking at
results would forfeit that.

## What "done" looks like

- A `prospective-observation-v1` manifest schema exists as a frozen, versioned
  document, committed before any outcome is examined.
- One documented command produces a hashed, versioned, locally ignored snapshot
  from existing bounded KV state.
- Repeated exports append to a local manifest that detects duplicates, gaps,
  schema changes, and overlapping session snapshots.
- An evaluator can distinguish *unavailable*, *excluded*, and *genuinely
  negative* observations from the artifact alone — without consulting private
  URLs or reading logs by hand.
- The collection start commit and configuration are recorded in a short
  immutable methodology note.

## Out of scope

- **No public export endpoint.** Export is an operator-run local command only.
  Adding a route to the Worker would create an unauthenticated data surface and
  a new request path to defend.
- **No new Hyperliquid request.** Collection must reuse what the scheduled scan
  already fetches.
- **No new Worker schedule or recurring Cloudflare workload.** The export is
  on-demand.
- **No outcome analysis.** This item freezes the schema and builds the export.
  Joining observations to outcomes is M1/M2/M3 work and must happen after the
  schema is frozen.
- **No change to any live diagnostic**, threshold, mention policy, or Discord
  output.
- **No committed snapshots.** Exports land in ignored `reports/generated/`
  paths and stay there.

## Constraints

From [`AGENTS.md`](../../../AGENTS.md):

- Read-only boundary: this adds observation, never a write path to a venue.
- Shadow telemetry never promotes itself — capturing shadow data more durably
  must not make it easier for that data to reach live output.
- Resource budget: no additional provider request, and no new KV workload
  beyond the single manual read per export.
- Fail closed for eligibility: exported rows must carry their data-health and
  exclusion codes so an ineligible observation can never be silently counted
  as a healthy one downstream.

## Open questions

- Should the append-only manifest be a single JSONL file or one file per
  export run? JSONL is simpler to append and diff; per-run files are easier to
  delete selectively when a run is known bad.
- Does the methodology fingerprint need to cover the `docs/` methodology files
  themselves (by content hash), or only the config and code version? Hashing
  the docs catches a silent redefinition of a mechanism, but produces churn on
  every wording fix.
- Should the export refuse to run when the Worker version in KV does not match
  the local checkout, or record the mismatch and continue?

## Status

Accepted. Design has not started — see the [spec](spec.md), which is still a
draft awaiting approval at the Design gate.
