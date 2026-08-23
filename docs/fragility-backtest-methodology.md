# Market Fragility Backtest Methodology

This document defines the reproducible research contract for the periodic
`RESILIENT` / `FRAGILE` / `BREAKING` / `PANIC` classifier. It is separate from
the reversal trade-policy study because market-state classification and
executable strategy PnL answer different questions.

## Research Question

The primary question is:

> When several normally reliable repair mechanisms fail together, does the
> subsequent downside path become more frequent or more severe than it is in a
> resilient state?

The first study is an event study. It does not assume that `FRAGILE` means
short, that `PANIC` should be chased, or that an index return equals option PnL.

## Schema And Versioning

The first reproducible output uses schema version 1 and classifier version
`fragility-price-only-v1`. Every run records:

- input path label and SHA-256;
- source timezone and timestamp interpretation;
- validation errors and warnings;
- Git commit and dirty-worktree status when available;
- all classifier thresholds;
- replay, horizon, bootstrap, and rolling-stability settings;
- the effective VWAP mode;
- a methodology fingerprint; and
- a deterministic run ID derived from the data and methodology fingerprints.

Two runs with different methodology fingerprints must not be treated as a
clean threshold comparison until the changed inputs and rules are reconciled.
The CLI accepts `--compare-to` to produce a compact baseline/candidate report.

## Frozen Classifier Contract

The live TypeScript implementation in `src/market-fragility.ts` remains the
source contract. Python repeats its numeric constants and regression tests fail
if the two implementations drift.

The price-only replay exposes four of six indicators:

1. session loss: latest close / first session open - 1 <= -1.0%;
2. VWAP repair failure: close-to-VWAP gap <= -0.35 ATR and the last three
   closes remain below session VWAP;
3. poor close location: latest close is in the bottom 25% of the observed
   session range; and
4. downside-tail cluster: at least two of the latest 12 returns are below the
   larger of -0.25% or twice the median absolute return.

Historical breadth and SP500/XYZ100 context are not fabricated. They remain
`unavailable`, so the first study is always marked `partial` with four of six
indicators. The ordinal mapping remains frozen:

- zero or one stressed mechanism: `RESILIENT`;
- two: `FRAGILE`;
- three: `BREAKING`; and
- four or more: `PANIC`.

Scores remain `0, 15, 35, 60, 80, 90, 100` for zero through six stressed
mechanisms. A score is not a calibrated probability.

## Replay Contract

The canonical first run uses five-minute candles and the New York cash session:

- session: 09:30–16:00 `America/New_York`;
- evaluation: completed candles only;
- brief cadence: every 30 minutes;
- first eligible observation: the 10:00 brief after six completed candles;
- no future candle may enter classification; and
- future candles are used only to label outcomes after the state is frozen.

All scheduled observations are retained because that matches what the user
would have seen. A second sample keeps only the first `FRAGILE`-or-worse
observation per session to reduce repeated-state counting.

## VWAP Data Contract

SPX is a calculated index and has no centralized executable share volume. A
five-minute OHLC source with zero volume forces the same fallback used by the
live code: arithmetic mean close. Such a run is labeled
`close-mean-fallback`, not true VWAP.

The CLI can accept an aligned `--volume-input` candle file. It copies only the
proxy volume onto the primary SPX candles, leaving all SPX prices unchanged.
This produces a proxy-volume-weighted SPX typical price and is labeled
`proxy-volume-weighted-primary-typical-price`. It is not represented as the
provider's own SPY or ES VWAP.

Suitable future sensitivity sources include:

- SPY consolidated or exchange-specific minute volume for the cash session;
- ES/MES futures minute volume for broader overnight coverage; and
- archived Hyperliquid `xyz:SP500` volume for exact venue continuity going
  forward.

The primary and proxy files must use the same five-minute boundaries after
DST-aware timezone conversion. The run records the proxy file hash and match
rate. A change in VWAP source changes the methodology fingerprint.

## Forward Outcomes

Each observation stores close return, minimum path return, and maximum path
return for:

- 30, 60, and 120 completed minutes;
- the remainder of the current session;
- the next complete session; and
- the next five complete sessions.

A horizon is `null` when the complete path is unavailable. It is not shortened
to fit the remaining data.

Predeclared downside events are:

| horizon | event |
| --- | ---: |
| 30 minutes | minimum return <= -0.50% |
| 60 minutes | minimum return <= -0.75% |
| 120 minutes | minimum return <= -1.00% |
| end of session | minimum return <= -1.00% |
| next session | minimum return <= -1.50% |
| next five sessions | minimum return <= -2.00% |

These path labels evaluate whether weakness persisted. They are not trade exits
and do not deduct spreads, slippage, option premium, or implied volatility.

## Evaluation Metrics

The report includes:

- state frequency and session coverage;
- forward close, minimum, and maximum returns by state;
- downside-event rate by state and horizon;
- `FRAGILE`-or-worse precision, recall, false-alarm rate, and lift versus the
  `RESILIENT` event rate;
- first fragile-or-worse observation per session;
- state-transition counts;
- annual slices; and
- rolling 24-month context / six-month non-overlapping test slices.

Context windows never select parameters. They describe the preceding market;
test windows show chronological stability of the already frozen rule.

## Dependence And Confidence Intervals

Thirty-minute observations from one session are not independent, and
five-session outcome paths overlap. The report therefore does not use ordinary
row-level standard errors. It applies a deterministic circular moving-block
bootstrap with five consecutive sessions per block, 1,000 runs, and seed 42 by
default.

Moving blocks reduce false precision caused by repeated briefs and neighboring
sessions. They do not eliminate structural breaks, vendor errors, or the bias
introduced by a limited historical sample.

## Canonical Command

```bash
uv run fragility-backtest \
  --input path/to/SPX_full_5min_CT.json \
  --output-dir backtest/fragility-price-only-v1 \
  --source-label selected-local-SPX-5m-cache \
  --source-timezone America/Chicago \
  --source-timestamp-mode naive-local \
  --session-timezone America/New_York \
  --brief-interval-minutes 30 \
  --bootstrap-runs 1000 \
  --bootstrap-block-sessions 5 \
  --walk-forward-train-months 24 \
  --walk-forward-test-months 6
```

The JSON array reader retains only one RTH session while classifying. The input
is intentionally read twice: once for validation and once for replay, avoiding
the need to load every candle object simultaneously.

Generated outputs live under ignored `backtest/` directories:

- `fragility_backtest.json`: complete reproducibility and summary payload;
- `events/fragility_observations.csv`: auditable observation rows;
- `reports/fragility_summary.md`: headline state-conditioned results;
- `reports/yearly_summary.csv`: stable annual comparison columns;
- `reports/rolling_stability.md`: chronological stability; and
- `methodology/methodology_snapshot.json`: comparison contract.

## Change And Promotion Rules

Threshold changes must be proposed before reading their final holdout results.
Any optimizer must train only on past data and preserve a final untouched
holdout. Improvements should be judged on out-of-time lift, precision, recall,
false alarms, state prevalence, and stability across crises and quiet markets,
not on one full-sample headline.

The classifier is not promoted into a live trading gate until:

- it improves downside identification out of time;
- moving-block intervals show useful separation from `RESILIENT`;
- results survive a real-volume sensitivity run;
- no single crisis dominates the conclusion; and
- a separately specified trade or option policy passes its own execution and
  cost study.
