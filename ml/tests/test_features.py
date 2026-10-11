from __future__ import annotations

from datetime import timedelta

import numpy as np
import pandas as pd
import pytest

from tooltrace_ml import features
from tooltrace_ml.features import Frames

from .conftest import NOW


def frames(rows: list[tuple[str, str, float, float, float | None]]) -> Frames:
    """rows: (holder, tool, start hours before NOW, planned hours, returned hours after start or None)."""
    out = []
    for i, (holder, tool, ago, planned, back) in enumerate(rows):
        start = NOW - timedelta(hours=ago)
        out.append(
            {
                "id": f"c{i}",
                "tool_id": tool,
                "holder_id": holder,
                "issued_by": holder,
                "checked_out_at": start,
                "due_back_at": start + timedelta(hours=planned),
                "returned_at": None if back is None else start + timedelta(hours=back),
            }
        )
    co = pd.DataFrame(out)
    for col in ("checked_out_at", "due_back_at", "returned_at"):
        co[col] = pd.to_datetime(co[col], utc=True)
    tools = pd.DataFrame([{"id": t, "asset_tag": t.upper(), "category": "Torque"} for t in co["tool_id"].unique()])
    return Frames(co, tools)


def test_labels_reflect_only_what_is_known_now():
    f = frames(
        [
            ("ana", "t1", 100, 8, 6),  # on time
            ("ana", "t2", 90, 8, 12),  # 4 h late
            ("ana", "t3", 400, 8, 8 + 200),  # 200 h late: lost
            ("ana", "t4", 20, 8, None),  # out, 12 h overdue: known late, loss not known yet
            ("ana", "t5", 2, 8, None),  # out, not due yet: nothing known
        ]
    )
    y = features.outcomes(f.checkouts, pd.Timestamp(NOW)).set_index(f.checkouts["id"])
    assert y.loc["c0", "late"] == 0
    assert y.loc["c1", "late"] == 1 and y.loc["c1", "loss"] == 0
    assert y.loc["c2", "loss"] == 1
    assert y.loc["c3", "late"] == 1 and np.isnan(y.loc["c3", "loss"])
    assert np.isnan(y.loc["c4", "late"]) and np.isnan(y.loc["c4", "loss"])


def test_history_counts_only_outcomes_known_at_checkout_time():
    f = frames(
        [
            ("ana", "t1", 100, 8, 20),  # late, returned 80 h ago
            ("ana", "t2", 60, 48, 49),  # started 60 h ago; at 50 h ago it was neither back nor overdue
            ("ana", "t3", 50, 8, 1),
        ]
    )
    built = features.build(f, prior_late_rate=0.2).set_index("id")
    assert built.loc["c0", "holder_history"] == 0
    assert built.loc["c1", "holder_history"] == 1 and built.loc["c1", "holder_late"] == 1
    # c1 was still out and not yet due when c2 started, so its outcome must not count.
    assert built.loc["c2", "holder_history"] == 1
    assert built.loc["c2", "holder_open_count"] == 1
    # Smoothed rate: (1 late + 5 * 0.2) / (1 + 5)
    assert built.loc["c2", "holder_late_rate"] == pytest.approx(2 / 6)


def test_no_leakage_changing_the_future_never_changes_the_past(synthetic):
    f0 = synthetic["features"]
    co = synthetic["frames"].checkouts.copy()
    cut = co["checked_out_at"].quantile(0.6)
    later = co["checked_out_at"] > cut
    # Rewrite the future: everything after the cut came back absurdly late.
    co.loc[later, "returned_at"] = co.loc[later, "due_back_at"] + pd.Timedelta(days=3)
    f1 = features.build(Frames(co, synthetic["frames"].tools), prior_late_rate=f0.attrs["prior_late_rate"])
    early = f0["checked_out_at"] <= cut
    cols = features.RISK_FEATURES + features.ANOMALY_FEATURES
    pd.testing.assert_frame_equal(
        f0.loc[early, cols].reset_index(drop=True), f1.loc[early.to_numpy(), cols].reset_index(drop=True)
    )


def test_night_and_weekend_use_the_sites_local_time():
    # 2026-10-02 is a Friday. 22:30 in Kolkata is 17:00 UTC.
    start = pd.Timestamp("2026-10-02T17:00:00Z")
    f = Frames(
        pd.DataFrame(
            [
                {
                    "id": "c",
                    "tool_id": "t",
                    "holder_id": "h",
                    "issued_by": "h",
                    "checked_out_at": start,
                    "due_back_at": start + pd.Timedelta(hours=40),
                    "returned_at": pd.NaT,
                }
            ]
        ),
        pd.DataFrame([{"id": "t", "asset_tag": "T", "category": "Torque"}]),
    )
    f.checkouts["returned_at"] = pd.to_datetime(f.checkouts["returned_at"], utc=True)
    row = features.build(f, prior_late_rate=0.2).iloc[0]
    assert row["is_night"] == 1
    assert row["spans_weekend"] == 1
