"""Train-only fragility-v2 probability, phase, and state evaluation."""

from __future__ import annotations

import math
import random
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date
from typing import Literal

import numpy as np
from numpy.typing import NDArray

from reversal_scanner_backtest.probability_evaluation import (
    FloatArray,
    LogisticProbabilityModel,
    ProbabilityCalibrator,
    fit_logistic_probability_model,
    fit_probability_calibrator,
    probability_metrics,
    session_equal_weights,
)
from reversal_scanner_backtest.walk_forward import (
    add_months,
    first_day_of_next_month,
)

FragilityPhase = Literal["IMPROVING", "STABLE", "WORSENING"]
CandidateLevel = Literal["resilient", "fragile", "breaking", "panic"]
OutcomeHorizon = Literal["120m", "5sessions"]

MODEL_REGULARIZATION_GRID = (0.001, 0.01, 0.1, 1.0)
PRICE_INDICATORS = (
    "session_loss",
    "vwap_repair_failure",
    "poor_close_location",
    "downside_tail_cluster",
)
OUTCOME_HORIZONS: tuple[OutcomeHorizon, ...] = ("120m", "5sessions")


@dataclass(frozen=True)
class FragilityV2Row:
    """One causal feature row with future labels attached separately."""

    row_id: int
    timestamp: int
    session_date: str
    session_time: str
    level: CandidateLevel
    stressed_indicator_count: int
    indicator_flags: tuple[float, float, float, float]
    severity_margins: tuple[float, float, float, float]
    prior_stressed_indicator_count: int
    failure_streak: int
    outcomes: dict[OutcomeHorizon, bool | None]

    @property
    def time_fraction(self) -> float:
        """Return the completed RTH fraction at this observation."""

        hour_text, minute_text = self.session_time.split(":", maxsplit=1)
        minute_of_day = int(hour_text) * 60 + int(minute_text)
        return min(1.0, max(0.0, (minute_of_day - 570) / 390))


@dataclass(frozen=True)
class FragilityV2Settings:
    """Frozen rolling-origin and uncertainty settings."""

    context_months: int = 24
    test_months: int = 6
    bootstrap_runs: int = 1_000
    bootstrap_seed: int = 42
    bootstrap_block_sessions: int = 5

    def validate(self) -> None:
        """Raise when evaluation settings are invalid."""

        if self.context_months <= 0 or self.test_months <= 0:
            raise ValueError("context and test months must be positive")
        if self.bootstrap_runs < 0:
            raise ValueError("bootstrap_runs cannot be negative")
        if self.bootstrap_block_sessions <= 0:
            raise ValueError("bootstrap_block_sessions must be positive")


@dataclass(frozen=True)
class FragilityModelSpec:
    """Named, predeclared model feature contract."""

    name: str
    feature_names: tuple[str, ...]


MODEL_SPECS = (
    FragilityModelSpec(
        "count_only",
        ("stressed_indicator_count", "time_fraction"),
    ),
    FragilityModelSpec(
        "weighted_flags",
        (
            "session_loss_flag",
            "vwap_repair_failure_flag",
            "poor_close_location_flag",
            "downside_tail_cluster_flag",
            "time_fraction",
        ),
    ),
    FragilityModelSpec(
        "continuous_dynamic",
        (
            "session_loss_flag",
            "vwap_repair_failure_flag",
            "poor_close_location_flag",
            "downside_tail_cluster_flag",
            "session_loss_severity",
            "vwap_repair_failure_severity",
            "poor_close_location_severity",
            "downside_tail_cluster_severity",
            "time_fraction",
            "prior_stressed_indicator_count",
            "failure_streak",
        ),
    ),
)


@dataclass(frozen=True)
class OutOfSamplePrediction:
    """One prediction emitted only for a future rolling test fold."""

    row: FragilityV2Row
    horizon: OutcomeHorizon
    model_name: str
    fold_index: int
    raw_probability: float
    calibrated_probability: float
    training_base_rate: float
    state_cutpoints: tuple[float, float, float] | None
    phase_parameters: tuple[float, float] | None


@dataclass(frozen=True)
class _FittedFoldModel:
    spec: FragilityModelSpec
    model: LogisticProbabilityModel
    calibrator: ProbabilityCalibrator
    regularization: float
    training_base_rate: float


def normalized_severity_margins(
    session_loss: float,
    vwap_gap_atr: float,
    close_location: float,
    downside_tail_count: float,
) -> tuple[float, float, float, float]:
    """Map continuous indicator values to zero-at-threshold severity margins."""

    return (
        (-0.01 - session_loss) / 0.01,
        (-0.35 - vwap_gap_atr) / 0.35,
        (0.25 - close_location) / 0.25,
        (downside_tail_count - 2) / 2,
    )


def build_fragility_v2_evaluation(
    rows: list[FragilityV2Row],
    settings: FragilityV2Settings | None = None,
) -> dict[str, object]:
    """Run rolling-origin model, phase, state, and promotion evaluation."""

    active_settings = settings or FragilityV2Settings()
    active_settings.validate()
    if not rows:
        raise ValueError("fragility-v2 evaluation requires observations")
    ordered_rows = sorted(rows, key=lambda item: item.timestamp)
    folds = _rolling_folds(ordered_rows, active_settings)
    predictions: list[OutOfSamplePrediction] = []
    fold_payloads: list[dict[str, object]] = []
    for fold_index, (context_rows, test_rows, dates) in enumerate(folds):
        horizon_payload: dict[str, object] = {}
        for horizon in OUTCOME_HORIZONS:
            evaluation = _evaluate_fold_horizon(
                context_rows,
                test_rows,
                horizon,
                fold_index,
            )
            if evaluation is None:
                continue
            fold_predictions, model_payload = evaluation
            predictions.extend(fold_predictions)
            horizon_payload[horizon] = model_payload
        if horizon_payload:
            fold_payloads.append({**dates, "horizons": horizon_payload})
    if not predictions:
        raise ValueError("rolling evaluation produced no valid test predictions")
    combined = {
        horizon: _combined_horizon_summary(
            predictions,
            horizon,
            active_settings,
        )
        for horizon in OUTCOME_HORIZONS
    }
    state_evaluation = _candidate_state_evaluation(predictions, active_settings)
    promotion_gate = _promotion_gate(combined, state_evaluation)
    return {
        "researchVersion": "fragility-v2-shadow-2",
        "settings": {
            "contextMonths": active_settings.context_months,
            "testMonths": active_settings.test_months,
            "innerSplit": {
                "fitShare": 0.6,
                "tuningShare": 0.2,
                "calibrationShare": 0.2,
            },
            "regularizationGrid": list(MODEL_REGULARIZATION_GRID),
            "sessionEqualWeights": True,
            "bootstrapRuns": active_settings.bootstrap_runs,
            "bootstrapSeed": active_settings.bootstrap_seed,
            "bootstrapBlockSessions": active_settings.bootstrap_block_sessions,
        },
        "featureContracts": {
            spec.name: list(spec.feature_names) for spec in MODEL_SPECS
        },
        "outcomeContracts": {
            "120m": "minimum forward return <= -1.0%",
            "5sessions": "minimum forward return <= -2.0%",
        },
        "stateContract": {
            "cutpoints": "train-only frozen-v1 prevalence",
            "phase": "train-only risk CUSUM plus two-brief failure streak",
            "breaking": "risk above cutpoint and WORSENING phase",
            "panic": (
                "risk above cutpoint and either WORSENING phase or four "
                "stressed mechanisms"
            ),
            "confirmation": (
                "first v1 BREAKING or PANIC brief is PENDING; the next due "
                "brief must remain v1 BREAKING or PANIC to become CONFIRMED"
            ),
        },
        "foldCount": len(fold_payloads),
        "folds": fold_payloads,
        "combinedOutOfSample": combined,
        "candidateStateEvaluation": state_evaluation,
        "promotionGate": promotion_gate,
        "limitations": [
            "breadth and cross-index inputs are unavailable in the historical sample",
            "VWAP validity inherits the source artifact's volume contract",
            (
                "all historical periods have already been inspected; "
                "promotion requires prospective shadow data"
            ),
            (
                "state cutpoints match train-only v1 alert budgets and are "
                "not optimized on test outcomes"
            ),
        ],
    }

def predictions_to_rows(
    evaluation_predictions: list[OutOfSamplePrediction],
) -> list[dict[str, object]]:
    """Flatten prediction objects for stable CSV output."""

    return [
        {
            "row_id": item.row.row_id,
            "timestamp": item.row.timestamp,
            "session_date": item.row.session_date,
            "session_time": item.row.session_time,
            "horizon": item.horizon,
            "model": item.model_name,
            "fold_index": item.fold_index,
            "raw_probability": item.raw_probability,
            "calibrated_probability": item.calibrated_probability,
            "training_base_rate": item.training_base_rate,
            "outcome": item.row.outcomes[item.horizon],
        }
        for item in evaluation_predictions
    ]


def _rolling_folds(
    rows: list[FragilityV2Row],
    settings: FragilityV2Settings,
) -> list[tuple[list[FragilityV2Row], list[FragilityV2Row], dict[str, str]]]:
    first_date = date.fromisoformat(rows[0].session_date)
    last_date = date.fromisoformat(rows[-1].session_date)
    context_start = date(first_date.year, first_date.month, 1)
    folds: list[
        tuple[list[FragilityV2Row], list[FragilityV2Row], dict[str, str]]
    ] = []
    while True:
        context_end = add_months(context_start, settings.context_months)
        test_end = add_months(context_end, settings.test_months)
        if test_end > first_day_of_next_month(last_date):
            break
        context_rows = _rows_between(rows, context_start, context_end)
        test_rows = _rows_between(rows, context_end, test_end)
        if context_rows and test_rows:
            folds.append(
                (
                    context_rows,
                    test_rows,
                    {
                        "contextStart": context_start.isoformat(),
                        "contextEndExclusive": context_end.isoformat(),
                        "testStart": context_end.isoformat(),
                        "testEndExclusive": test_end.isoformat(),
                    },
                )
            )
        context_start = add_months(context_start, settings.test_months)
    return folds


def _evaluate_fold_horizon(
    context_rows: list[FragilityV2Row],
    test_rows: list[FragilityV2Row],
    horizon: OutcomeHorizon,
    fold_index: int,
) -> tuple[list[OutOfSamplePrediction], dict[str, object]] | None:
    usable_context = [item for item in context_rows if item.outcomes[horizon] is not None]
    usable_test = [item for item in test_rows if item.outcomes[horizon] is not None]
    session_dates = sorted({item.session_date for item in usable_context})
    if len(session_dates) < 30 or not usable_test:
        return None
    fit_end = max(1, math.floor(len(session_dates) * 0.6))
    tune_end = max(fit_end + 1, math.floor(len(session_dates) * 0.8))
    fit_dates = set(session_dates[:fit_end])
    tune_dates = set(session_dates[fit_end:tune_end])
    calibration_dates = set(session_dates[tune_end:])
    fit_rows = [item for item in usable_context if item.session_date in fit_dates]
    tune_rows = [item for item in usable_context if item.session_date in tune_dates]
    calibration_rows = [
        item for item in usable_context if item.session_date in calibration_dates
    ]
    if not tune_rows or not calibration_rows or not _has_both_classes(fit_rows, horizon):
        return None
    fold_predictions: list[OutOfSamplePrediction] = []
    model_payload: dict[str, object] = {}
    for spec in MODEL_SPECS:
        fitted = _fit_fold_model(
            spec,
            fit_rows,
            tune_rows,
            calibration_rows,
            horizon,
        )
        if fitted is None:
            continue
        test_matrix = _feature_matrix(usable_test, spec)
        raw_probabilities = fitted.model.predict(test_matrix)
        calibrated_probabilities = fitted.calibrator.predict(raw_probabilities)
        state_cutpoints: tuple[float, float, float] | None = None
        phase_parameters: tuple[float, float] | None = None
        if spec.name == "continuous_dynamic" and horizon == "120m":
            calibration_raw = fitted.model.predict(
                _feature_matrix(calibration_rows, spec)
            )
            calibration_probabilities = fitted.calibrator.predict(calibration_raw)
            state_cutpoints = _risk_cutpoints_from_training(
                calibration_rows,
                calibration_probabilities,
            )
            phase_parameters = _phase_parameters_from_training(
                calibration_rows,
                calibration_probabilities,
            )
        labels = _labels(usable_test, horizon)
        weights = session_equal_weights([item.session_date for item in usable_test])
        model_payload[spec.name] = {
            "regularization": fitted.regularization,
            "trainingBaseRate": fitted.training_base_rate,
            "calibrator": fitted.calibrator.to_dict(),
            "rawMetrics": probability_metrics(labels, raw_probabilities, weights),
            "calibratedMetrics": probability_metrics(
                labels,
                calibrated_probabilities,
                weights,
            ),
        }
        fold_predictions.extend(
            OutOfSamplePrediction(
                row=row,
                horizon=horizon,
                model_name=spec.name,
                fold_index=fold_index,
                raw_probability=float(raw_probability),
                calibrated_probability=float(calibrated_probability),
                training_base_rate=fitted.training_base_rate,
                state_cutpoints=state_cutpoints,
                phase_parameters=phase_parameters,
            )
            for row, raw_probability, calibrated_probability in zip(
                usable_test,
                raw_probabilities,
                calibrated_probabilities,
                strict=True,
            )
        )
    return (fold_predictions, model_payload) if model_payload else None


def _fit_fold_model(
    spec: FragilityModelSpec,
    fit_rows: list[FragilityV2Row],
    tune_rows: list[FragilityV2Row],
    calibration_rows: list[FragilityV2Row],
    horizon: OutcomeHorizon,
) -> _FittedFoldModel | None:
    if not _has_both_classes([*fit_rows, *tune_rows], horizon):
        return None
    fit_matrix = _feature_matrix(fit_rows, spec)
    fit_labels = _labels(fit_rows, horizon)
    fit_weights = session_equal_weights([item.session_date for item in fit_rows])
    tune_matrix = _feature_matrix(tune_rows, spec)
    tune_labels = _labels(tune_rows, horizon)
    tune_weights = session_equal_weights([item.session_date for item in tune_rows])
    candidates: list[tuple[float, float]] = []
    for regularization in MODEL_REGULARIZATION_GRID:
        model = fit_logistic_probability_model(
            spec.feature_names,
            fit_matrix,
            fit_labels,
            fit_weights,
            regularization,
        )
        probabilities = model.predict(tune_matrix)
        metrics = probability_metrics(tune_labels, probabilities, tune_weights)
        brier = metrics["brier"]
        if isinstance(brier, float):
            candidates.append((brier, regularization))
    if not candidates:
        return None
    regularization = min(candidates)[1]
    training_rows = [*fit_rows, *tune_rows]
    model = fit_logistic_probability_model(
        spec.feature_names,
        _feature_matrix(training_rows, spec),
        _labels(training_rows, horizon),
        session_equal_weights([item.session_date for item in training_rows]),
        regularization,
    )
    calibration_probabilities = model.predict(_feature_matrix(calibration_rows, spec))
    calibration_weights = session_equal_weights(
        [item.session_date for item in calibration_rows]
    )
    calibrator = fit_probability_calibrator(
        calibration_probabilities,
        _labels(calibration_rows, horizon),
        calibration_weights,
    )
    context_rows = [*training_rows, *calibration_rows]
    context_labels = _labels(context_rows, horizon)
    context_weights = session_equal_weights(
        [item.session_date for item in context_rows]
    )
    training_base_rate = float(
        np.sum(context_labels * context_weights) / np.sum(context_weights)
    )
    return _FittedFoldModel(
        spec=spec,
        model=model,
        calibrator=calibrator,
        regularization=regularization,
        training_base_rate=training_base_rate,
    )


def _combined_horizon_summary(
    predictions: list[OutOfSamplePrediction],
    horizon: OutcomeHorizon,
    settings: FragilityV2Settings,
) -> dict[str, object]:
    selected = [item for item in predictions if item.horizon == horizon]
    by_model: dict[str, list[OutOfSamplePrediction]] = defaultdict(list)
    for item in selected:
        by_model[item.model_name].append(item)
    model_summaries: dict[str, object] = {}
    for model_name, items in by_model.items():
        labels = np.asarray(
            [bool(item.row.outcomes[horizon]) for item in items],
            dtype=np.float64,
        )
        weights = session_equal_weights([item.row.session_date for item in items])
        raw = np.asarray([item.raw_probability for item in items], dtype=np.float64)
        calibrated = np.asarray(
            [item.calibrated_probability for item in items],
            dtype=np.float64,
        )
        base = np.asarray([item.training_base_rate for item in items], dtype=np.float64)
        calibrated_metrics = probability_metrics(labels, calibrated, weights)
        baseline_metrics = probability_metrics(labels, base, weights)
        model_summaries[model_name] = {
            "rawMetrics": probability_metrics(labels, raw, weights),
            "calibratedMetrics": calibrated_metrics,
            "trainingBaseRateMetrics": baseline_metrics,
            "brierSkillVsTrainingBaseRate": _skill_score(
                calibrated_metrics.get("brier"),
                baseline_metrics.get("brier"),
            ),
        }
    comparisons: dict[str, object] = {}
    baseline_items = by_model.get("count_only", [])
    for candidate_name in ("weighted_flags", "continuous_dynamic"):
        candidate_items = by_model.get(candidate_name, [])
        comparisons[candidate_name] = _block_metric_difference(
            baseline_items,
            candidate_items,
            horizon,
            settings,
        )
    return {"models": model_summaries, "comparisonsVsCountOnly": comparisons}


def _candidate_state_evaluation(
    predictions: list[OutOfSamplePrediction],
    settings: FragilityV2Settings,
) -> dict[str, object]:
    candidate = [
        item
        for item in predictions
        if item.horizon == "120m" and item.model_name == "continuous_dynamic"
    ]
    if not candidate:
        return {"observations": 0, "byLevel": {}, "byPhase": {}}
    ordered = sorted(candidate, key=lambda item: item.row.timestamp)
    fold_groups: dict[int, list[OutOfSamplePrediction]] = defaultdict(list)
    for item in ordered:
        fold_groups[item.fold_index].append(item)
    classified: list[
        tuple[OutOfSamplePrediction, FragilityPhase, CandidateLevel]
    ] = []
    for items in fold_groups.values():
        thresholds = items[0].state_cutpoints
        phase_parameters = items[0].phase_parameters
        if thresholds is None or phase_parameters is None:
            continue
        classified.extend(
            _classify_fold_states(items, thresholds, phase_parameters)
        )
    by_level = {
        level: _classified_group_summary(
            [item for item in classified if item[2] == level]
        )
        for level in ("resilient", "fragile", "breaking", "panic")
    }
    by_phase = {
        phase: _classified_group_summary(
            [item for item in classified if item[1] == phase]
        )
        for phase in ("IMPROVING", "STABLE", "WORSENING")
    }
    return {
        "observations": len(classified),
        "sessions": len({item[0].row.session_date for item in classified}),
        "stateRule": (
            "train-only v1 prevalence cutpoints; BREAKING also requires "
            "causal WORSENING phase"
        ),
        "phaseRule": (
            "one-sided risk CUSUM calibrated from the preceding fold plus "
            "a two-brief repair-failure streak"
        ),
        "byLevel": by_level,
        "byPhase": by_phase,
        "breakingVsFragile120m": _classified_rate_difference_bootstrap(
            classified,
            group_index=2,
            left_value="breaking",
            right_value="fragile",
            settings=settings,
        ),
        "highRiskWorseningVsNonWorsening120m": (
            _high_risk_phase_difference_bootstrap(
                classified,
                settings,
            )
        ),
        "unconditionalWorseningVsStable120m": _classified_rate_difference_bootstrap(
            classified,
            group_index=1,
            left_value="WORSENING",
            right_value="STABLE",
            settings=settings,
        ),
        "movingBlockPersistence": _persistence_bootstrap(classified, settings),
        "breakingConfirmation": _breaking_confirmation_bootstrap(
            [item.row for item in ordered],
            settings,
        ),
    }


def _risk_cutpoints_from_training(
    rows: list[FragilityV2Row],
    probabilities: FloatArray,
) -> tuple[float, float, float]:
    levels = [item.level for item in rows]
    fragile_share = sum(level != "resilient" for level in levels) / len(levels)
    breaking_share = sum(level in {"breaking", "panic"} for level in levels) / len(levels)
    panic_share = sum(level == "panic" for level in levels) / len(levels)
    return (
        float(np.quantile(probabilities, max(0.0, 1 - fragile_share))),
        float(np.quantile(probabilities, max(0.0, 1 - breaking_share))),
        float(np.quantile(probabilities, max(0.0, 1 - panic_share))),
    )


def _phase_parameters_from_training(
    rows: list[FragilityV2Row],
    probabilities: FloatArray,
) -> tuple[float, float]:
    paired = list(zip(rows, probabilities, strict=True))
    grouped: dict[str, list[tuple[FragilityV2Row, float]]] = defaultdict(list)
    for row, probability in sorted(paired, key=lambda item: item[0].timestamp):
        grouped[row.session_date].append((row, float(probability)))
    positive_changes: list[float] = []
    for session_items in grouped.values():
        for previous, current in zip(session_items, session_items[1:]):
            positive_changes.append(
                max(0.0, current[1] - previous[1])
            )
    if not positive_changes:
        return 0.0, 0.0
    drift = float(np.quantile(positive_changes, 0.5))
    threshold = max(1e-6, float(np.quantile(positive_changes, 0.9)))
    return drift, threshold


def _classify_fold_states(
    items: list[OutOfSamplePrediction],
    thresholds: tuple[float, float, float],
    phase_parameters: tuple[float, float],
) -> list[tuple[OutOfSamplePrediction, FragilityPhase, CandidateLevel]]:
    fragile_threshold, breaking_threshold, panic_threshold = thresholds
    drift, change_threshold = phase_parameters
    grouped: dict[str, list[OutOfSamplePrediction]] = defaultdict(list)
    for item in sorted(items, key=lambda candidate: candidate.row.timestamp):
        grouped[item.row.session_date].append(item)
    classified: list[
        tuple[OutOfSamplePrediction, FragilityPhase, CandidateLevel]
    ] = []
    for session_items in grouped.values():
        previous_probability: float | None = None
        upward_cusum = 0.0
        downward_cusum = 0.0
        for item in session_items:
            probability = item.calibrated_probability
            change = (
                0.0
                if previous_probability is None
                else probability - previous_probability
            )
            upward_cusum = max(0.0, upward_cusum + change - drift)
            downward_cusum = max(0.0, downward_cusum - change - drift)
            if item.row.failure_streak >= 2 or upward_cusum >= change_threshold:
                phase: FragilityPhase = "WORSENING"
            elif downward_cusum >= change_threshold:
                phase = "IMPROVING"
            else:
                phase = "STABLE"
            if probability >= panic_threshold and (
                phase == "WORSENING" or item.row.stressed_indicator_count >= 4
            ):
                level: CandidateLevel = "panic"
            elif probability >= breaking_threshold and phase == "WORSENING":
                level = "breaking"
            elif probability >= fragile_threshold:
                level = "fragile"
            else:
                level = "resilient"
            classified.append((item, phase, level))
            previous_probability = probability
    return classified


def _classified_group_summary(
    items: list[tuple[OutOfSamplePrediction, FragilityPhase, CandidateLevel]],
) -> dict[str, float | int | None]:
    return {
        "observations": len(items),
        "sessions": len({item[0].row.session_date for item in items}),
        "120mDrawdownRate": _session_equal_state_rate(items, "120m"),
        "5sessionDrawdownRate": _session_equal_state_rate(
            items,
            "5sessions",
        ),
    }


def _session_equal_state_rate(
    items: list[tuple[OutOfSamplePrediction, FragilityPhase, CandidateLevel]],
    horizon: OutcomeHorizon,
) -> float | None:
    by_session: dict[str, list[bool]] = defaultdict(list)
    for prediction, _phase, _level in items:
        outcome = prediction.row.outcomes[horizon]
        if outcome is not None:
            by_session[prediction.row.session_date].append(outcome)
    if not by_session:
        return None
    session_rates = [
        sum(session_outcomes) / len(session_outcomes)
        for session_outcomes in by_session.values()
    ]
    return sum(session_rates) / len(session_rates)


def _classified_rate_difference_bootstrap(
    items: list[tuple[OutOfSamplePrediction, FragilityPhase, CandidateLevel]],
    group_index: int,
    left_value: str,
    right_value: str,
    settings: FragilityV2Settings,
) -> dict[str, float | int | None]:
    session_groups: dict[str, dict[str, list[bool]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for item in items:
        outcome = item[0].row.outcomes["120m"]
        if outcome is not None:
            group_value = str(item[group_index])
            session_groups[item[0].row.session_date][group_value].append(
                outcome
            )
    return _session_group_rate_difference_bootstrap(
        session_groups,
        left_value,
        right_value,
        settings,
    )


def _high_risk_phase_difference_bootstrap(
    items: list[tuple[OutOfSamplePrediction, FragilityPhase, CandidateLevel]],
    settings: FragilityV2Settings,
) -> dict[str, float | int | None]:
    session_groups: dict[str, dict[str, list[bool]]] = defaultdict(
        lambda: defaultdict(list)
    )
    for prediction, phase, _level in items:
        outcome = prediction.row.outcomes["120m"]
        cutpoints = prediction.state_cutpoints
        if (
            outcome is None
            or cutpoints is None
            or prediction.calibrated_probability < cutpoints[1]
        ):
            continue
        group_value = (
            "WORSENING" if phase == "WORSENING" else "NON_WORSENING"
        )
        session_groups[prediction.row.session_date][group_value].append(
            outcome
        )
    return _session_group_rate_difference_bootstrap(
        session_groups,
        "WORSENING",
        "NON_WORSENING",
        settings,
    )


def _session_group_rate_difference_bootstrap(
    session_groups: dict[str, dict[str, list[bool]]],
    left_value: str,
    right_value: str,
    settings: FragilityV2Settings,
) -> dict[str, float | int | None]:
    dates = sorted(session_groups)
    estimate = _classified_rate_difference(
        session_groups,
        dates,
        left_value,
        right_value,
    )
    left_sessions = sum(
        left_value in session_values
        for session_values in session_groups.values()
    )
    right_sessions = sum(
        right_value in session_values
        for session_values in session_groups.values()
    )
    if estimate is None or settings.bootstrap_runs == 0 or not dates:
        return {
            "estimate": estimate,
            "lower95": None,
            "upper95": None,
            "leftSessions": left_sessions,
            "rightSessions": right_sessions,
        }
    rng = random.Random(settings.bootstrap_seed)
    block_count = math.ceil(len(dates) / settings.bootstrap_block_sessions)
    samples: list[float] = []
    for _run in range(settings.bootstrap_runs):
        starts = [rng.randrange(len(dates)) for _ in range(block_count)]
        sampled_dates = [
            dates[(start + offset) % len(dates)]
            for start in starts
            for offset in range(settings.bootstrap_block_sessions)
        ][: len(dates)]
        difference = _classified_rate_difference(
            session_groups,
            sampled_dates,
            left_value,
            right_value,
        )
        if difference is not None:
            samples.append(difference)
    return {
        "estimate": estimate,
        "lower95": None if not samples else float(np.percentile(samples, 2.5)),
        "upper95": None if not samples else float(np.percentile(samples, 97.5)),
        "leftSessions": left_sessions,
        "rightSessions": right_sessions,
    }


def _classified_rate_difference(
    session_groups: dict[str, dict[str, list[bool]]],
    dates: list[str],
    left_value: str,
    right_value: str,
) -> float | None:
    left_rates: list[float] = []
    right_rates: list[float] = []
    for session_date in dates:
        groups = session_groups[session_date]
        if left_value in groups:
            left_rates.append(sum(groups[left_value]) / len(groups[left_value]))
        if right_value in groups:
            right_rates.append(sum(groups[right_value]) / len(groups[right_value]))
    if not left_rates or not right_rates:
        return None
    return _mean(left_rates) - _mean(right_rates)


def _persistence_bootstrap(
    classified: list[tuple[OutOfSamplePrediction, FragilityPhase, CandidateLevel]],
    settings: FragilityV2Settings,
) -> dict[str, object]:
    first_breaking: dict[str, tuple[bool, bool]] = {}
    grouped: dict[
        str,
        list[tuple[OutOfSamplePrediction, FragilityPhase, CandidateLevel]],
    ] = defaultdict(list)
    for item in classified:
        grouped[item[0].row.session_date].append(item)
    for session_date, items in grouped.items():
        ordered = sorted(items, key=lambda item: item[0].row.timestamp)
        for index, item in enumerate(ordered):
            if item[2] != "breaking":
                continue
            next_item = ordered[index + 1] if index + 1 < len(ordered) else None
            outcome = item[0].row.outcomes["120m"]
            if outcome is not None and next_item is not None:
                cutpoints = next_item[0].state_cutpoints
                sustained = (
                    cutpoints is not None
                    and next_item[0].calibrated_probability >= cutpoints[1]
                )
                first_breaking[session_date] = (
                    sustained,
                    outcome,
                )
            break
    dates = sorted(grouped)
    estimate = _persistence_difference(first_breaking.values())
    sustained_sessions = sum(value[0] for value in first_breaking.values())
    transient_sessions = len(first_breaking) - sustained_sessions
    if estimate is None or settings.bootstrap_runs == 0 or not dates:
        return {
            "estimate": estimate,
            "lower95": None,
            "upper95": None,
            "sustainedSessions": sustained_sessions,
            "transientSessions": transient_sessions,
        }
    rng = random.Random(settings.bootstrap_seed)
    block_count = math.ceil(len(dates) / settings.bootstrap_block_sessions)
    samples: list[float] = []
    for _run in range(settings.bootstrap_runs):
        starts = [rng.randrange(len(dates)) for _ in range(block_count)]
        sampled_dates = [
            dates[(start + offset) % len(dates)]
            for start in starts
            for offset in range(settings.bootstrap_block_sessions)
        ][: len(dates)]
        difference = _persistence_difference(
            first_breaking[session_date]
            for session_date in sampled_dates
            if session_date in first_breaking
        )
        if difference is not None:
            samples.append(difference)
    return {
        "estimate": estimate,
        "lower95": None if not samples else float(np.percentile(samples, 2.5)),
        "upper95": None if not samples else float(np.percentile(samples, 97.5)),
        "sustainedSessions": sustained_sessions,
        "transientSessions": transient_sessions,
    }


def _persistence_difference(
    values: Iterable[tuple[bool, bool]],
) -> float | None:
    sustained: list[bool] = []
    transient: list[bool] = []
    for is_sustained, outcome in values:
        (sustained if is_sustained else transient).append(outcome)
    if not sustained or not transient:
        return None
    return sum(sustained) / len(sustained) - sum(transient) / len(transient)


def _breaking_confirmation_bootstrap(
    rows: list[FragilityV2Row],
    settings: FragilityV2Settings,
) -> dict[str, float | int | None]:
    """Evaluate two consecutive existing v1 BREAKING/PANIC briefs."""

    grouped: dict[str, list[FragilityV2Row]] = defaultdict(list)
    for row in rows:
        grouped[row.session_date].append(row)
    first_crossings: dict[str, tuple[bool, bool, float]] = {}
    pending_sessions = 0
    for session_date, session_items in grouped.items():
        ordered = sorted(
            session_items,
            key=lambda item: item.timestamp,
        )
        for index, item in enumerate(ordered):
            if item.level not in {"breaking", "panic"}:
                continue
            pending_sessions += 1
            next_item = ordered[index + 1] if index + 1 < len(ordered) else None
            next_outcome = (
                None
                if next_item is None
                else next_item.outcomes["120m"]
            )
            if next_item is not None and next_outcome is not None:
                confirmed = next_item.level in {"breaking", "panic"}
                delay_minutes = (
                    next_item.timestamp - item.timestamp
                ) / 60_000
                first_crossings[session_date] = (
                    confirmed,
                    next_outcome,
                    delay_minutes,
                )
            break
    dates = sorted(grouped)
    estimate = _confirmation_rate_difference(first_crossings.values())
    confirmed_values = [
        outcome
        for confirmed, outcome, _delay in first_crossings.values()
        if confirmed
    ]
    transient_values = [
        outcome
        for confirmed, outcome, _delay in first_crossings.values()
        if not confirmed
    ]
    confirmed_sessions = len(confirmed_values)
    transient_sessions = len(transient_values)
    evaluable_sessions = confirmed_sessions + transient_sessions
    delays = [value[2] for value in first_crossings.values()]
    result: dict[str, float | int | None] = {
        "pendingSessions": pending_sessions,
        "evaluablePendingSessions": evaluable_sessions,
        "confirmedSessions": confirmed_sessions,
        "transientSessions": transient_sessions,
        "confirmationRate": (
            None
            if evaluable_sessions == 0
            else confirmed_sessions / evaluable_sessions
        ),
        "confirmed120mEventRate": _bool_rate(confirmed_values),
        "transient120mEventRate": _bool_rate(transient_values),
        "eventRateDifference": estimate,
        "lower95": None,
        "upper95": None,
        "medianConfirmationDelayMinutes": (
            None if not delays else float(np.median(delays))
        ),
        "outcomeAnchor": "next_due_brief",
    }
    if estimate is None or settings.bootstrap_runs == 0 or not dates:
        return result
    rng = random.Random(settings.bootstrap_seed)
    block_count = math.ceil(len(dates) / settings.bootstrap_block_sessions)
    samples: list[float] = []
    for _run in range(settings.bootstrap_runs):
        starts = [rng.randrange(len(dates)) for _ in range(block_count)]
        sampled_dates = [
            dates[(start + offset) % len(dates)]
            for start in starts
            for offset in range(settings.bootstrap_block_sessions)
        ][: len(dates)]
        difference = _confirmation_rate_difference(
            first_crossings[session_date]
            for session_date in sampled_dates
            if session_date in first_crossings
        )
        if difference is not None:
            samples.append(difference)
    return {
        **result,
        "lower95": None if not samples else float(np.percentile(samples, 2.5)),
        "upper95": None if not samples else float(np.percentile(samples, 97.5)),
    }


def _confirmation_rate_difference(
    values: Iterable[tuple[bool, bool, float]],
) -> float | None:
    confirmed: list[bool] = []
    transient: list[bool] = []
    for is_confirmed, outcome, _delay in values:
        (confirmed if is_confirmed else transient).append(outcome)
    if not confirmed or not transient:
        return None
    return sum(confirmed) / len(confirmed) - sum(transient) / len(transient)


def _bool_rate(values: list[bool]) -> float | None:
    return None if not values else sum(values) / len(values)


def _promotion_gate(
    combined: dict[OutcomeHorizon, dict[str, object]],
    state_evaluation: dict[str, object],
) -> dict[str, object]:
    checks: list[dict[str, object]] = []
    for horizon in OUTCOME_HORIZONS:
        models = combined[horizon]["models"]
        assert isinstance(models, dict)
        candidate_model = models.get("continuous_dynamic")
        assert isinstance(candidate_model, dict)
        brier_skill = candidate_model.get("brierSkillVsTrainingBaseRate")
        checks.append(
            {
                "name": f"{horizon}_positive_brier_skill_vs_train_base_rate",
                "passed": isinstance(brier_skill, float) and brier_skill > 0,
                "evidence": {"brierSkill": brier_skill},
            }
        )
        comparisons = combined[horizon]["comparisonsVsCountOnly"]
        assert isinstance(comparisons, dict)
        candidate = comparisons.get("continuous_dynamic")
        assert isinstance(candidate, dict)
        for metric_name in ("brierDifference", "logLossDifference"):
            interval = candidate.get(metric_name)
            assert isinstance(interval, dict)
            passed = (
                isinstance(interval.get("upper95"), float)
                and float(interval["upper95"]) < 0
            )
            checks.append(
                {
                    "name": f"{horizon}_{metric_name}_beats_count_only",
                    "passed": passed,
                    "evidence": interval,
                }
            )
    by_level = state_evaluation.get("byLevel")
    assert isinstance(by_level, dict)
    ordered_rates: list[float] = []
    for level in ("breaking", "panic"):
        summary = by_level.get(level)
        sessions = 0 if not isinstance(summary, dict) else int(summary["sessions"])
        checks.append(
            {
                "name": f"{level}_has_30_independent_sessions",
                "passed": sessions >= 30,
                "evidence": {"sessions": sessions},
            }
        )
    for level in ("resilient", "fragile", "breaking", "panic"):
        summary = by_level.get(level)
        rate = None if not isinstance(summary, dict) else summary.get("120mDrawdownRate")
        if isinstance(rate, float):
            ordered_rates.append(rate)
    checks.append(
        {
            "name": "state_120m_risk_is_monotonic",
            "passed": (
                len(ordered_rates) == 4
                and all(
                    left <= right
                    for left, right in zip(ordered_rates, ordered_rates[1:])
                )
            ),
            "evidence": {"orderedRates": ordered_rates},
        }
    )
    for name, result_key in (
        ("breaking_has_higher_120m_risk_than_fragile", "breakingVsFragile120m"),
        (
            "high_risk_worsening_has_higher_120m_risk",
            "highRiskWorseningVsNonWorsening120m",
        ),
    ):
        difference = state_evaluation.get(result_key)
        assert isinstance(difference, dict)
        lower = difference.get("lower95")
        checks.append(
            {
                "name": name,
                "passed": isinstance(lower, float) and lower > 0,
                "evidence": difference,
            }
        )
    confirmation = state_evaluation.get("breakingConfirmation")
    assert isinstance(confirmation, dict)
    confirmation_lower = confirmation.get("lower95")
    confirmed_sessions = int(confirmation.get("confirmedSessions", 0))
    transient_sessions = int(confirmation.get("transientSessions", 0))
    checks.append(
        {
            "name": "breaking_confirmation_cohorts_have_30_sessions",
            "passed": confirmed_sessions >= 30 and transient_sessions >= 30,
            "evidence": {
                "confirmedSessions": confirmed_sessions,
                "transientSessions": transient_sessions,
            },
        }
    )
    checks.append(
        {
            "name": "confirmed_breaking_has_higher_120m_risk",
            "passed": (
                isinstance(confirmation_lower, float)
                and confirmation_lower > 0
            ),
            "evidence": confirmation,
        }
    )
    checks.append(
        {
            "name": "prospective_shadow_holdout_available",
            "passed": False,
            "evidence": "historical sample has already been inspected",
        }
    )
    return {
        "decision": (
            "PROMOTE" if all(bool(item["passed"]) for item in checks) else "SHADOW_ONLY"
        ),
        "checks": checks,
    }


def _block_metric_difference(
    baseline_items: list[OutOfSamplePrediction],
    candidate_items: list[OutOfSamplePrediction],
    horizon: OutcomeHorizon,
    settings: FragilityV2Settings,
) -> dict[str, object]:
    baseline_by_row = {item.row.row_id: item for item in baseline_items}
    candidate_by_row = {item.row.row_id: item for item in candidate_items}
    common_ids = sorted(set(baseline_by_row) & set(candidate_by_row))
    session_losses: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for row_id in common_ids:
        baseline = baseline_by_row[row_id]
        candidate = candidate_by_row[row_id]
        outcome = baseline.row.outcomes[horizon]
        if outcome is None:
            continue
        label = float(outcome)
        base_probability = baseline.calibrated_probability
        candidate_probability = candidate.calibrated_probability
        brier_difference = (
            (candidate_probability - label) ** 2
            - (base_probability - label) ** 2
        )
        log_difference = (
            _row_log_loss(label, candidate_probability)
            - _row_log_loss(label, base_probability)
        )
        session_losses[baseline.row.session_date].append(
            (brier_difference, log_difference)
        )
    session_dates = sorted(session_losses)
    session_means = {
        session_date: (
            sum(item[0] for item in values) / len(values),
            sum(item[1] for item in values) / len(values),
        )
        for session_date, values in session_losses.items()
    }
    brier_estimate = _mean([session_means[item][0] for item in session_dates])
    log_estimate = _mean([session_means[item][1] for item in session_dates])
    if settings.bootstrap_runs == 0 or not session_dates:
        return {
            "brierDifference": _interval(brier_estimate, []),
            "logLossDifference": _interval(log_estimate, []),
        }
    rng = random.Random(settings.bootstrap_seed)
    block_count = math.ceil(
        len(session_dates) / settings.bootstrap_block_sessions
    )
    brier_samples: list[float] = []
    log_samples: list[float] = []
    for _run in range(settings.bootstrap_runs):
        starts = [rng.randrange(len(session_dates)) for _ in range(block_count)]
        sampled_dates = [
            session_dates[(start + offset) % len(session_dates)]
            for start in starts
            for offset in range(settings.bootstrap_block_sessions)
        ][: len(session_dates)]
        brier_samples.append(
            _mean([session_means[item][0] for item in sampled_dates])
        )
        log_samples.append(
            _mean([session_means[item][1] for item in sampled_dates])
        )
    return {
        "brierDifference": _interval(brier_estimate, brier_samples),
        "logLossDifference": _interval(log_estimate, log_samples),
    }


def _feature_matrix(
    rows: list[FragilityV2Row],
    spec: FragilityModelSpec,
) -> FloatArray:
    return np.asarray(
        [
            [_feature_value(item, feature_name) for feature_name in spec.feature_names]
            for item in rows
        ],
        dtype=np.float64,
    )


def _feature_value(row: FragilityV2Row, feature_name: str) -> float:
    if feature_name == "stressed_indicator_count":
        return float(row.stressed_indicator_count)
    if feature_name == "time_fraction":
        return row.time_fraction
    if feature_name == "prior_stressed_indicator_count":
        return float(row.prior_stressed_indicator_count)
    if feature_name == "failure_streak":
        return float(row.failure_streak)
    for index, indicator_id in enumerate(PRICE_INDICATORS):
        if feature_name == f"{indicator_id}_flag":
            return row.indicator_flags[index]
        if feature_name == f"{indicator_id}_severity":
            return row.severity_margins[index]
    raise ValueError(f"unknown feature: {feature_name}")


def _labels(
    rows: list[FragilityV2Row],
    horizon: OutcomeHorizon,
) -> FloatArray:
    return np.asarray(
        [float(bool(item.outcomes[horizon])) for item in rows],
        dtype=np.float64,
    )


def _has_both_classes(
    rows: list[FragilityV2Row],
    horizon: OutcomeHorizon,
) -> bool:
    values = {
        item.outcomes[horizon]
        for item in rows
        if item.outcomes[horizon] is not None
    }
    return values == {False, True}


def _rows_between(
    rows: list[FragilityV2Row],
    start: date,
    end: date,
) -> list[FragilityV2Row]:
    return [
        item
        for item in rows
        if start <= date.fromisoformat(item.session_date) < end
    ]


def _skill_score(value: object, baseline: object) -> float | None:
    if not isinstance(value, float) or not isinstance(baseline, float) or baseline <= 0:
        return None
    return 1 - value / baseline


def _row_log_loss(label: float, probability: float) -> float:
    clipped = min(1 - 1e-9, max(1e-9, probability))
    return -(label * math.log(clipped) + (1 - label) * math.log(1 - clipped))


def _interval(estimate: float, samples: list[float]) -> dict[str, float | None]:
    return {
        "estimate": estimate,
        "lower95": None if not samples else float(np.percentile(samples, 2.5)),
        "upper95": None if not samples else float(np.percentile(samples, 97.5)),
    }


def _mean(values: list[float]) -> float:
    return 0.0 if not values else sum(values) / len(values)
