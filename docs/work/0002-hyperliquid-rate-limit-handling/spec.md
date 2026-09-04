---
id: 0002
title: Harden Hyperliquid rate-limit handling
stage: spec
status: approved
milestone: M0
date: 2026-09-04
intent: ./intent.md
---

# Spec: Harden Hyperliquid rate-limit handling

> **Approved at the Design gate on 2026-09-04.** Runtime work remains gated by
> approval of the implementation plan.

## Summary

Separate HTTP 429 handling from transient Hyperliquid server failures. A 429
will end that request immediately, without an in-invocation retry. A 5xx
response will retain a bounded three-attempt policy with exponential delay and
jitter. Every failed response will emit one safe structured log that identifies
the operation and retry decision. Core candle rate limits will continue to stop
the scheduled scan; optional cross-market rate limits will degrade the brief to
price-only context and stop further optional Hyperliquid work in that scan.

## Behavior contract

### Inputs

The existing `POST https://api.hyperliquid.xyz/info` operations remain the only
provider inputs:

- `candleSnapshot` for the primary 5-minute scan and optional 15-minute RVOL
  bootstrap;
- `perpCategories` for the expanded XYZ stock universe; and
- `metaAndAssetCtxs` for breadth and cross-market context.

No request body, lookback, cadence, or successful-path request count changes.
The response status and optional `Retry-After` response header become inputs to
the retry decision.

`Retry-After` accepts the two HTTP-defined forms:

- a non-negative integer number of seconds; or
- an HTTP-date later than the current time.

Past dates normalize to zero milliseconds. Invalid, negative, non-finite, or
absent values normalize to `null`. The parsed diagnostic value is capped at 24
hours to keep logs bounded. The raw header is never logged.

### Retry policy

| Response | Attempts | Delay | Result |
| --- | ---: | --- | --- |
| 2xx | 1 | none | Return the response. |
| 429 | 1 | none | Log `abort`, then throw `HyperliquidRateLimitError`. |
| 5xx, first failure | up to 3 total | `1000ms + jitter` | Log `retry`, then retry. |
| 5xx, second failure | up to 3 total | `2000ms + jitter` | Log `retry`, then retry. |
| 5xx, third failure | 3 total | none | Log `abort`, then throw a normal provider error. |
| Other non-2xx | 1 | none | Log `abort`, then throw a normal provider error. |

Each jitter value is independently sampled from an integer range of 0–250 ms,
inclusive. Total scheduled delay across one exhausted 5xx sequence is therefore
between 3000 and 3500 ms. `Retry-After` never causes the Worker to sleep: it is
recorded so production evidence can guide a later policy without extending the
current invocation.

### Outputs

Every non-success response emits exactly one JSON warning with these fields:

| Field | Meaning |
| --- | --- |
| `status` | Literal `hyperliquid_request_failed`. |
| `operation` | `candle`, `market context`, or `perp categories`. |
| `responseStatus` | HTTP status code. |
| `attempt` | One-based attempt number. |
| `maxAttempts` | `1` for 429/non-transient responses, `3` for 5xx. |
| `decision` | `retry` or `abort`. |
| `retryDelayMs` | Planned local delay for a 5xx retry, otherwise `null`. |
| `retryAfterMs` | Safely parsed and bounded server guidance, otherwise `null`. |

No response body, response-header value, URL query, credential, account ID, or
market-data payload may enter the log.

The existing scheduled-scan warning, Discord degradation notice, recovery
checkpoint, and six-hour incident TTL remain unchanged.

### States and transitions

No diagnostic label or classifier state changes.

The rate-limit incident lifecycle remains:

1. A primary candle 429 throws `HyperliquidRateLimitError`.
2. The scheduled handler sends or deduplicates the degradation notice.
3. The next successful scheduled scan clears the incident immediately.

An optional `perpCategories` 429 instead causes the current fragility
calculation to return a price-only result immediately. It must not issue the
subsequent `metaAndAssetCtxs` request. A non-429 category failure may still fall
back to the frozen context basket and attempt `metaAndAssetCtxs`. A context 429
also produces a price-only result; there is no later optional provider request
to suppress.

## Data-health handling

Primary candle failure remains fail-closed: the Worker produces neither a
market brief nor reversal evaluation for that scheduled boundary. Existing
catch-up logic examines the missed candle range after recovery.

Optional category or market-context failure remains fail-open for the monitor:
the six-indicator fragility calculation uses its existing price-only fallback.
It cannot create eligibility, alter thresholds, or enable mentions.

Stale, gapped, holiday, early-close, and overnight handling are unchanged.

## Failure modes

| Failure | Behavior |
| --- | --- |
| Primary candle returns 429 | One provider attempt; scheduled scan aborts through the existing typed-error path. |
| RVOL bootstrap returns 429 | One provider attempt; bootstrap records degradation and the scanner continues. |
| `perpCategories` returns 429 | One provider attempt; skip `metaAndAssetCtxs` and return price-only fragility. |
| `metaAndAssetCtxs` returns 429 | One provider attempt; return price-only fragility. |
| Any operation returns 5xx then succeeds | Retry after bounded exponential delays; return the successful response. |
| Any operation exhausts 5xx attempts | Throw the existing normal provider error; the caller's existing core/optional policy applies. |
| `Retry-After` is malformed | Record `retryAfterMs: null`; do not throw while parsing. |
| Logging fails unexpectedly | Request behavior must not depend on log persistence. |
| KV unavailable or malformed | Existing best-effort incident and state behavior remains unchanged. |

## What must not change

- Frozen thresholds in `config/signal_frozen_v1.yaml` and their parity-tested
  counterparts.
- Reversal signal eligibility and catch-up semantics.
- Market-activity bands, fragility classification, resilience calculation, and
  shadow promotion boundaries.
- `@everyone` mention policy and Discord routing.
- Existing KV keys, values, retention bounds, and incident reset behavior.
- Cron configuration and scan/brief cadence.
- Successful-path Hyperliquid request count and request payloads.

## Resource impact

- Successful scan: no change.
- Each 429 path: at most one request instead of three.
- A category 429 on a brief: at most two total info requests in that invocation
  (primary candle plus category), because context fetch is suppressed.
- Exhausted 5xx path: still at most three attempts, with at most 3.5 seconds of
  scheduled delay instead of 0.75 seconds.
- KV reads/writes, Discord requests, and stored retention: no change.

## Acceptance criteria

- [ ] A first-attempt candle 429 makes exactly one provider request and throws
      `HyperliquidRateLimitError`.
- [ ] A scheduled primary-candle 429 preserves the existing Discord notice,
      incident deduplication, and next-success recovery behavior.
- [ ] A category 429 does not issue `metaAndAssetCtxs`, and a price-only brief
      remains available.
- [ ] A non-429 category failure may still use the frozen context basket.
- [ ] 5xx failures retry at most twice after the initial attempt, using the
      specified exponential delay and jitter bounds.
- [ ] Every failed response emits the specified safe structured log.
- [ ] Delta-seconds, HTTP-date, past, malformed, and absent `Retry-After` values
      normalize according to this contract.
- [ ] Existing TypeScript tests, typecheck, Python tests, contract parity, and
      whole-tree hygiene pass.
- [ ] No threshold, cadence, request payload, KV schema, or Discord-routing diff
      is present.

## Evidence required

This is provider-failure hardening, not a diagnostic promotion. It does not
need predictive or out-of-sample evidence. Promotion is limited to the runtime
change after deterministic request-count, retry-timing, structured-log,
fail-open, and scheduled-recovery tests pass.

Production logs after a later, separately authorized deployment may establish
whether top-of-hour failures share an operation, `Retry-After` value, or other
repeatable pattern. This change must not claim that root cause in advance.
