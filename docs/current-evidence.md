# Current Evidence and Limitations

This document records the schema-v3 delivery-aware validation of the frozen
SP500 reversal-zone rule. It remains a historical proxy study, not actual
trading performance or proof of a durable edge.

## Dataset and replay contract

- Market label: `SPX` historical proxy
- Coverage: January 2008 through July 2026
- Raw five-minute candles: `371,552`
- RTH replay candles: `361,773`
- Raw dataset SHA-256:
  `0374790bd961407ba5674f160d43f42f27354bce5dd6924c088689a4c25b627b`
- Schema: `3`
- Source timestamps: legacy naive Central wall clock repaired with
  `America/Chicago` IANA/DST rules
- Session: 09:30–16:00 `America/New_York`
- Replay: 15-minute requests, five-minute requests during 15:00–16:00 ET,
  catch-up evaluation of every completed candle
- Entry: first available delivery-time bar open, only while still inside the
  frozen entry zone
- Slippage: `0.25` underlying points per fill
- Round-trip cost: `0.10` underlying points
- Walk-forward-style view: fixed-calendar 24-month context followed by
  non-overlapping six-month test windows

The data has zero usable volume, no weekend candles, 281 unexpected
within-session intervals, and two partial session dates. VWAP therefore falls
back to average close. It cannot reproduce Hyperliquid perpetual basis,
funding, volume, spread, liquidity, or overnight behavior.

## Delivery and execution

The replay found 567 strict-alert signals:

| Delivery/execution status | Signals |
| --- | ---: |
| Filled | 333 |
| Outside entry zone at notification | 163 |
| Invalidation touched before notification | 47 |
| Next open outside entry zone | 15 |
| No same-session delivery bar | 9 |

The conservative current-stop result for the 333 filled trades was:

- average: `-0.44` points;
- average R: `-0.115R`;
- profit factor: `0.83`;
- win rate: `28.23%`; and
- maximum losing streak: `17`.

The session-cluster bootstrap PF interval was `0.57–1.20`; current-stop average
points ranged from `-1.23` to `+0.50`. The interval includes both losing and
profitable outcomes, while the point estimate remains below break-even.

## Directional results

| Direction | Signals | Executed | MFE at least 20 | EOD average | Stop average | Stop PF |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Bullish reversal | 468 | 259 | 14.74% | -0.21 | -0.52 | 0.82 |
| Bearish crash monitor | 99 | 74 | 4.04% | -0.38 | -0.18 | 0.91 |

Bullish signals show better raw MFE, but neither direction is profitable under
the executable current-stop policy.

## Rolling and portfolio constraints

The 33 fixed-calendar test windows contained 488 signals and 296 executed
trades:

- MFE at least 20 points: `14.14%`;
- EOD average: `-0.01` points;
- current-stop average: `-0.39` points; and
- current-stop PF: `0.86`.

The context rows do not train or select parameters. This is rolling
out-of-time stability reporting, not walk-forward optimization.

A single-position constraint selected 329 of 333 executable trades and skipped
four overlaps. Its average was `-0.43` points, average R was `-0.117R`, and PF
was `0.84`.

## Placebo interpretation

The real signals had better raw MFE than matched random locations, but also
worse median MAE. Executable current-stop PF ranked only at the `59.4`
percentile of the 1,000 placebo runs, and average points ranked at the `44.0`
percentile.

Only 178 of 567 signals had full volatility matches; 389 used the weaker
time-only fallback. Placebo results therefore support a price-location effect,
not a demonstrated executable edge.

## Periodic fragility classifier

The live Worker now reports a separate `RESILIENT` / `FRAGILE` / `BREAKING` /
`PANIC` market-repair state in periodic briefs. It counts transparent price,
VWAP, tail, breadth, and cross-index failures and does not alter the frozen
reversal signal gate.

Detailed live output may also include expanded breadth across active
Hyperliquid `xyz` contracts categorized as stocks. It is display-only context:
it does not change the six-indicator count, levels, score, mentions, or signal
eligibility. It has no historical replay in the canonical price-only study and
must not be described as exchange-wide cash-market or official-index breadth.

The separate schema-v1 price-only event study replayed 60,262 scheduled briefs
across 4,653 sessions from January 2008 through July 2026. Four price indicators
were available; historical `xyz:XYZ100` and constituent breadth remained
unavailable rather than being reconstructed with survivor-biased proxies.

| State | Observations | 120m >= 1% downside | Five-session >= 2% downside |
| --- | ---: | ---: | ---: |
| Resilient | 46,819 | 3.90% | 28.04% |
| Fragile | 9,535 | 4.94% | 29.89% |
| Breaking | 3,462 | 11.20% | 48.17% |
| Panic | 446 | 25.98% | 65.25% |

The ordered state is informative, especially at `BREAKING` and `PANIC`.
`FRAGILE` alone is weakly separated from `RESILIENT`: their moving-block 95%
intervals overlap at both headline horizons. Treating every `FRAGILE`-or-worse
brief as a downside prediction produced 6.96% precision, 33.56% recall, and
1.78x lift for a 1% 120-minute downside path. For a 2% five-session downside
path it produced 35.77% precision, 26.83% recall, and 1.28x lift.

The study uses the zero-volume close-mean fallback, so it is not yet a true
VWAP validation. Its score remains an ordinal diagnostic, not a calibrated
crash probability, strategy return, or approved live trading gate. The
canonical artifacts are under
`backtest/fragility-price-only-v1-2008-2026/`; the frozen methodology is in
`docs/fragility-backtest-methodology.md`.

The v2 rolling-origin candidate has lower Brier loss and log loss than
count-only at both 120-minute and five-session horizons, but its Brier Skill
Score remains negative versus the training-window base-rate forecast. Negative
skill is unfavorable: it means the candidate's Brier loss is higher than the
base-rate loss. It is not bundled into the Worker. Session-equal `FRAGILE` risk
is also slightly below `RESILIENT`, and the incremental high-risk `WORSENING`
phase interval crosses zero.

The simpler existing-v1 persistence rule also fails as a risk escalation. Of
441 evaluable first `BREAKING/PANIC` sessions, 263 were still
`BREAKING/PANIC` at the next due brief and 178 were transient. Anchoring the
outcome after that next brief, confirmed cases had a 6.84% 120-minute event
rate versus 12.92% for transient cases: -6.08 percentage points, with a
five-session moving-block 95% interval of -12.13 to -0.06 points. Persistence
is retained only as an opt-in diagnostic label and prospective collection
field, not a stronger alert. See `docs/fragility-v2-evaluation-report.md`.

## Permitted conclusion

The frozen rule identifies locations with more upside excursion than matched
random timestamps, but that excursion does not survive delivery timing,
entry-zone, stop, cost, and single-position constraints as positive
expectancy. The current strategy does not clear the project's promotion gate.

No claim of profitability, calibrated accuracy, future performance, option
P&L, or investment suitability is supported.
