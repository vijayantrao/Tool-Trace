"""
Unusual check-outs, found with an Isolation Forest: points that are easy to
isolate with a few random cuts are unlike the rest.

The forest decides *whether* a check-out is unusual; robust z-scores against
the typical check-out explain *why*, in words a storekeeper can check.
A flag is a prompt for a person to look, never a verdict.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
from sklearn.ensemble import IsolationForest

from .features import ANOMALY_FEATURES

FLAG_FRACTION = 0.02  # flag check-outs as unusual as the strangest 2% of history
REASON_Z = 2.5
SCALE_FLOOR = {"hour_deviation": 1.0, "log_planned_hours": 0.3, "category_novelty": 0.1}


@dataclass
class AnomalyModel:
    forest: IsolationForest
    fill: pd.Series
    median: pd.Series
    scale: pd.Series
    threshold: float
    trained_on: int

    def matrix(self, f: pd.DataFrame) -> pd.DataFrame:
        return f[ANOMALY_FEATURES].astype(float).fillna(self.fill)

    def score(self, f: pd.DataFrame) -> np.ndarray:
        """Higher = more unusual (the forest's score, negated)."""
        return -self.forest.score_samples(self.matrix(f))

    def reasons(self, f: pd.DataFrame) -> list[list[tuple[str, float]]]:
        z = (self.matrix(f) - self.median) / self.scale
        out = []
        for _, row in z.iterrows():
            ranked = sorted(row.items(), key=lambda kv: -kv[1])
            strong = [(k, round(float(v), 2)) for k, v in ranked if v >= REASON_Z]
            out.append(strong or [(ranked[0][0], round(float(ranked[0][1]), 2))])
        return out


def fit(f: pd.DataFrame, *, seed: int = 0) -> AnomalyModel:
    x = f[ANOMALY_FEATURES].astype(float)
    fill = x.median().fillna(0.0)
    x = x.fillna(fill)
    forest = IsolationForest(n_estimators=300, random_state=seed).fit(x)
    scores = -forest.score_samples(x)
    q1, q3 = x.quantile(0.25), x.quantile(0.75)
    scale = ((q3 - q1) / 1.349).combine(pd.Series(SCALE_FLOOR), max)
    return AnomalyModel(
        forest=forest,
        fill=fill,
        median=x.median(),
        scale=scale[ANOMALY_FEATURES],
        threshold=float(np.quantile(scores, 1 - FLAG_FRACTION)),
        trained_on=len(x),
    )
