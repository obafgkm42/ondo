# Offline research commands

Reproducible local event studies and backtests. These run entirely outside the
Worker runtime and never touch the live deployment. For deployment and runtime
configuration, see [Operating Market Ondo](operations.md).

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
prevalence. It is descriptive telemetry only. See
[Fragility shadow snapshot report](fragility-shadow-report.md).

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
[Market-data sources](market-data-sources.md).
