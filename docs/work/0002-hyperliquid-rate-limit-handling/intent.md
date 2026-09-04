---
id: 0002
title: Harden Hyperliquid rate-limit handling
stage: intent
status: draft
milestone: M0
date: 2026-09-04
---

# Intent: Harden Hyperliquid rate-limit handling

## Problem

Beginning around 2026-09-03T17:00:00Z, the live Worker reported an incomplete
`xyz:SP500` scan at every top-of-hour boundary because the first Hyperliquid
candle request received HTTP 429 responses. Successful scans between those
failures reset the existing incident marker, so Discord sent a new warning each
hour even though the failures followed one recurring pattern.

The current client retries every Hyperliquid info request after only 250 ms and
500 ms. It treats HTTP 429 and transient server failures identically, does not
inspect `Retry-After`, and logs only the error class after retries are
exhausted. The result is unnecessary request amplification and insufficient
evidence to distinguish candle, category, and market-context failures.

## Why now

Repeated top-of-hour failures create predictable gaps in the prospective M0
evidence stream and suppress both market briefs and reversal evaluation for the
affected scan. The current logs cannot establish whether the limiting is tied
to an operation, response guidance, or a recurring provider/IP rate bucket.

## What "done" looks like

- A 429 response does not trigger immediate retries that add pressure to the
  same rate-limit window.
- Transient 5xx responses retain bounded retry behavior with exponential delay
  and jitter.
- Safe structured logs identify the Hyperliquid operation, response status,
  attempt number, retry decision, and parsed `Retry-After` delay when present.
- A core candle 429 ends the current scheduled scan and preserves the existing
  degraded-data notification and next-boundary recovery behavior.
- Optional cross-market failures continue to degrade to price-only diagnostics
  rather than taking down the read-only monitor.
- Regression tests pin the request counts and failure behavior.

## Out of scope

- Changing the five-minute Cron trigger, 15-minute scan cadence, final-hour
  cadence, or 30-minute brief cadence.
- Changing frozen reversal thresholds, market-activity bands, fragility or
  resilience classifications, eligibility, colors, or mention routing.
- Adding a new provider, websocket connection, Hyperliquid request, credential,
  or account-specific rate-limit query.
- Claiming that Cloudflare, Hyperliquid congestion, or any particular egress IP
  is the root cause without operation-level production evidence.
- Deploying the Worker or changing production configuration.

## Constraints

- Live venue access remains read-only.
- The normal request count must not increase; the failure path should issue
  fewer requests after a 429.
- Core market-data failure remains fail-closed for signals and briefs.
- Optional context remains fail-open so a price-only brief can still be built.
- Logs must not contain response bodies, credentials, account identifiers, or
  other sensitive values.
- Existing KV keys and the six-hour incident TTL remain unchanged.

## Open questions

- None at the intent stage. The spec must define the accepted `Retry-After`
  formats, maximum delay, jitter bounds, and exact optional-context behavior.
