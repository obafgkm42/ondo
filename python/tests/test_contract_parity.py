"""Cross-language contract tests for the Python research parameters."""

from __future__ import annotations

from pathlib import Path
import re
import tomllib

from reversal_scanner_backtest import signal_engine
from reversal_scanner_backtest.fragility_study import frozen_fragility_thresholds
from reversal_scanner_backtest.resilience_decay_study import ResilienceParameters


PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_frozen_python_parameters_match_typescript_and_runtime_defaults() -> None:
    type_script = (PROJECT_ROOT / "src/signal-engine.ts").read_text(
        encoding="utf-8"
    )
    shared_constants = {
        "MINIMUM_SESSION_CANDLES": signal_engine.MINIMUM_SESSION_CANDLES,
        "ATR_WINDOW": signal_engine.ATR_WINDOW,
        "RANGE_EXTREME_FRACTION": signal_engine.RANGE_EXTREME_FRACTION,
        "MINIMUM_WICK_RATIO": signal_engine.MINIMUM_WICK_RATIO,
        "MINIMUM_BODY_RATIO": signal_engine.MINIMUM_BODY_RATIO,
        "MINIMUM_CLOSE_REJECTION": signal_engine.MINIMUM_CLOSE_REJECTION,
        "VOLUME_SPIKE_MULTIPLIER": signal_engine.VOLUME_SPIKE_MULTIPLIER,
        "BULLISH_MINIMUM_DISTANCE_FROM_VWAP_ATR": (
            signal_engine.BULLISH_MINIMUM_DISTANCE_FROM_VWAP_ATR
        ),
        "BEARISH_MINIMUM_DISTANCE_FROM_VWAP_ATR": (
            signal_engine.BEARISH_MINIMUM_DISTANCE_FROM_VWAP_ATR
        ),
        "MINIMUM_SESSION_RANGE_ATR": signal_engine.MINIMUM_SESSION_RANGE_ATR,
        "MAXIMUM_POLICY_RISK_ATR": signal_engine.MAXIMUM_POLICY_RISK_ATR,
    }
    for name, python_value in shared_constants.items():
        match = re.search(rf"const {name} = ([0-9.]+);", type_script)
        assert match is not None
        assert float(match.group(1)) == python_value

    runtime = tomllib.loads(
        (PROJECT_ROOT / "wrangler.toml").read_text(encoding="utf-8")
    )["vars"]
    thresholds = signal_engine.FROZEN_SIGNAL_V1_THRESHOLDS
    assert float(runtime["MINIMUM_WATCH_PRICE_R"]) == thresholds.minimum_watch_price_r
    assert (
        float(runtime["MINIMUM_WATCH_CONFIDENCE_SCORE"])
        == thresholds.minimum_watch_confidence_score
    )
    assert float(runtime["MINIMUM_PRICE_R"]) == thresholds.minimum_price_r
    assert (
        float(runtime["MINIMUM_CONFIDENCE_SCORE"])
        == thresholds.minimum_confidence_score
    )


def test_frozen_fragility_parameters_match_typescript() -> None:
    type_script = (PROJECT_ROOT / "src/market-fragility.ts").read_text(
        encoding="utf-8"
    )
    thresholds = frozen_fragility_thresholds()
    shared = {
        "MINIMUM_PRICE_CANDLES": thresholds["minimumPriceCandles"],
        "FRAGILITY_ATR_WINDOW": thresholds["atrWindow"],
        "SESSION_LOSS_THRESHOLD": thresholds["sessionLossThreshold"],
        "VWAP_GAP_ATR_THRESHOLD": thresholds["vwapGapAtrThreshold"],
        "VWAP_CONFIRMATION_CANDLES": thresholds["vwapConfirmationCandles"],
        "POOR_CLOSE_LOCATION_THRESHOLD": thresholds[
            "poorCloseLocationThreshold"
        ],
        "TAIL_LOOKBACK_RETURNS": thresholds["tailLookbackReturns"],
        "LARGE_DOWN_RETURN_FLOOR": thresholds["largeDownReturnFloor"],
        "LARGE_DOWN_RETURN_MEDIAN_MULTIPLIER": thresholds[
            "largeDownReturnMedianMultiplier"
        ],
        "LARGE_DOWN_RETURN_COUNT": thresholds["largeDownReturnCount"],
        "BREADTH_MINIMUM_ASSETS": thresholds["breadthMinimumAssets"],
        "BREADTH_DECLINE_THRESHOLD": thresholds["breadthDeclineThreshold"],
        "BREADTH_STRESS_RATIO": thresholds["breadthStressRatio"],
        "CROSS_ASSET_LOSS_THRESHOLD": thresholds["crossAssetLossThreshold"],
        "TOTAL_INDICATOR_COUNT": thresholds["totalIndicatorCount"],
        "MINIMUM_AVAILABLE_INDICATORS": thresholds[
            "minimumAvailableIndicators"
        ],
    }
    for name, python_value in shared.items():
        match = re.search(rf"const {name} = (-?[0-9.]+);", type_script)
        assert match is not None
        assert float(match.group(1)) == float(python_value)


def test_resilience_decay_parameters_match_typescript() -> None:
    type_script = (PROJECT_ROOT / "src/resilience-decay.ts").read_text(
        encoding="utf-8"
    )
    parameters = ResilienceParameters()
    shared = {
        "SHOCK_DROP_THRESHOLD": parameters.shock_drop_threshold,
        "MAX_COMPLETED_SHOCKS": parameters.maximum_completed_shocks,
        "FADING_RECENT_RESILIENCE_MINIMUM": (
            parameters.fading_recent_minimum
        ),
        "FADING_DECAY_DELTA_THRESHOLD": (
            parameters.fading_decay_delta_threshold
        ),
        "ONE_HOUR_SCORE_WEIGHT": parameters.one_hour_weight,
        "TWO_HOUR_SCORE_WEIGHT": parameters.two_hour_weight,
        "CLOSE_SCORE_WEIGHT": parameters.close_weight,
    }
    for name, python_value in shared.items():
        match = re.search(rf"const {name} = (-?[0-9.]+);", type_script)
        assert match is not None
        assert float(match.group(1)) == float(python_value)
