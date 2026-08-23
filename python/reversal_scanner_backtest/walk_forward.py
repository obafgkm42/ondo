"""Calendar-based rolling evaluation for the frozen signal policy."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date

from reversal_scanner_backtest.reversal_study import (
    ReversalEvent,
    average_or_none,
    rate,
    trade_stats,
)


@dataclass(frozen=True)
class WalkForwardMetrics:
    """Compact signal and execution metrics for one calendar slice."""

    events: int
    executed_trades: int
    mfe20_rate: float | None
    eod_avg_points: float | None
    current_stop_avg_points: float | None
    current_stop_profit_factor: float | None


@dataclass(frozen=True)
class WalkForwardFold:
    """One chronological train/test fold with a frozen strategy."""

    train_start: str
    train_end_exclusive: str
    test_start: str
    test_end_exclusive: str
    train: WalkForwardMetrics
    test: WalkForwardMetrics


@dataclass(frozen=True)
class WalkForwardSummary:
    """Rolling stability report without in-fold parameter selection."""

    train_months: int
    test_months: int
    fold_count: int
    folds: list[WalkForwardFold]
    combined_test: WalkForwardMetrics

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-compatible summary."""

        return asdict(self)


def build_walk_forward_summary(
    events: list[ReversalEvent],
    train_months: int,
    test_months: int,
    calendar_start: date | None = None,
    calendar_end: date | None = None,
) -> WalkForwardSummary | None:
    """Build fixed-calendar rolling test folds from chronological events."""

    if not events:
        return None
    if train_months <= 0 or test_months <= 0:
        raise ValueError("walk-forward month counts must be positive")

    ordered = sorted(events, key=lambda event: (event.date, event.timestamp))
    first_date = calendar_start or date.fromisoformat(ordered[0].date)
    last_date = calendar_end or date.fromisoformat(ordered[-1].date)
    if last_date < first_date:
        raise ValueError("walk-forward calendar end precedes start")
    train_start = date(first_date.year, first_date.month, 1)
    folds: list[WalkForwardFold] = []
    combined_test_events: list[ReversalEvent] = []

    while True:
        train_end = add_months(train_start, train_months)
        test_end = add_months(train_end, test_months)
        if test_end > first_day_of_next_month(last_date):
            break
        train_events = events_between(ordered, train_start, train_end)
        test_events = events_between(ordered, train_end, test_end)
        folds.append(
            WalkForwardFold(
                train_start=train_start.isoformat(),
                train_end_exclusive=train_end.isoformat(),
                test_start=train_end.isoformat(),
                test_end_exclusive=test_end.isoformat(),
                train=summarize_slice(train_events),
                test=summarize_slice(test_events),
            )
        )
        combined_test_events.extend(test_events)
        train_start = add_months(train_start, test_months)

    return WalkForwardSummary(
        train_months=train_months,
        test_months=test_months,
        fold_count=len(folds),
        folds=folds,
        combined_test=summarize_slice(combined_test_events),
    )


def summarize_slice(events: list[ReversalEvent]) -> WalkForwardMetrics:
    """Summarize a chronological event slice."""

    stop_stats = trade_stats(
        [event.current_stop.get("conservative") for event in events]
    )
    return WalkForwardMetrics(
        events=len(events),
        executed_trades=stop_stats.trades,
        mfe20_rate=rate(events, lambda event: event.hit20_mfe),
        eod_avg_points=average_or_none(
            event.eod_directional_points for event in events
        ),
        current_stop_avg_points=stop_stats.avg_points,
        current_stop_profit_factor=stop_stats.profit_factor,
    )


def events_between(
    events: list[ReversalEvent],
    start: date,
    end: date,
) -> list[ReversalEvent]:
    """Return events in a half-open calendar interval."""

    return [
        event
        for event in events
        if start <= date.fromisoformat(event.date) < end
    ]


def add_months(value: date, months: int) -> date:
    """Add whole calendar months to a first-of-month date."""

    month_index = value.year * 12 + value.month - 1 + months
    return date(month_index // 12, month_index % 12 + 1, 1)


def first_day_of_next_month(value: date) -> date:
    """Return the first day after the month containing a date."""

    return add_months(date(value.year, value.month, 1), 1)


def render_walk_forward_markdown(
    summary: WalkForwardSummary | None,
) -> str:
    """Render rolling train/test stability metrics."""

    if summary is None:
        return "# Walk-Forward Stability\n\nNo events available.\n"
    lines = [
        "# Rolling Out-of-Time Stability",
        "",
        (
            f"Frozen rule · context={summary.train_months} months · "
            f"test={summary.test_months} months · folds={summary.fold_count}"
        ),
        "",
        "No parameters are selected inside these folds; context rows do not train the rule and test rows measure chronological stability.",
        "",
        "| test period | context signals | test signals | executed trades | test MFE >= 20 | test EOD avg | test stop avg | test stop PF |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for fold in summary.folds:
        lines.append(
            "| "
            f"{fold.test_start} to {fold.test_end_exclusive} | "
            f"{fold.train.events} | {fold.test.events} | "
            f"{fold.test.executed_trades} | "
            f"{format_percent(fold.test.mfe20_rate)} | "
            f"{format_number(fold.test.eod_avg_points)} | "
            f"{format_number(fold.test.current_stop_avg_points)} | "
            f"{format_number(fold.test.current_stop_profit_factor)} |"
        )
    lines.extend(
        [
            "",
            "## Combined Non-Overlapping Test Windows",
            "",
            f"events={summary.combined_test.events}",
            f"executed trades={summary.combined_test.executed_trades}",
            f"MFE >= 20={format_percent(summary.combined_test.mfe20_rate)}",
            f"EOD avg={format_number(summary.combined_test.eod_avg_points)}",
            f"current-stop avg={format_number(summary.combined_test.current_stop_avg_points)}",
            f"current-stop PF={format_number(summary.combined_test.current_stop_profit_factor)}",
        ]
    )
    return "\n".join(lines) + "\n"


def format_number(value: float | None) -> str:
    """Format a nullable number for Markdown."""

    return "n/a" if value is None else f"{value:.2f}"


def format_percent(value: float | None) -> str:
    """Format a nullable rate for Markdown."""

    return "n/a" if value is None else f"{value * 100:.2f}%"
