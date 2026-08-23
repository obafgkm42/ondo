"""Small, deterministic probability-model and evaluation primitives."""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from numpy.typing import NDArray

FloatArray = NDArray[np.float64]


@dataclass(frozen=True)
class LogisticProbabilityModel:
    """Regularized logistic model with train-only feature normalization."""

    feature_names: tuple[str, ...]
    means: FloatArray
    scales: FloatArray
    coefficients: FloatArray
    regularization: float

    def predict(self, feature_matrix: FloatArray) -> FloatArray:
        """Return clipped event probabilities for raw feature rows."""

        normalized = (feature_matrix - self.means) / self.scales
        design = np.column_stack((np.ones(len(normalized)), normalized))
        logits = np.clip(design @ self.coefficients, -35, 35)
        return np.clip(1 / (1 + np.exp(-logits)), 1e-9, 1 - 1e-9)

    def to_dict(self) -> dict[str, object]:
        """Return a stable JSON-compatible model snapshot."""

        return {
            "featureNames": list(self.feature_names),
            "means": self.means.tolist(),
            "scales": self.scales.tolist(),
            "coefficients": self.coefficients.tolist(),
            "regularization": self.regularization,
        }


@dataclass(frozen=True)
class ProbabilityCalibrator:
    """One-dimensional logistic recalibration on raw model logits."""

    intercept: float
    slope: float
    fallback_reason: str | None = None

    def predict(self, probabilities: FloatArray) -> FloatArray:
        """Apply the fitted calibration mapping."""

        logits = probability_logits(probabilities)
        calibrated_logits = np.clip(self.intercept + self.slope * logits, -35, 35)
        return np.clip(
            1 / (1 + np.exp(-calibrated_logits)),
            1e-9,
            1 - 1e-9,
        )

    def to_dict(self) -> dict[str, object]:
        """Return a stable JSON-compatible calibrator snapshot."""

        return {
            "intercept": self.intercept,
            "slope": self.slope,
            "fallbackReason": self.fallback_reason,
        }


def session_equal_weights(session_dates: list[str]) -> FloatArray:
    """Weight every session equally regardless of its observation count."""

    counts: dict[str, int] = {}
    for session_date in session_dates:
        counts[session_date] = counts.get(session_date, 0) + 1
    return np.asarray(
        [1 / counts[session_date] for session_date in session_dates],
        dtype=np.float64,
    )


def fit_logistic_probability_model(
    feature_names: tuple[str, ...],
    feature_matrix: FloatArray,
    labels: FloatArray,
    weights: FloatArray,
    regularization: float,
) -> LogisticProbabilityModel:
    """Fit a deterministic L2-regularized logistic probability model."""

    if feature_matrix.ndim != 2 or feature_matrix.shape[1] != len(feature_names):
        raise ValueError("feature matrix does not match feature names")
    _validate_training_arrays(feature_matrix, labels, weights)
    if regularization < 0:
        raise ValueError("regularization cannot be negative")
    means = feature_matrix.mean(axis=0)
    scales = feature_matrix.std(axis=0)
    scales = np.where(scales <= 1e-12, 1.0, scales)
    normalized = (feature_matrix - means) / scales
    design = np.column_stack((np.ones(len(normalized)), normalized))
    coefficients = _fit_logistic_coefficients(
        design,
        labels,
        weights,
        regularization,
    )
    return LogisticProbabilityModel(
        feature_names=feature_names,
        means=means,
        scales=scales,
        coefficients=coefficients,
        regularization=regularization,
    )


def fit_probability_calibrator(
    probabilities: FloatArray,
    labels: FloatArray,
    weights: FloatArray,
) -> ProbabilityCalibrator:
    """Fit Platt-style calibration, falling back safely for one-class data."""

    if len(probabilities) != len(labels) or len(labels) != len(weights):
        raise ValueError("calibration arrays must have equal lengths")
    if len(labels) == 0:
        raise ValueError("calibration requires observations")
    event_rate = _weighted_mean(labels, weights)
    if event_rate <= 0 or event_rate >= 1:
        clipped_rate = min(1 - 1e-6, max(1e-6, event_rate))
        return ProbabilityCalibrator(
            intercept=float(math.log(clipped_rate / (1 - clipped_rate))),
            slope=0,
            fallback_reason="calibration sample contains one class",
        )
    design = np.column_stack(
        (np.ones(len(probabilities)), probability_logits(probabilities))
    )
    coefficients = _fit_logistic_coefficients(
        design,
        labels,
        weights,
        regularization=1e-6,
        penalize_from_index=1,
    )
    return ProbabilityCalibrator(
        intercept=float(coefficients[0]),
        slope=float(coefficients[1]),
    )


def probability_metrics(
    labels: FloatArray,
    probabilities: FloatArray,
    weights: FloatArray,
) -> dict[str, float | int | None]:
    """Calculate calibration, ranking, and proper-score diagnostics."""

    if len(labels) != len(probabilities) or len(labels) != len(weights):
        raise ValueError("metric arrays must have equal lengths")
    if len(labels) == 0:
        return {
            "observations": 0,
            "eventRate": None,
            "meanProbability": None,
            "brier": None,
            "logLoss": None,
            "rocAuc": None,
            "prAuc": None,
            "expectedCalibrationError": None,
            "calibrationIntercept": None,
            "calibrationSlope": None,
        }
    probabilities = np.clip(probabilities, 1e-9, 1 - 1e-9)
    weight_sum = float(weights.sum())
    if weight_sum <= 0:
        raise ValueError("metric weights must sum to a positive value")
    event_rate = _weighted_mean(labels, weights)
    brier = _weighted_mean((probabilities - labels) ** 2, weights)
    log_loss = _weighted_mean(
        -(labels * np.log(probabilities) + (1 - labels) * np.log(1 - probabilities)),
        weights,
    )
    calibration = _calibration_diagnostic(probabilities, labels, weights)
    return {
        "observations": len(labels),
        "eventRate": event_rate,
        "meanProbability": _weighted_mean(probabilities, weights),
        "brier": brier,
        "logLoss": log_loss,
        "rocAuc": weighted_roc_auc(labels, probabilities, weights),
        "prAuc": weighted_average_precision(labels, probabilities, weights),
        "expectedCalibrationError": expected_calibration_error(
            labels,
            probabilities,
            weights,
        ),
        "calibrationIntercept": calibration[0],
        "calibrationSlope": calibration[1],
    }


def weighted_roc_auc(
    labels: FloatArray,
    probabilities: FloatArray,
    weights: FloatArray,
) -> float | None:
    """Calculate weighted ROC AUC with exact tie handling."""

    positive_weight = float(weights[labels == 1].sum())
    negative_weight = float(weights[labels == 0].sum())
    if positive_weight <= 0 or negative_weight <= 0:
        return None
    order = np.argsort(probabilities, kind="stable")
    sorted_probabilities = probabilities[order]
    sorted_labels = labels[order]
    sorted_weights = weights[order]
    concordant = 0.0
    cumulative_negative = 0.0
    start = 0
    while start < len(order):
        end = start + 1
        while (
            end < len(order)
            and sorted_probabilities[end] == sorted_probabilities[start]
        ):
            end += 1
        group_labels = sorted_labels[start:end]
        group_weights = sorted_weights[start:end]
        group_positive = float(group_weights[group_labels == 1].sum())
        group_negative = float(group_weights[group_labels == 0].sum())
        concordant += group_positive * (
            cumulative_negative + 0.5 * group_negative
        )
        cumulative_negative += group_negative
        start = end
    return concordant / (positive_weight * negative_weight)


def weighted_average_precision(
    labels: FloatArray,
    probabilities: FloatArray,
    weights: FloatArray,
) -> float | None:
    """Calculate weighted average precision over descending score groups."""

    positive_weight = float(weights[labels == 1].sum())
    if positive_weight <= 0:
        return None
    order = np.argsort(-probabilities, kind="stable")
    sorted_probabilities = probabilities[order]
    sorted_labels = labels[order]
    sorted_weights = weights[order]
    true_positive = 0.0
    predicted_positive = 0.0
    average_precision = 0.0
    previous_recall = 0.0
    start = 0
    while start < len(order):
        end = start + 1
        while (
            end < len(order)
            and sorted_probabilities[end] == sorted_probabilities[start]
        ):
            end += 1
        group_labels = sorted_labels[start:end]
        group_weights = sorted_weights[start:end]
        true_positive += float(group_weights[group_labels == 1].sum())
        predicted_positive += float(group_weights.sum())
        recall = true_positive / positive_weight
        precision = true_positive / predicted_positive
        average_precision += (recall - previous_recall) * precision
        previous_recall = recall
        start = end
    return average_precision


def expected_calibration_error(
    labels: FloatArray,
    probabilities: FloatArray,
    weights: FloatArray,
    bin_count: int = 10,
) -> float:
    """Calculate equal-width weighted expected calibration error."""

    if bin_count <= 0:
        raise ValueError("bin_count must be positive")
    total_weight = float(weights.sum())
    error = 0.0
    bin_indexes = np.minimum(
        (np.clip(probabilities, 0, 1) * bin_count).astype(int),
        bin_count - 1,
    )
    for bin_index in range(bin_count):
        selected = bin_indexes == bin_index
        selected_weight = float(weights[selected].sum())
        if selected_weight <= 0:
            continue
        observed = _weighted_mean(labels[selected], weights[selected])
        forecast = _weighted_mean(probabilities[selected], weights[selected])
        error += selected_weight / total_weight * abs(observed - forecast)
    return error


def probability_logits(probabilities: FloatArray) -> FloatArray:
    """Convert clipped probabilities to finite logits."""

    clipped = np.clip(probabilities, 1e-9, 1 - 1e-9)
    return np.log(clipped / (1 - clipped))


def _fit_logistic_coefficients(
    design: FloatArray,
    labels: FloatArray,
    weights: FloatArray,
    regularization: float,
    penalize_from_index: int = 1,
) -> FloatArray:
    coefficients = np.zeros(design.shape[1], dtype=np.float64)
    weight_sum = float(weights.sum())
    penalty = np.zeros(design.shape[1], dtype=np.float64)
    penalty[penalize_from_index:] = regularization
    for _iteration in range(100):
        logits = np.clip(design @ coefficients, -35, 35)
        probabilities = 1 / (1 + np.exp(-logits))
        gradient = design.T @ (weights * (probabilities - labels)) / weight_sum
        gradient += penalty * coefficients
        curvature = weights * probabilities * (1 - probabilities)
        hessian = design.T @ (design * curvature[:, None]) / weight_sum
        hessian += np.diag(penalty + 1e-9)
        try:
            step = np.linalg.solve(hessian, gradient)
        except np.linalg.LinAlgError:
            step = np.linalg.pinv(hessian) @ gradient
        coefficients -= step
        if float(np.max(np.abs(step))) < 1e-9:
            break
    return coefficients


def _calibration_diagnostic(
    probabilities: FloatArray,
    labels: FloatArray,
    weights: FloatArray,
) -> tuple[float | None, float | None]:
    event_rate = _weighted_mean(labels, weights)
    if event_rate <= 0 or event_rate >= 1:
        return None, None
    design = np.column_stack((np.ones(len(probabilities)), probability_logits(probabilities)))
    coefficients = _fit_logistic_coefficients(
        design,
        labels,
        weights,
        regularization=1e-6,
        penalize_from_index=1,
    )
    return float(coefficients[0]), float(coefficients[1])


def _validate_training_arrays(
    feature_matrix: FloatArray,
    labels: FloatArray,
    weights: FloatArray,
) -> None:
    if len(feature_matrix) == 0:
        raise ValueError("model training requires observations")
    if len(feature_matrix) != len(labels) or len(labels) != len(weights):
        raise ValueError("training arrays must have equal lengths")
    if not np.isfinite(feature_matrix).all():
        raise ValueError("features must be finite")
    if not np.isfinite(labels).all() or not np.isin(labels, (0, 1)).all():
        raise ValueError("labels must be finite binary values")
    if not np.isfinite(weights).all() or (weights <= 0).any():
        raise ValueError("weights must be finite and positive")
    if len(np.unique(labels)) < 2:
        raise ValueError("model training requires both outcome classes")


def _weighted_mean(values: FloatArray, weights: FloatArray) -> float:
    return float(np.sum(values * weights) / np.sum(weights))
