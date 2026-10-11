from __future__ import annotations

import pandas as pd
import pytest

from tooltrace_ml import anomalies, features

from .conftest import NOW, history


@pytest.mark.parametrize("seed", [7, 11, 3])
def test_finds_most_planted_oddities_without_flagging_much_else(seed):
    _, _, _, frames = history(seed=seed)
    f = features.build(frames, prior_late_rate=features.training_prior(frames.checkouts, pd.Timestamp(NOW)))
    model = anomalies.fit(f)
    flagged = model.score(f) >= model.threshold
    planted = f["planted"].notna().to_numpy()
    recall = (flagged & planted).sum() / planted.sum()
    precision = (flagged & planted).sum() / flagged.sum()
    assert recall >= 0.75, recall
    assert precision >= 0.6, precision


def test_reasons_match_what_was_planted(synthetic):
    f = synthetic["features"]
    model = anomalies.fit(f)
    planted = f[f["planted"].notna()]
    reasons = model.reasons(planted)
    for kind, rs in zip(planted["planted"], reasons, strict=True):
        keys = [k for k, _ in rs]
        expected = "hour_deviation" if kind == "odd_hour" else "log_planned_hours"
        assert expected in keys, (kind, rs)


def test_is_deterministic(synthetic):
    f = synthetic["features"]
    a, b = anomalies.fit(f, seed=1), anomalies.fit(f, seed=1)
    assert (a.score(f) == b.score(f)).all()
