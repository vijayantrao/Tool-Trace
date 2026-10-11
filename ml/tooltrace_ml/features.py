"""
Features for each check-out, computed only from what was known at the moment
it was checked out (no peeking at the future, a.k.a. no data leakage).

For a past check-out to count in someone's history at time t, its outcome must
already have been known at t: it was returned before t, or it was already
overdue at t.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import LATE_GRACE_HOURS, LOSS_AFTER_HOURS, SITE_TZ

# Smoothing strength: someone with no history is assumed to be like everyone else,
# and their own record takes over as it grows.
PRIOR_WEIGHT = 5.0

RISK_FEATURES = [
    "log_planned_hours",
    "is_night",
    "spans_weekend",
    "holder_late_rate",
    "log_holder_history",
    "tool_late_rate",
    "holder_open_count",
    "issued_by_other",
]
# holder_open_count was tried here and removed: in a small crib, "holding two tools" is rare
# enough for the forest to isolate but not actually suspicious, and it drowned out the real
# oddities (recall on planted anomalies fell from ~0.9 to ~0.3). See docs/ML.md.
ANOMALY_FEATURES = ["hour_deviation", "log_planned_hours", "category_novelty"]


@dataclass
class Frames:
    checkouts: pd.DataFrame  # id, tool_id, holder_id, issued_by, checked_out_at, due_back_at, returned_at
    tools: pd.DataFrame  # id, asset_tag, category


def _hours(td: pd.Series | pd.Timedelta) -> pd.Series | float:
    return td / pd.Timedelta(hours=1)


def _naive_utc(ts: pd.Series) -> np.ndarray:
    """Timezone-aware timestamps as plain UTC datetime64 (NaT stays NaT), for fast comparisons."""
    return pd.to_datetime(ts, utc=True).dt.tz_localize(None).to_numpy(dtype="datetime64[us]")


def _local_hour(ts: pd.Series) -> pd.Series:
    local = ts.dt.tz_convert(SITE_TZ)
    return local.dt.hour + local.dt.minute / 60


def _spans_weekend(start: pd.Timestamp, end: pd.Timestamp) -> bool:
    d0, d1 = start.tz_convert(SITE_TZ).normalize(), end.tz_convert(SITE_TZ).normalize()
    days = (d1 - d0).days
    if days >= 6:
        return True
    return any((d0 + pd.Timedelta(days=i)).weekday() >= 5 for i in range(days + 1))


def _circular_mean_hour(hours: np.ndarray) -> float:
    angles = hours / 24 * 2 * math.pi
    a = math.atan2(np.sin(angles).mean(), np.cos(angles).mean())
    return (a / (2 * math.pi) * 24) % 24


def _circular_distance(a: float, b: float) -> float:
    d = abs(a - b) % 24
    return min(d, 24 - d)


def outcomes(c: pd.DataFrame, now: pd.Timestamp) -> pd.DataFrame:
    """Labels as known at `now`. NaN where the outcome isn't known yet (still out, not yet late)."""
    lateness = _hours(c["returned_at"].fillna(now) - c["due_back_at"])
    returned = c["returned_at"].notna()
    late = pd.Series(np.nan, index=c.index)
    late[returned] = (lateness[returned] > LATE_GRACE_HOURS).astype(float)
    late[~returned & (lateness > LATE_GRACE_HOURS)] = 1.0
    loss = pd.Series(np.nan, index=c.index)
    loss[returned] = (lateness[returned] > LOSS_AFTER_HOURS).astype(float)
    loss[~returned & (lateness > LOSS_AFTER_HOURS)] = 1.0
    return pd.DataFrame({"late": late, "loss": loss, "lateness_hours": lateness})


def build(frames: Frames, *, prior_late_rate: float | None = None) -> pd.DataFrame:
    """One row of features per check-out, in check-out order."""
    c = frames.checkouts.sort_values("checked_out_at").reset_index(drop=True).copy()
    c = c.merge(
        frames.tools[["id", "category", "asset_tag"]].rename(columns={"id": "tool_id"}), on="tool_id", how="left"
    )
    c["category"] = c["category"].fillna("Other")

    starts = c["checked_out_at"]
    planned = _hours(c["due_back_at"] - starts).clip(lower=0.25)
    c["planned_hours"] = planned
    c["log_planned_hours"] = np.log1p(planned)
    c["local_hour"] = _local_hour(starts)
    c["is_night"] = ((c["local_hour"] >= 21) | (c["local_hour"] < 5)).astype(float)
    c["spans_weekend"] = [float(_spans_weekend(s, e)) for s, e in zip(starts, c["due_back_at"], strict=True)]
    c["issued_by_other"] = (c["issued_by"] != c["holder_id"]).astype(float)

    if prior_late_rate is None:
        known = outcomes(c, starts.max())["late"].dropna()
        prior_late_rate = float(known.mean()) if len(known) else 0.25

    due = _naive_utc(c["due_back_at"])
    ret = _naive_utc(c["returned_at"])
    start_arr = _naive_utc(starts)
    grace = np.timedelta64(int(LATE_GRACE_HOURS * 3600), "s")
    hours_arr = c["local_hour"].to_numpy()
    cats = c["category"].to_numpy()

    def history(group_col: str) -> tuple[np.ndarray, np.ndarray]:
        n_known = np.zeros(len(c))
        n_late = np.zeros(len(c))
        for _, idx in c.groupby(group_col).indices.items():
            idx = np.sort(idx)
            for pos, i in enumerate(idx):
                t = start_arr[i]
                prev = idx[:pos]
                if len(prev) == 0:
                    continue
                r, d = ret[prev], due[prev]
                returned_before = ~pd.isna(r) & (r < t)
                returned_late = returned_before & (r > d + grace)
                overdue_at_t = (pd.isna(r) | (r >= t)) & (d + grace < t)
                n_known[i] = returned_before.sum() + overdue_at_t.sum()
                n_late[i] = returned_late.sum() + overdue_at_t.sum()
        return n_known, n_late

    h_n, h_late = history("holder_id")
    t_n, t_late = history("tool_id")
    c["holder_history"] = h_n
    c["holder_late"] = h_late
    c["holder_late_rate"] = (h_late + PRIOR_WEIGHT * prior_late_rate) / (h_n + PRIOR_WEIGHT)
    c["log_holder_history"] = np.log1p(h_n)
    c["tool_late_rate"] = (t_late + PRIOR_WEIGHT * prior_late_rate) / (t_n + PRIOR_WEIGHT)

    # What the holder already has out, and how usual this hour and this kind of tool are for them.
    open_count = np.zeros(len(c))
    hour_dev = np.full(len(c), np.nan)
    usual_hour = np.full(len(c), np.nan)
    novelty = np.zeros(len(c))
    prior_count = np.zeros(len(c))
    same_category = np.zeros(len(c))
    for _, idx in c.groupby("holder_id").indices.items():
        idx = np.sort(idx)
        for pos, i in enumerate(idx):
            t = start_arr[i]
            prev = idx[:pos]
            r = ret[prev]
            open_count[i] = (pd.isna(r) | (r > t)).sum()
            if len(prev) >= 5:
                usual = _circular_mean_hour(hours_arr[prev])
                usual_hour[i] = usual
                hour_dev[i] = _circular_distance(hours_arr[i], usual)
            same = (cats[prev] == cats[i]).sum()
            prior_count[i] = len(prev)
            same_category[i] = same
            novelty[i] = 1 - (same + 1) / (len(prev) + 2)
    c["holder_open_count"] = open_count
    c["hour_deviation"] = hour_dev
    c["usual_hour"] = usual_hour
    c["category_novelty"] = novelty
    c["holder_prior_count"] = prior_count
    c["holder_same_category"] = same_category
    c.attrs["prior_late_rate"] = prior_late_rate
    return c


def category_columns(categories: list[str]) -> list[str]:
    return [f"cat::{x}" for x in categories]


def design_matrix(f: pd.DataFrame, categories: list[str]) -> pd.DataFrame:
    """Model inputs: the numeric features plus one column per known tool category."""
    x = f[RISK_FEATURES].astype(float).copy()
    for cat, col in zip(categories, category_columns(categories), strict=True):
        x[col] = (f["category"] == cat).astype(float)
    return x


def training_prior(checkouts: pd.DataFrame, now: pd.Timestamp, train_fraction: float = 0.7) -> float:
    """Overall late rate, from the oldest part of history only (the part models train on)."""
    c = checkouts.sort_values("checked_out_at").reset_index(drop=True)
    late = outcomes(c, now)["late"].dropna()
    head = late.iloc[: max(1, int(len(late) * train_fraction))]
    return float(head.mean()) if len(head) else 0.25
