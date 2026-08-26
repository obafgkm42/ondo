# Documentation map

Every document in this repository, grouped by the question it answers.

## Start here

| Document | Answers |
| --- | --- |
| [README](../README.md) | What does Market Ondo measure, and what does it refuse to claim? |
| [Roadmap](../ROADMAP.md) | What is built, what is the evidence boundary, and what comes next? |
| [Current evidence](current-evidence.md) | What do the studies actually show, including the negative results? |

## Methodology — the frozen measurement contracts

These define how each diagnostic is computed and evaluated. They are contracts:
changing one changes what the evidence means, so they are versioned and
referenced by the studies that depend on them.

| Document | Answers |
| --- | --- |
| [Market activity methodology](market-activity-methodology.md) | How is same-time RVOL computed, and which sessions enter the baseline? |
| [Fragility backtest methodology](fragility-backtest-methodology.md) | How is the six-mechanism classifier replayed and scored? |
| [Fragility v2 methodology](fragility-v2-methodology.md) | What did the rejected probability model propose, and how was it tested? |
| [Resilience decay methodology](resilience-decay-methodology.md) | How is post-drawdown recovery measured without lookahead? |
| [Backtest evaluation plan](backtest-evaluation-plan.md) | What must a signal prove before it may change live behavior? |
| [Market-data sources](market-data-sources.md) | Where does the data come from, and what may be done with it? |

## Evidence and decisions

Results, and the decisions taken because of them.

| Document | Answers |
| --- | --- |
| [Current evidence](current-evidence.md) | Full-sample and rolling results for the frozen reversal rule and the fragility classifier. |
| [Fragility v2 evaluation report](fragility-v2-evaluation-report.md) | Why the v2 probability model was rejected — `SHADOW_ONLY`, negative Brier Skill Score. |
| [Fragility shadow report](fragility-shadow-report.md) | What does one exported KV snapshot say about mechanism clustering? |

## Operations

| Document | Answers |
| --- | --- |
| [Operating Market Ondo](operations.md) | Discord setup, Cloudflare deployment, schedule, config modes, local development. |
| [Offline research commands](research-commands.md) | How do I run the event studies and backtests locally? |

## Process

| Document | Answers |
| --- | --- |
| [Development lifecycle](sdlc.md) | How does a change move from intent to spec to plan to review? |
| [AGENTS.md](../AGENTS.md) | What must a coding agent never break in this repository? |
| [Contributing](../CONTRIBUTING.md) | What do I run before opening a pull request? |
| [Work items](work/) | Per-change artifacts, and the templates for new ones. |

## Legal and policy

| Document | Answers |
| --- | --- |
| [Disclaimer](../DISCLAIMER.md) | What this software is not, and what it does not advise. |
| [Compliance notes](../COMPLIANCE.md) | What changes the regulatory picture — monetization, personalization, execution. |
| [Security policy](../SECURITY.md) | How to report a vulnerability. |
| [Third-party notices](../THIRD_PARTY_NOTICES.md) | Attribution for dependencies and services. |
| [MIT License](../LICENSE) | Covers original code and documentation only — not third-party market data. |

## Assets

- [`reversal-signal-candle-examples.svg`](reversal-signal-candle-examples.svg) —
  synthetic qualifying and non-qualifying rejection candles, referenced from
  the README.
