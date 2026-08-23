"""Tests for deterministic probability modeling and diagnostics."""

from __future__ import annotations

import numpy as np
import pytest

from reversal_scanner_backtest.probability_evaluation import (
    fit_logistic_probability_model,
    fit_probability_calibrator,
    probability_metrics,
    session_equal_weights,
)


def test_session_equal_weights_give_each_session_one_total_vote() -> None:
    weights = session_equal_weights(["a", "a", "b", "b", "b"])

    assert weights[:2].sum() == 1
    assert weights[2:].sum() == 1


def test_logistic_model_learns_ordered_probabilities() -> None:
    features = np.asarray([[-2.0], [-1.0], [1.0], [2.0]])
    labels = np.asarray([0.0, 0.0, 1.0, 1.0])
    weights = np.ones(4)

    model = fit_logistic_probability_model(
        ("severity",),
        features,
        labels,
        weights,
        regularization=0.01,
    )
    probabilities = model.predict(features)

    assert np.all(np.diff(probabilities) > 0)
    assert probabilities[0] < 0.5 < probabilities[-1]


def test_calibrator_falls_back_for_one_class_without_nan() -> None:
    probabilities = np.asarray([0.1, 0.2, 0.3])
    labels = np.zeros(3)
    weights = np.ones(3)

    calibrator = fit_probability_calibrator(probabilities, labels, weights)
    calibrated = calibrator.predict(probabilities)

    assert calibrator.fallback_reason is not None
    assert np.isfinite(calibrated).all()
    assert np.allclose(calibrated, calibrated[0])


def test_probability_metrics_include_proper_scores_and_ranking() -> None:
    labels = np.asarray([0.0, 0.0, 1.0, 1.0])
    probabilities = np.asarray([0.1, 0.2, 0.8, 0.9])
    weights = np.ones(4)

    metrics = probability_metrics(labels, probabilities, weights)

    assert metrics["brier"] == pytest.approx(0.025)
    assert metrics["rocAuc"] == 1
    assert metrics["prAuc"] == 1
    assert isinstance(metrics["expectedCalibrationError"], float)
