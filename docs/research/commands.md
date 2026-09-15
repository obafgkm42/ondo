# Offline research commands

Back to the [documentation map](../README.md).

Reproducible local event studies and backtests. These run entirely outside the
Worker runtime and never touch the live deployment. For deployment and runtime
configuration, see [Operating Market Ondo](../operations/runtime.md).

The repository contains only synthetic fixtures. Bring lawfully obtained data
and review its licence before use.

### Reversal event study

```bash
uv run reversal-scanner-backtest \
  --input tests/fixtures/synthetic-candles.json \
  --output backtest/smoke/reversal_backtest.json \
  --output-dir backtest/smoke \
  --replay-mode every-bar \
  --source-timezone UTC \
  --placebo-runs 0 \
  --bootstrap-runs 0
```

### Fragility event study and rejected v2 candidate

```bash
uv run fragility-backtest \
  --input path/to/SPX_full_5min_CT.json \
  --output-dir backtest/fragility-price-only-v1 \
  --source-timezone America/Chicago \
  --source-timestamp-mode naive-local

uv run fragility-v2-evaluate \
  --input-observations backtest/fragility-price-only-v1/events/fragility_observations.csv \
  --output-dir backtest/fragility-v2-shadow \
  --bootstrap-runs 1000
```

### Prospective fragility snapshot

One manual KV export can be analysed completely offline:

```bash
mkdir -p reports/generated
npx wrangler kv key get \
  "market-fragility-v2-shadow:xyz:SP500" \
  --binding SCANNER_STATE \
  --remote \
  --text > reports/generated/fragility-shadow-state.json

uv run fragility-shadow-report \
  --input-state reports/generated/fragility-shadow-state.json
```

The ignored report separates repeated brief counts from unique-session
prevalence. It is descriptive telemetry only: it does not alter the classifier,
Discord routing, thresholds, colors, mentions, or Worker runtime.

The default output directory is
`reports/generated/fragility-shadow/`. It contains a versioned JSON payload and
a compact Markdown report. The parser accepts current schema v4 and legacy v2/v3
state, but never invents missing mechanism identities or availability.

The separate stage B price-only snapshot can be exported without touching the
live half-hour key:

```bash
npx wrangler kv key get \
  "rth-shadow-acquisition-5m:v1:xyz:SP500" \
  --binding SCANNER_STATE \
  --remote \
  --text > reports/generated/rth-shadow-acquisition-5m.json

npm run audit:rth-shadow -- \
  reports/generated/rth-shadow-acquisition-5m.json
```

Keep this licensed research snapshot private. Its rows include `acquiredAt`
and `context.status=not_collected`, so delayed catch-up is distinguishable and
cannot be mistaken for contemporaneous six-mechanism coverage.

The audit command prints summary metadata, retained rows per session, complete
78-row five-minute grid counts, timestamp anomalies, and acquisition delay
percentiles. It does not emit prices or indicator values. A partial first or
latest session remains below 100%; do not treat that alone as a failed pilot.

For a fixed pilot window, pass a second local JSON file containing the expected
completed standard-session dates, for example `["2026-09-15", "2026-09-16"]`.
The audit then reports entirely missing sessions and calculates capture against
the explicit `78 * expected sessions` denominator:

```bash
npm run audit:rth-shadow -- snapshot.json expected-sessions.json
```

With ten expected sessions, the summary evaluates only the acquisition evidence:
at least 99% capture, p95 delay no greater than 60 seconds, and no timestamp
anomalies. A `pass` is not a full operational pass; provider request budgets,
429s, duplicate notifications, and Worker resource use remain explicitly
unassessed and require separate traces.

Interpret the output using these denominators:

- level, transition, family, and mechanism counts use retained observations;
- mechanism and family prevalence count each affected `BREAKING` or `PANIC`
  session once;
- duration uses one maximum continuously observed high-stress duration per
  evaluable session, separate from wall-clock elapsed time; and
- confirmation uses sessions containing a `PENDING` or `CONFIRMED` candidate.

The 30-session marker is only a descriptive collection checkpoint. Rolling KV
is not a complete archive, repeated intraday briefs are dependent, and the state
cannot estimate data-health exclusion frequency. It does not establish a
promotion gate, alert rule, or trading inference.

### Resilience event study

```bash
uv run resilience-decay-backtest \
  --input path/to/SPX_full_5min_CT.json \
  --output-dir backtest/resilience-decay-v1 \
  --source-timezone America/Chicago \
  --source-timestamp-mode naive-local \
  --session-timezone America/New_York
```

Generated `backtest/` and `reports/generated/` outputs are ignored by Git. The
TypeScript live path pins the shared `market-data-pipeline` revision in
`package.json`; canonical input contracts are documented in
[Market-data sources](../reference/market-data-sources.md).
