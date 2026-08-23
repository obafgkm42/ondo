# Market activity and RVOL-at-time

## Scope

The market-activity layer describes whether the current Hyperliquid SP500 RTH
session is quiet or active. It is diagnostic only: it does not alter the frozen
reversal signal thresholds, Discord mentions, or alert eligibility.

The implementation uses Hyperliquid candle `v` volume for the same market on
both sides of every ratio. It does not compare absolute volume across assets or
claim that venue volume equals consolidated cash-equity volume.

## Session and slots

- Session: 09:30-16:00 `America/New_York`.
- Grid: 26 fixed 15-minute slots.
- Live input: the existing completed five-minute candle request.
- One slot is valid only when all three aligned five-minute candles exist.
- Bootstrap input: aligned completed 15-minute candles.
- Only full standard US equity sessions enter durable history.

NYSE holidays and official 13:00 early closes are excluded because Hyperliquid
may still produce a complete weekday candle grid on those dates. The calendar
rules cover the recurring NYSE holiday schedule, Good Friday, and recurring
early closes. Unexpected exchange closures remain an operational data-quality
case and should be removed before calibration if observed. The current official
calendar is published at <https://www.nyse.com/trade/hours-calendars>.

## Metrics

For the latest completed slot `t`:

```text
session_rvol(t)
  = current cumulative RTH volume through t
    / mean cumulative volume through t in the previous 10 valid sessions

bar_rvol(t)
  = current 15-minute slot volume
    / mean volume in the same slot in the previous 10 valid sessions
```

The current session is always excluded from its own baseline. Five to nine
historical sessions produce a provisional ratio; 10 or more produce the normal
fixed-band classification. The first two completed slots are required, so the
state remains `FORMING` before 10:00 ET.

## Fixed classification

| State | Cumulative RVOL |
| --- | ---: |
| `DEADWATER` | `< 0.65` |
| `QUIET` | `0.65` to `< 0.85` |
| `NORMAL` | `0.85` to `< 1.20` |
| `ACTIVE` | `1.20` to `< 1.60` |
| `SURGE` | `>= 1.60` |

A ratio within `0.05` of any threshold is marked `borderline`. This metadata
does not introduce another market state.

The latest-slot burst diagnostic is separate:

- below `1.50x`: `ordinary`;
- `1.50x` to below `2.00x`: `elevated`;
- at least `2.00x`: `burst`.

A burst never overrides the cumulative session state.

## Historical distribution

At 20 historical sessions, the Worker starts ranking the current cumulative
volume against up to 60 prior observations from the same slot. Ties use midpoint
rank. Percentile bands are:

- `P0-P10`: extreme low;
- `P10-P25`: low;
- `P25-P75`: typical;
- `P75-P90`: high;
- `P90-P100`: extreme high.

Fixed factor bands remain the primary classification. Agreement between factor
direction and percentile direction is `confirmed`; disagreement is `mixed`.
Thresholds are not tuned automatically to force a desired label frequency.

Sample-depth quality is `insufficient` below 5 sessions, `provisional` from 5-9,
`limited` from 10-29, `good` from 30-59, and `full` at 60.

## State and resource contract

The `market-activity:v1:<market>` key stores at most 60 complete sessions, each
with 26 raw slot volumes, plus the last bootstrap attempt timestamp.

One activity evaluation performs:

- at most one `SCANNER_STATE` read;
- no write while an intraday session remains incomplete;
- at most one write when a complete session or bootstrap checkpoint changes;
- no steady-state market-data request beyond the existing five-minute fetch.

When fewer than 10 sessions exist, the first Cron invocation of a new Worker
version may immediately request an 18-calendar-day 15-minute history. The first
scheduled invocation between 16:00 and 17:00 ET remains the fallback retry path.
An underfilled or failed bootstrap may retry after 24 hours with a 30-day window.
The request is never made without durable KV state and is not made by manual
status queries.

Malformed state, KV failures, missing slots, zero baselines, and bootstrap
errors fail open: RVOL becomes `UNKNOWN` or is omitted while the scanner signal
and Discord delivery paths continue.

## Rollout and validation

`MARKET_ACTIVITY_MODE=shadow` logs the metrics and exposes them only through
authenticated/private status paths. After real-session review, `display` adds a
compact RVOL summary to the push preview and a detailed Discord field. Mention
routing and signal eligibility stay unchanged.

Calibration should inspect at least 30-60 real Hyperliquid sessions, per-slot
percentiles, label frequencies, gaps, and threshold churn. Activity labels alone
do not establish predictive value. Any future use as a signal filter requires a
new policy version and chronological out-of-sample evidence.
