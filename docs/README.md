# Documentation map

Canonical documents grouped by purpose. Keep new material in the narrowest
matching folder instead of adding Markdown files to the repository root.

## Start here

- [README](../README.md) — product scope and claim boundaries.
- [Roadmap](planning/roadmap.md) — completed milestones, open work, and the
  evidence boundary.
- [Current evidence](evidence/current-evidence.md) — study results, including
  negative findings.

## Methodology — the frozen measurement contracts

These define how each diagnostic is computed and evaluated. They are contracts:
changing one changes what the evidence means, so they are versioned and
referenced by the studies that depend on them.

- [Market activity methodology](methodology/market-activity-methodology.md) —
  same-time RVOL and baseline-session rules.
- [Fragility backtest methodology][fragility-methodology] — replay and scoring
  for the six-mechanism classifier.
- [Fragility v2 methodology](methodology/fragility-v2-methodology.md) — the
  rejected probability candidate and its test contract.
- [Resilience decay methodology][resilience-methodology] — post-drawdown
  recovery measurement without lookahead.
- [Backtest evaluation plan](methodology/backtest-evaluation-plan.md) — the
  promotion gate for live behavior changes.

## Evidence and decisions

Results, and the decisions taken because of them.

- [Current evidence](evidence/current-evidence.md) — full-sample and rolling
  results for the frozen reversal rule and fragility classifier.
- [Fragility v2 evaluation report][fragility-v2-report] — why the probability
  model was rejected and remains `SHADOW_ONLY`.

## Operations

- [Operating Market Ondo](operations/runtime.md) — Discord setup, Cloudflare
  deployment, schedules, modes, and local development.
- [Offline research commands](research/commands.md) — local event studies and
  backtests.
- [Market-data sources](reference/market-data-sources.md) — provider and usage
  boundaries.

## Process

- [AGENTS.md](../AGENTS.md) — repository invariants for coding agents.
- [Contributing](../CONTRIBUTING.md) — change scope, verification, and pull
  request guidance.

## Legal and policy

- [Disclaimer](policies/disclaimer.md) — what the software does not advise.
- [Compliance notes](policies/compliance.md) — regulatory and platform-risk
  boundaries.
- [Security policy](../SECURITY.md) — vulnerability reporting.
- [Third-party notices](policies/third-party-notices.md) — dependency and
  service attribution.
- [MIT License](../LICENSE) — original code and documentation only, not
  third-party market data.

## Assets

- [`reversal-signal-candle-examples.svg`][candle-examples] —
  synthetic qualifying and non-qualifying rejection candles, referenced from
  the README.

[fragility-methodology]: methodology/fragility-backtest-methodology.md
[fragility-v2-report]: evidence/fragility-v2-evaluation-report.md
[resilience-methodology]: methodology/resilience-decay-methodology.md
[candle-examples]: assets/reversal-signal-candle-examples.svg
