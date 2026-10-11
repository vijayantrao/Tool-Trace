from __future__ import annotations

from datetime import timedelta

import pandas as pd

from tooltrace_ml import job, synth

from .conftest import NOW, history


def with_open_checkouts():
    tools, _, _, frames = history()
    co = frames.checkouts
    extra = pd.DataFrame(
        [
            # Chronically late person (index 0), 60 h overdue.
            {
                "id": "open-late",
                "tool_id": tools[0]["id"],
                "holder_id": "person-0",
                "issued_by": "person-0",
                "checked_out_at": NOW - timedelta(hours=84),
                "due_back_at": NOW - timedelta(hours=60),
                "returned_at": pd.NaT,
                "planted": None,
            },
            # Very reliable person (index 2), short daytime check-out, due later today.
            {
                "id": "open-fine",
                "tool_id": tools[4]["id"],
                "holder_id": "person-2",
                "issued_by": "person-2",
                "checked_out_at": NOW - timedelta(hours=1),
                "due_back_at": NOW + timedelta(hours=4),
                "returned_at": pd.NaT,
                "planted": None,
            },
        ]
    )
    for col in ("checked_out_at", "due_back_at", "returned_at"):
        extra[col] = pd.to_datetime(extra[col], utc=True)
    frames.checkouts = pd.concat([co, extra], ignore_index=True)
    return frames


def test_scores_every_open_checkout_and_ranks_them_sensibly():
    result = job.analyse(with_open_checkouts(), NOW)
    scores = {s["checkout_id"]: s for s in result["scores"]}
    assert set(scores) == {"open-late", "open-fine"}
    late, fine = scores["open-late"], scores["open-fine"]
    assert late["late_probability"] == 1.0  # already overdue
    assert late["loss_probability"] > 0.5 > fine["loss_probability"]
    assert fine["late_probability"] < 0.5
    assert any(f["key"] == "holder_history" and "late" in f["text"] for f in late["factors"])
    assert result["metrics"]["scored"]["open"] == 2
    assert result["trained_on"] > 900


def test_flags_recent_oddities_once_with_readable_reasons():
    frames = with_open_checkouts()
    first = job.analyse(frames, NOW)
    assert first["anomalies"], "the generator plants two odd check-outs in the last fortnight"
    for a in first["anomalies"]:
        assert a["reasons"] and all(r["text"] for r in a["reasons"])
    again = job.analyse(frames, NOW, already_flagged={a["checkout_id"] for a in first["anomalies"]})
    assert again["anomalies"] == []


def test_is_reproducible():
    frames = with_open_checkouts()
    assert job.analyse(frames, NOW, seed=3) == job.analyse(frames, NOW, seed=3)


def test_wording():
    assert job.fmt_duration(5.4) == "5 h"
    assert job.fmt_duration(72) == "3.0 days"
    assert job.fmt_duration(400) == "17 days"
    assert job.fmt_clock(9.5) == "09:30"
    assert job.fmt_clock(23.99) == "23:59"
    assert job.fmt_clock(9.999) == "10:00"
    assert job.factor_text("category", pd.Series({"category": "Power Tools"})) == "Power Tools are often returned late"
    assert job.factor_text("category", pd.Series({"category": "Torque"})) == "Torque tools are often returned late"
    assert synth.EMAIL_DOMAIN.endswith(".example")  # fictional people only
