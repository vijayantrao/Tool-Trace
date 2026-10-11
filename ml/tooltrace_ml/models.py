"""
Risk models: P(returned late) and P(lost), plus explanations and the
"it's still out" update for overdue tools.

Model selection is honest about time: train on the oldest 70% of check-outs,
choose between candidates on the next 15%, and report metrics on the newest
15%, which neither the fit nor the choice has seen. The chosen model is then
refit on everything for scoring.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from .features import RISK_FEATURES, category_columns, design_matrix

TRAIN_FRACTION, VALID_FRACTION = 0.70, 0.15
# Gradient boosting must beat the simpler, more explainable model by this much to be chosen.
COMPLEXITY_MARGIN = 0.01
MIN_POSITIVES = 8
# Fewer positives than this in a held-out slice: its scores are too noisy to choose or to report on.
MIN_EVAL_POSITIVES = 10


def candidates(seed: int) -> dict[str, object]:
    return {
        "logistic_regression": make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=2000)),
        "gradient_boosting": HistGradientBoostingClassifier(
            max_depth=3, learning_rate=0.05, max_iter=250, l2_regularization=1.0, min_samples_leaf=20, random_state=seed
        ),
    }


@dataclass
class RiskModel:
    target: str
    name: str
    categories: list[str]
    estimator: object | None = None
    constant: float | None = None
    reference: pd.Series | None = None
    metrics: dict = field(default_factory=dict)

    def predict(self, x: pd.DataFrame) -> np.ndarray:
        if self.estimator is None:
            return np.full(len(x), self.constant if self.constant is not None else 0.0)
        return self.estimator.predict_proba(x[self.columns])[:, 1]

    @property
    def columns(self) -> list[str]:
        return RISK_FEATURES + category_columns(self.categories)


def _auc(y: np.ndarray, p: np.ndarray) -> float | None:
    return float(roc_auc_score(y, p)) if len(np.unique(y)) == 2 else None


def _scores(y: np.ndarray, p: np.ndarray) -> dict:
    return {
        "n": len(y),
        "positives": int(y.sum()),
        "baseRate": round(float(y.mean()), 4) if len(y) else None,
        "rocAuc": None if (a := _auc(y, p)) is None else round(a, 4),
        "prAuc": round(float(average_precision_score(y, p)), 4) if y.sum() > 0 else None,
        "brier": round(float(brier_score_loss(y, p)), 4) if len(y) else None,
    }


def fit(features: pd.DataFrame, labels: pd.Series, target: str, *, seed: int = 0) -> RiskModel:
    """features: output of features.build (in time order). labels: 0/1, NaN = unknown yet."""
    known = labels.notna().to_numpy()
    f = features[known]
    y = labels[known].astype(int).to_numpy()
    categories = sorted(f["category"].unique().tolist())
    x = design_matrix(f, categories)
    n = len(y)
    i1, i2 = int(n * TRAIN_FRACTION), int(n * (TRAIN_FRACTION + VALID_FRACTION))

    if n < 50 or y[:i1].sum() < MIN_POSITIVES or y[:i1].sum() == i1:
        rate = float(y.mean()) if n else 0.0
        return RiskModel(
            target,
            "constant",
            categories,
            constant=rate,
            metrics={"model": "constant", "reason": "not enough history yet", "labelled": n},
        )

    valid_auc: dict[str, float | None] = {}
    for name, est in candidates(seed).items():
        est.fit(x.iloc[:i1], y[:i1])
        auc = _auc(y[i1:i2], est.predict_proba(x.iloc[i1:i2])[:, 1])
        valid_auc[name] = None if auc is None else round(auc, 4)
    lr, gb = valid_auc["logistic_regression"] or 0, valid_auc["gradient_boosting"] or 0
    valid_positives = int(y[i1:i2].sum())
    if valid_positives < MIN_EVAL_POSITIVES:
        # Too few examples to tell the candidates apart: keep the simpler, more explainable one.
        chosen, selection = "logistic_regression", "simpler model by default (too few positives to compare)"
    elif gb > lr + COMPLEXITY_MARGIN:
        chosen, selection = "gradient_boosting", "better on validation"
    else:
        chosen, selection = "logistic_regression", "as good on validation, and simpler"

    # Held-out test: refit the chosen model on train + validation, score the newest slice.
    est = candidates(seed)[chosen]
    est.fit(x.iloc[:i2], y[:i2])
    test = _scores(y[i2:], est.predict_proba(x.iloc[i2:])[:, 1])
    metrics = {
        "model": chosen,
        "labelled": n,
        "validationRocAuc": valid_auc,
        "validationPositives": valid_positives,
        "selection": selection,
        "test": test,
        # Honest flag for the UI: is the held-out score worth quoting?
        "testReliable": test["positives"] >= MIN_EVAL_POSITIVES and test["n"] - test["positives"] >= MIN_EVAL_POSITIVES,
        # Does the model add anything over "this person is often late"?
        "baselineTestRocAuc": None
        if (a := _auc(y[i2:], f["holder_late_rate"].to_numpy()[i2:])) is None
        else round(a, 4),
    }

    final = candidates(seed)[chosen]
    final.fit(x, y)
    reference = x.median()
    top = f["category"].mode().iloc[0]
    for cat, col in zip(categories, category_columns(categories), strict=True):
        reference[col] = 1.0 if cat == top else 0.0
    return RiskModel(target, chosen, categories, estimator=final, reference=reference, metrics=metrics)


# ---------------------------------------------------------------- explanations
GROUPS: dict[str, list[str]] = {
    "holder_history": ["holder_late_rate", "log_holder_history"],
    "planned": ["log_planned_hours"],
    "night": ["is_night"],
    "weekend": ["spans_weekend"],
    "tool_history": ["tool_late_rate"],
    "open": ["holder_open_count"],
    "issued_by_other": ["issued_by_other"],
}
MIN_IMPACT = 0.02


def explain(model: RiskModel, x: pd.DataFrame, top: int = 3) -> list[list[tuple[str, float]]]:
    """
    For each row, the factors that push its risk up the most: how much lower the
    risk would be if that one thing were typical (an "occlusion" explanation,
    which works the same for any model).
    """
    if model.estimator is None or model.reference is None or len(x) == 0:
        return [[] for _ in range(len(x))]
    base = model.predict(x)
    groups = dict(GROUPS, category=category_columns(model.categories))
    impacts = {}
    for key, cols in groups.items():
        changed = x.copy()
        for col in cols:
            changed[col] = model.reference[col]
        impacts[key] = base - model.predict(changed)
    out = []
    for i in range(len(x)):
        ranked = sorted(((k, float(v[i])) for k, v in impacts.items()), key=lambda kv: -kv[1])
        out.append([(k, round(v, 3)) for k, v in ranked[:top] if v >= MIN_IMPACT])
    return out


# ------------------------------------------------- "it's still not back" update
@dataclass
class LossUpdate:
    """
    Empirical distribution of how late late returns were. Used for Bayes' rule:

        P(lost | still out d hours after due) = P(lost) / P(still out at d)
        P(still out at d) = P(late) * S(d),  S(d) = share of late returns later than d

    so a tool's loss risk rises the longer it stays out, as it should.
    """

    lateness_hours: np.ndarray

    @classmethod
    def from_history(cls, lateness_hours: pd.Series, late: pd.Series) -> LossUpdate:
        mask = (late == 1).to_numpy()
        return cls(np.sort(lateness_hours.to_numpy()[mask]))

    def survival(self, d: float) -> float:
        if len(self.lateness_hours) == 0:
            return 1.0
        return float((self.lateness_hours > d).mean())

    def update(self, p_late: float, p_loss: float, hours_overdue: float) -> tuple[float, float]:
        p_loss = min(p_loss, p_late)
        if hours_overdue <= 0:
            return p_late, p_loss
        still_out = p_late * self.survival(hours_overdue)
        posterior = 1.0 if still_out <= p_loss else p_loss / still_out
        return 1.0, float(min(1.0, max(p_loss, posterior)))
