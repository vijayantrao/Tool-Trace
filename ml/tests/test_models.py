from __future__ import annotations

from itertools import pairwise

import numpy as np
import pandas as pd
import pytest
from sklearn.metrics import roc_auc_score

from tooltrace_ml import features, models

from .conftest import NOW, history


def fit_late(seed: int):
    _, _, _, frames = history(seed=seed)
    f = features.build(frames, prior_late_rate=features.training_prior(frames.checkouts, pd.Timestamp(NOW)))
    y = features.outcomes(f, pd.Timestamp(NOW))
    return f, models.fit(f, y["late"], "late")


@pytest.mark.parametrize("seed", [7, 11, 3])
def test_late_model_gets_close_to_the_best_possible_on_unseen_later_data(seed):
    f, m = fit_late(seed)
    test = m.metrics["test"]
    assert test["n"] > 100
    # The oracle knows each check-out's true probability from the generator: no model can do better
    # on average. Being within a few points of it means the model found the real patterns.
    y = features.outcomes(f, pd.Timestamp(NOW))["late"]
    known = y.notna().to_numpy()
    i2 = int(known.sum() * (models.TRAIN_FRACTION + models.VALID_FRACTION))
    oracle = roc_auc_score(y[known].to_numpy()[i2:], f["true_p_late"].to_numpy()[known][i2:])
    assert test["rocAuc"] >= oracle - 0.06, (test["rocAuc"], oracle)
    assert test["brier"] < test["baseRate"] * (1 - test["baseRate"])  # better than always guessing the base rate


def test_beats_this_person_is_often_late_on_average():
    # Per history, a ~165-row test slice is noisy (on one seed even the oracle loses to this
    # baseline), so the claim is checked on the average over several independent histories.
    results = [fit_late(seed)[1].metrics for seed in (7, 11, 3)]
    model = np.mean([r["test"]["rocAuc"] for r in results])
    baseline = np.mean([r["baselineTestRocAuc"] for r in results])
    assert model >= baseline + 0.05, (model, baseline)


def test_learned_effects_point_the_same_way_as_the_truth(synthetic):
    f = synthetic["features"]
    y = features.outcomes(f, pd.Timestamp(NOW))
    m = models.fit(f, y["late"], "late")
    assert m.name == "logistic_regression"  # the simpler model wins unless boosting is clearly better
    coef = dict(zip(m.columns, m.estimator[-1].coef_[0], strict=True))
    for name in ("log_planned_hours", "is_night", "spans_weekend", "holder_late_rate"):
        assert coef[name] > 0, name


def test_too_little_history_falls_back_to_a_constant(synthetic):
    f = synthetic["features"].head(30)
    y = features.outcomes(f, pd.Timestamp(NOW))
    m = models.fit(f, y["late"], "late")
    assert m.name == "constant"
    assert np.allclose(m.predict(features.design_matrix(f, m.categories)), m.constant)


def test_explanations_name_what_raised_the_risk(synthetic):
    f = synthetic["features"]
    y = features.outcomes(f, pd.Timestamp(NOW))
    m = models.fit(f, y["late"], "late")
    row = f.iloc[[len(f) - 1]].copy()
    row["log_planned_hours"] = np.log1p(140.0)  # a six-day check-out
    row["is_night"] = 1.0
    factors = models.explain(m, features.design_matrix(row, m.categories))[0]
    keys = [k for k, _ in factors]
    assert "planned" in keys and "night" in keys
    assert all(v >= models.MIN_IMPACT for _, v in factors)
    assert [v for _, v in factors] == sorted((v for _, v in factors), reverse=True)


def test_loss_risk_rises_the_longer_a_tool_stays_out():
    upd = models.LossUpdate(np.array([1, 2, 3, 5, 8, 12, 24, 30, 200, 300], dtype=float))
    p_late, p_loss = 0.4, 0.05
    assert upd.update(p_late, p_loss, -3) == (p_late, p_loss)  # not due yet: unchanged
    seen = [upd.update(p_late, p_loss, d)[1] for d in (1, 4, 10, 26, 100, 250, 400)]
    assert all(0 <= a <= b <= 1 for a, b in pairwise(seen))
    assert seen[0] > p_loss
    assert seen[-1] == 1.0  # later than any late return ever seen: it's gone
    assert upd.update(p_late, p_loss, 1)[0] == 1.0  # already late


@pytest.mark.parametrize("seed", [7, 11, 3])
def test_rare_losses_never_justify_the_complex_model_or_a_quoted_score(seed):
    _, _, _, frames = history(seed=seed)
    f = features.build(frames, prior_late_rate=features.training_prior(frames.checkouts, pd.Timestamp(NOW)))
    m = models.fit(f, features.outcomes(f, pd.Timestamp(NOW))["loss"], "loss")
    # Only a handful of losses land in each held-out slice: choosing on them, or quoting
    # a score measured on them, would be reading noise.
    assert m.metrics["validationPositives"] < models.MIN_EVAL_POSITIVES
    assert m.name == "logistic_regression"
    assert m.metrics["testReliable"] is False


def test_late_scores_are_reliable_enough_to_quote(synthetic):
    f = synthetic["features"]
    m = models.fit(f, features.outcomes(f, pd.Timestamp(NOW))["late"], "late")
    assert m.metrics["testReliable"] is True
