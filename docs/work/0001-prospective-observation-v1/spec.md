---
id: 0001
title: Freeze the prospective-observation-v1 schema
stage: spec
status: draft
milestone: M0
date: 2026-08-26
intent: ./intent.md
---

# Spec: Freeze the prospective-observation-v1 schema

> **Draft — awaiting approval at the Design gate.** Build has not started and
> no `plan.md` exists yet. This is the intended state: the chain pauses here
> until a human approves.

## Summary

Define a frozen `prospective-observation-v1` manifest, and add an
operator-only local command that exports the Worker's existing bounded KV
state into hashed, versioned snapshot files under an ignored path. Repeated
exports append to a local manifest that can detect duplicates, gaps, schema
changes, and overlapping session coverage.

Nothing about the live Worker's behavior changes.

## Behavior contract

### Inputs

Existing KV values, read on demand through Wrangler — the same single-read
pattern already documented for the fragility shadow export in
[`fragility-shadow-report.md`](../../fragility-shadow-report.md):

- `market-fragility-v2-shadow:<market>`
- the five-minute resilience shadow key
- the RVOL same-slot history key

No Hyperliquid request. No new Worker endpoint. No recurring workload. Each
export is one manual KV read per key.

### Outputs

Per export run, written under `reports/generated/prospective/` (ignored by
Git):

1. A snapshot file per source key, verbatim as read.
2. A manifest record per snapshot, conforming to the schema below.
3. An appended entry in the local append-only manifest index.

### Manifest fields

Every record carries all of the following. A record missing any field is
invalid and must be rejected rather than defaulted.

| Field | Purpose |
| --- | --- |
| `schema_version` | Literal `prospective-observation-v1`. |
| `worker_version` | The deployed Worker version that produced the state. |
| `config_fingerprint` | Hash over the runtime `[vars]` modes and thresholds in effect. |
| `methodology_fingerprint` | Identifies the methodology definition in force. |
| `market` | e.g. `xyz:SP500`. |
| `session_key` | The RTH session the observation belongs to. |
| `collected_at` | Export time, UTC. |
| `source_key` | The KV key read. |
| `source_state_hash` | SHA-256 of the raw value, for duplicate detection. |
| `data_health` | The gate's verdict: `healthy`, `degraded`, `stale`, `unavailable`. |
| `exclusion_codes` | Why a row is ineligible: holiday, early close, overnight, gapped. |
| `diagnostic_versions` | Version of each diagnostic that produced the state. |

The `data_health` and `exclusion_codes` pair is what lets a later evaluator
tell *unavailable* from *excluded* from *genuinely negative*. This is the
central requirement of the intent, not a convenience field.

### States and transitions

None. This change introduces no label, classification, or state machine.

## Data-health handling

Data health is **recorded, not filtered**. The export preserves ineligible
observations along with the codes explaining why they are ineligible, rather
than dropping them — a dropped row is indistinguishable from a row that never
existed, which would corrupt denominators in every downstream study.

Filtering is the responsibility of the analysis step, using these codes.

## Failure modes

| Failure | Behavior |
| --- | --- |
| KV key absent | Record the key as `unavailable` with no snapshot; do not write a partial record. |
| KV value malformed | Write the raw value, mark the record invalid, and continue with other keys. |
| Wrangler auth fails | Abort the run with a non-zero exit. Do not write a partial manifest entry. |
| Duplicate `source_state_hash` | Record it as a duplicate of the prior export; do not append a second observation. |
| Schema change since last export | Refuse to append silently; require an explicit new schema version. |

This is a local operator command, so it fails loudly. The fail-open rule
applies to the Worker, not to research tooling — a research tool that quietly
half-succeeds produces exactly the contaminated dataset this item exists to
prevent.

## What must not change

- Frozen thresholds in `config/signal_frozen_v1.yaml`.
- The `@everyone` mention policy.
- Existing KV keys, values, retention bounds, and write paths — this is a
  read-only consumer of state the Worker already maintains.
- Reversal signal eligibility, fragility classification, resilience output.
- Worker request budget and scan cadence.
- The absence of a public export endpoint.

## Resource impact

- Additional Hyperliquid requests: **none**.
- Additional KV writes: **none**.
- Additional KV reads: one per source key per manual export run, operator
  initiated. No recurring Cloudflare workload is created.
- Worker code size: unchanged if the export is implemented entirely as local
  tooling, which is the preferred approach.

## Acceptance criteria

- [ ] `prospective-observation-v1` is documented as a frozen schema with every
      field above, committed before any outcome is examined.
- [ ] One documented command produces a hashed, versioned snapshot plus a
      manifest record, under an ignored path.
- [ ] Re-running the command on unchanged KV state is detected as a duplicate
      and does not append a second observation.
- [ ] A gap between exports is visible in the manifest index rather than
      silently closed.
- [ ] A record with a changed `config_fingerprint` or `methodology_fingerprint`
      is distinguishable from one produced under the previous configuration.
- [ ] Unavailable, excluded, and negative observations are distinguishable from
      the artifact alone.
- [ ] The Worker's runtime behavior is byte-identical: no `src/` change alters
      output, and existing tests pass unmodified.
- [ ] A short immutable methodology note records the collection start commit
      and configuration.

## Evidence required

None. This change collects evidence; it does not act on any. It is
presentation- and tooling-only, alters no live behavior, and therefore does not
face a promotion gate.

It must still satisfy the M0 exit gate in [`ROADMAP.md`](../../../ROADMAP.md):
one documented command produces a hashed, versioned, locally ignored snapshot
and reproducible report; collection adds no market-data request to the Worker;
and an evaluator can distinguish unavailable, excluded, and genuinely negative
observations without consulting private URLs or logs manually.

Promotion of anything *derived* from this data is out of scope here and will
require its own work item and its own gate.

## Open questions carried from intent

These must be resolved before this spec can be approved:

1. Append-only manifest as single JSONL vs. per-run files.
2. Whether `methodology_fingerprint` hashes the `docs/` methodology content or
   only the config and code version.
3. Whether a Worker-version mismatch aborts the export or is recorded and
   allowed to continue.
