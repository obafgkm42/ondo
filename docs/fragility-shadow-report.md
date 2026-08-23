# Fragility Shadow Snapshot Report

## Purpose

The report turns one manually exported `market-fragility-v2-shadow` KV value
into bounded, offline descriptive telemetry. It answers whether retained
`BREAKING` and `PANIC` observations are clustering by exact stressed mechanism,
correlated mechanism family, persistence status, transition, and session-level
duration.

It does not modify the frozen v1 classifier, Discord routing, thresholds,
colors, mentions, reversal scanner, or Worker runtime. It performs no
Hyperliquid request and adds no Worker endpoint or schedule.

## One-read export

Export the configured market's current value from the existing namespace:

```bash
mkdir -p reports/generated
npx wrangler kv key get \
  "market-fragility-v2-shadow:xyz:SP500" \
  --binding SCANNER_STATE \
  --remote \
  --text > reports/generated/fragility-shadow-state.json
```

This command is an on-demand single KV read. It does not create a recurring
Cloudflare workload. `reports/generated/` is ignored by Git so an account's
live snapshot is not committed accidentally.

Run the local report:

```bash
uv run fragility-shadow-report \
  --input-state reports/generated/fragility-shadow-state.json
```

The default output directory is `reports/generated/fragility-shadow/` and
contains:

- `fragility_shadow_report.json`: schema-v1 payload, input SHA-256, run ID,
  source version, summary, latest observation, and limitations;
- `fragility_shadow_report.md`: compact human-readable cluster report.

Use `--output-dir` to choose another ignored local directory.

## Counting contract

Due briefs within the same session are not independent observations. The
report therefore keeps the following denominators separate:

- level, transition, family breadth, and mechanism occurrence counts are raw
  retained observation counts;
- mechanism and family prevalence count each affected `BREAKING/PANIC` session
  once;
- duration uses one maximum `BREAKING/PANIC` duration per evaluable session;
- P90 duration uses the deterministic nearest-rank definition;
- the confirmation rate is confirmed sessions divided by sessions that contain
  a `PENDING` or `CONFIRMED` candidate in the retained window.

The `30`-session marker is only a collection/readiness label for descriptive
review. It is not a statistical power result, promotion gate, alert gate, or
trading rule.

## Schema and bounds

The parser accepts current schema v3 and legacy schema v2. V2 rows are
normalized exactly as the Worker migration does: transition is `UNAVAILABLE`,
mechanism and family arrays are empty, elapsed duration is zero, and
`mechanismHistoryAvailable` is false. The report never invents missing
mechanisms from a legacy stressed-indicator count.

Input is rejected when its structure, enums, finite numeric fields, chronology,
unique session keys, or storage bounds are invalid. The accepted production
window is at most 60 sessions and 16 observations per session.

## Interpretation limits

This is descriptive shadow telemetry only. It makes no alert, threshold,
strategy, or trading inference. In particular:

- the rolling KV state is not a complete historical archive;
- multiple observations within a session remain dependent even when raw counts
  are useful for path description;
- schema-v2 observations do not contain mechanism identities or usable elapsed
  duration;
- the state does not retain data-health exclusions, so it cannot estimate
  stale, gap, holiday, early-close, or overnight exclusion frequency;
- auditing those exclusions requires a separate export of Cloudflare Worker
  logs, not more fields or requests in the live scanner.
