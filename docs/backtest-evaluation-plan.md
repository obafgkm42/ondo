# Backtest Evaluation Plan

This project evaluates the frozen SP500 reversal-zone signal in two separate
layers:

1. a signal event study measured from the completed signal candle close; and
2. an executable trade-policy study with explicit entry, fill, cost, and
   portfolio assumptions.

Underlying MFE is not option PnL. Option premium, spread, implied volatility,
Greeks, expiry selection, and liquidity must remain explicitly unmodeled until
historical option quotes are available.

## Frozen Signal Contract

The live implementation remains `src/signal-engine.ts`. The local research port
is `python/reversal_scanner_backtest/signal_engine.py`. Python regression tests
compare frozen numeric constants with the TypeScript source and compare frozen
thresholds with `wrangler.toml` so drift fails validation.

The v1 thresholds remain:

- watch: price-R >= 2 and score >= 64;
- alert: price-R >= 3.5 and score >= 72;
- signal price: latest completed candle close;
- invalidation and target: frozen values emitted at signal time.

The score is a deterministic heuristic score, not a calibrated probability or
statistical confidence interval.

## Reproducible Runner

The default CLI contract uses schema version 3:

```bash
uv run reversal-scanner-backtest \
  --input path/to/candles.json \
  --output backtest/reversal_backtest.json \
  --output-dir backtest \
  --replay-mode live \
  --entry-mode next-open \
  --source-timezone America/Chicago \
  --source-timestamp-mode naive-local \
  --session-profile rth \
  --slippage-points 0.25 \
  --round-trip-cost-points 0.10 \
  --walk-forward-train-months 24 \
  --walk-forward-test-months 6
```

Every output records the input SHA-256, schema version, source/session timezone,
data-quality results, replay cadence, lookback window, signal scope, and
execution assumptions. Reports created by older ignored runners that do not
contain this metadata are historical scratch evidence and must not be presented
as current reproducible results.

## Live Replay

`--replay-mode live` mirrors the production scanner:

- request at the configured 15-minute cadence outside the New York final hour;
- request every 5 minutes from 15:00 to 16:00 New York time;
- evaluate every completed five-minute candle exposed by each catch-up request;
- record when the signal first becomes observable;
- expire signals that touched stop/target or left the entry zone before delivery;
- expose no more than the configured 18-hour candle request window; and
- use the 09:30–16:00 `America/New_York` RTH session for trade alerts.

`--replay-mode every-bar` is retained only for research sensitivity. It exposes
the full active-session history instead of the bounded live request window.
Live signals keep both their candle timestamp and delivery timestamp. Overnight
candles remain available to live status briefs, but do not generate trade
alerts until an overnight rule has separate validation.

Strict alerts are evaluated by default. `--signal-scope watch-and-alert` is a
separate notification-opportunity study and must not be mixed with alert-only
trade results.

## Data Contract

Before replay, the runner validates:

- monotonically increasing and unique candle timestamps;
- finite and internally valid OHLC values;
- exact candle duration;
- non-negative volume; and
- unexpected missing intervals inside a session date.

Zero-volume and no-weekend datasets produce explicit warnings. A zero-volume
dataset forces the signal VWAP calculation to fall back to average close and is
not equivalent to live Hyperliquid VWAP.

Naive Central Time text must be converted with IANA timezone rules rather than
a fixed offset:

```bash
node scripts/convert-ohlc-to-candles.mjs \
  --input path/to/SPX_CT.csv \
  --output data/local/spx-utc.json \
  --date-column datetime \
  --open-column open \
  --high-column high \
  --low-column low \
  --close-column close \
  --interval-minutes 5 \
  --date-format "yyyy-mm-dd hh:mm:ss" \
  --timezone America/Chicago
```

Legacy JSON that stored Central wall-clock values directly as UTC epochs can be
repaired at load time with `--source-timestamp-mode naive-local`. The RTH
profile rejects broad timestamp misalignment when at least 1% of source dates
do not begin at 09:30 New York time.

## Execution Contract

Signal-distribution metrics continue to use the signal close so MFE/MAE remain
comparable with the frozen event definition. Trade-policy metrics default to the
first available delivery-time bar open and:

- require the notification-time price and entry open to remain in the frozen
  entry zone;
- skip signals whose stop or target was touched before delivery;
- skip an entry if the frozen stop or target was already passed;
- use the worse opening price when a candle gaps through a stop;
- apply adverse slippage to entry and exit fills;
- deduct configured round-trip point cost; and
- calculate R from the actual entry-to-stop risk for every stop or delayed-entry
  variant.

Overlapping event rows remain valid signal observations. The canonical report
also emits `reports/single_position_summary.md`, which keeps the first
executable signal while a conservative current-stop position remains open.

## Statistical Evaluation

The required report contains:

- event and filled/skipped execution counts;
- separate bullish and bearish summaries in `reports/direction_summary.md`;
- MFE, MAE, EOD, stop/target, retry, and delayed-entry results;
- volatility- and session-range-matched placebo distributions;
- direction-aware placebo advantage percentiles, where lower MAE is better;
- session-date cluster-bootstrap 95% intervals for hit rate, EOD mean, stop
  expectancy, and profit factor; and
- explicit cost and fill assumptions.

Placebo candidates match weekday, exact five-minute clock slot, trailing ATR, and observed
session-range-in-ATR, and exclude the real event date. When fewer than 20 close
volatility matches exist, the comparison falls back to the time-matched pool and
should be treated as lower-confidence evidence. Placebo executions inherit the
matched real event's notification latency and the same entry-zone rules.

## Walk-Forward And Promotion Gate

The runner emits `reports/walk_forward_summary.md`. Its default frozen-rule
stability view uses a rolling 24-month context window and a following six-month
test window, advancing by six months so test windows do not overlap. All
versions use the dataset calendar as a common anchor. Context rows do not
select parameters or train the rule.

Parameter selection remains future work. Any optimizer must use these same
chronological boundaries and past data only. A final holdout must remain
untouched until all rules, costs, and metrics have been frozen.

Promotion requires all of the following:

- positive out-of-sample net expectancy with a cluster-aware interval that does
  not rely on treating clustered signals as independent;
- results that remain positive under predeclared slippage and cost scenarios;
- no single fold or crisis period contributing a dominant share of profit;
- acceptable drawdown and losing-streak behavior; and
- independently useful results for bullish reversal trades and bearish crash
  monitoring, evaluated as different tasks.

No threshold should be promoted from MFE percentile alone.

## Separate Market Fragility Study

The periodic fragility state is evaluated by a separate schema-v1 classifier
event study. It freezes the live price thresholds, replays scheduled status
briefs, labels forward price paths, uses moving-block confidence intervals, and
emits annual and rolling chronological stability views. It does not convert a
market state into strategy or option PnL.

See [Market fragility backtest methodology](fragility-backtest-methodology.md)
for the complete versioning, VWAP-source, outcome, and comparison contract.

The v2 research layer then compares count-only, indicator-weighted, and
continuous/dynamic regularized probability models. It uses nested
chronological fitting, tuning, and calibration inside each context window,
session-equal weights, proper scoring rules, session-block comparisons, and a
separate causal repair phase. Negative Brier Skill Score (higher Brier loss
than the base-rate forecast) prevents shipping the candidate model; the
existing-v1 two-brief confirmation rule is evaluated with its outcome anchored
after the confirmation brief. Historical results can
authorize only opt-in diagnostic collection. See
[Market fragility v2 methodology](fragility-v2-methodology.md) and the frozen
[evaluation report](fragility-v2-evaluation-report.md).

## Separate Resilience-Decay Study

The event-level resilience diagnostic has its own schema-v1 replay. It mirrors
the live half-hour grid without lookahead, reports complete-case coverage,
collapses prediction rows to one per session, uses session-block intervals,
and audits fixed path and threshold variants. Its current `FADING` cohort is
too sparse to evaluate, so the study cannot authorize a live behavior change.

See [Resilience decay methodology](resilience-decay-methodology.md) for the
replay command, first full-sample findings, and calibration plan.
