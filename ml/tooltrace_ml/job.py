"""
The nightly job: learn from history, score what's out now, flag what's odd.

It runs as the database role tooltrace_ml, which can read only the columns it
learns from (no names, emails or notes) and write only its own result tables.
All results are written in one transaction, and the run is recorded in the
tamper-evident audit trail.
"""

from __future__ import annotations

import math
import traceback
from datetime import UTC, datetime

import numpy as np
import pandas as pd
import psycopg
from psycopg.types.json import Jsonb

from . import SITE_TZ, __version__, anomalies, features, models

AUDIT_LOCK_ID = 727_274_100  # same lock every writer takes first (see apps/api/src/middleware/db.ts)
ANOMALY_LOOKBACK_DAYS = 14


# ------------------------------------------------------------------ wording
def fmt_duration(hours: float) -> str:
    if hours < 48:
        return f"{hours:.0f} h"
    days = hours / 24
    return f"{days:.1f} days" if days < 10 else f"{days:.0f} days"


def fmt_clock(hour: float) -> str:
    h, m = divmod(round(hour * 60) % (24 * 60), 60)  # 9.999 h -> 10:00, not 09:00
    return f"{h:02d}:{m:02d}"


def factor_text(key: str, row: pd.Series) -> str:
    if key == "holder_history":
        n, late = int(row["holder_history"]), int(row["holder_late"])
        return f"Returned {late} of {n} past check-outs late" if n else "No return history yet"
    if key == "planned":
        return f"Long check-out: {fmt_duration(row['planned_hours'])}"
    if key == "night":
        return f"Checked out at night ({fmt_clock(row['local_hour'])})"
    if key == "weekend":
        return "Due back across a weekend"
    if key == "tool_history":
        return f"This tool often comes back late ({row['tool_late_rate'] * 100:.0f}%)"
    if key == "open":
        n = int(row["holder_open_count"])
        return f"Already holding {n} other tool{'s' if n != 1 else ''}"
    if key == "issued_by_other":
        return "Issued by crib staff"
    if key == "category":
        cat = row["category"]
        kind = cat if cat.lower().endswith(("tools", "gear", "equipment")) else f"{cat} tools"
        return f"{kind} are often returned late"
    return key


def reason_text(key: str, row: pd.Series, typical_planned_hours: float) -> str:
    if key == "hour_deviation":
        if math.isnan(row["usual_hour"]):
            return f"Checked out at {fmt_clock(row['local_hour'])}"
        return f"Checked out at {fmt_clock(row['local_hour'])}; usually around {fmt_clock(row['usual_hour'])}"
    if key == "log_planned_hours":
        planned, typical = fmt_duration(row["planned_hours"]), fmt_duration(typical_planned_hours)
        return f"Planned for {planned}; most check-outs are {typical}"
    if key == "category_novelty":
        if row["holder_same_category"] == 0:
            return f"First time with {row['category']} tools"
        return f"Rarely uses {row['category']} tools"
    return key


# ------------------------------------------------------------------ data
def load(conn: psycopg.Connection) -> features.Frames:
    def frame(query: str) -> pd.DataFrame:
        with conn.cursor() as cur:
            cur.execute(query)
            return pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])

    co = frame(
        "SELECT id::text, tool_id::text, holder_id::text, issued_by::text, checked_out_at, due_back_at, returned_at "
        "FROM checkouts"
    )
    for col in ("checked_out_at", "due_back_at", "returned_at"):
        co[col] = pd.to_datetime(co[col], utc=True)
    tools = frame("SELECT id::text, asset_tag, category FROM tools")
    return features.Frames(checkouts=co, tools=tools)


# ------------------------------------------------------------------ the job
def analyse(frames: features.Frames, now: datetime, *, seed: int = 0, already_flagged: set[str] | None = None) -> dict:
    """Pure computation (no database): models, scores for open check-outs, new anomalies, metrics."""
    already_flagged = already_flagged or set()
    now_ts = pd.Timestamp(now)
    prior = features.training_prior(frames.checkouts, now_ts)
    f = features.build(frames, prior_late_rate=prior)
    y = features.outcomes(f, now_ts)

    late = models.fit(f, y["late"], "late", seed=seed)
    loss = models.fit(f, y["loss"], "loss", seed=seed)
    update = models.LossUpdate.from_history(y["lateness_hours"], y["late"])

    open_rows = f[f["returned_at"].isna()]
    scores = []
    if len(open_rows):
        x = features.design_matrix(open_rows, late.categories)
        p_late = late.predict(x)
        p_loss = loss.predict(features.design_matrix(open_rows, loss.categories))
        why = models.explain(late, x)
        for (_, row), pl, pq, factors in zip(open_rows.iterrows(), p_late, p_loss, why, strict=True):
            overdue_h = (now_ts - row["due_back_at"]) / pd.Timedelta(hours=1)
            late_p, loss_p = update.update(float(pl), float(pq), float(overdue_h))
            scores.append(
                {
                    "checkout_id": row["id"],
                    "late_probability": round(late_p, 4),
                    "loss_probability": round(loss_p, 4),
                    "factors": [{"key": k, "text": factor_text(k, row), "impact": v} for k, v in factors],
                }
            )

    detector = anomalies.fit(f, seed=seed)
    recent = f[f["checked_out_at"] >= now_ts - pd.Timedelta(days=ANOMALY_LOOKBACK_DAYS)]
    flagged = []
    if len(recent):
        s = detector.score(recent)
        reasons = detector.reasons(recent)
        typical = float(np.expm1(detector.median["log_planned_hours"]))
        for (_, row), score, rs in zip(recent.iterrows(), s, reasons, strict=True):
            if score >= detector.threshold and row["id"] not in already_flagged:
                flagged.append(
                    {
                        "checkout_id": row["id"],
                        "score": round(float(score), 4),
                        "reasons": [{"key": k, "text": reason_text(k, row, typical), "z": z} for k, z in rs],
                    }
                )

    metrics = {
        "late": late.metrics,
        "loss": loss.metrics,
        "anomaly": {
            "trainedOn": detector.trained_on,
            "flagFraction": anomalies.FLAG_FRACTION,
            "threshold": round(detector.threshold, 4),
            "scoredRecent": len(recent),
            "flaggedNew": len(flagged),
        },
        "scored": {"open": len(scores)},
        "data": {
            "checkouts": len(f),
            "from": f["checked_out_at"].min().isoformat() if len(f) else None,
            "to": f["checked_out_at"].max().isoformat() if len(f) else None,
            "priorLateRate": round(prior, 4),
            "siteTimeZone": str(SITE_TZ),
        },
    }
    version = f"{__version__}+late.{late.name}+loss.{loss.name}"
    trained_on = int(late.metrics.get("labelled", 0))
    return {"scores": scores, "anomalies": flagged, "metrics": metrics, "version": version, "trained_on": trained_on}


def run(conn: psycopg.Connection, *, now: datetime | None = None, seed: int = 0) -> dict:
    """Runs the whole job against the database. `conn` must be in autocommit mode."""
    now = now or datetime.now(tz=UTC)
    conn.execute("SET ROLE tooltrace_ml")
    run_id = conn.execute(
        "INSERT INTO ml_runs (model_version) VALUES (%s) RETURNING id::text", (f"{__version__}+pending",)
    ).fetchone()[0]
    try:
        flagged_before = {r[0] for r in conn.execute("SELECT checkout_id::text FROM anomalies").fetchall()}
        result = analyse(load(conn), now, seed=seed, already_flagged=flagged_before)
        with conn.transaction():
            conn.execute("SELECT pg_advisory_xact_lock(%s)", (AUDIT_LOCK_ID,))
            with conn.cursor() as cur:
                cur.executemany(
                    """INSERT INTO risk_scores (checkout_id, run_id, late_probability, loss_probability, factors)
                       VALUES (%s, %s, %s, %s, %s)
                       ON CONFLICT (checkout_id) DO UPDATE SET run_id = EXCLUDED.run_id,
                           late_probability = EXCLUDED.late_probability, loss_probability = EXCLUDED.loss_probability,
                           factors = EXCLUDED.factors, scored_at = now()""",
                    [
                        (s["checkout_id"], run_id, s["late_probability"], s["loss_probability"], Jsonb(s["factors"]))
                        for s in result["scores"]
                    ],
                )
                # Scores are for tools that are out; drop the ones that came back.
                cur.execute(
                    "DELETE FROM risk_scores r USING checkouts c "
                    "WHERE c.id = r.checkout_id AND c.returned_at IS NOT NULL"
                )
                cur.executemany(
                    """INSERT INTO anomalies (checkout_id, run_id, score, reasons) VALUES (%s, %s, %s, %s)
                       ON CONFLICT (checkout_id) DO NOTHING""",
                    [(a["checkout_id"], run_id, a["score"], Jsonb(a["reasons"])) for a in result["anomalies"]],
                )
                cur.execute(
                    """UPDATE ml_runs SET status = 'succeeded', finished_at = now(), model_version = %s,
                           trained_on = %s, metrics = %s WHERE id = %s""",
                    (result["version"], result["trained_on"], Jsonb(result["metrics"]), run_id),
                )
        return {
            "runId": run_id,
            **{k: result[k] for k in ("version", "trained_on")},
            "scored": len(result["scores"]),
            "flagged": len(result["anomalies"]),
            "metrics": result["metrics"],
        }
    except Exception as err:
        message = "".join(traceback.format_exception_only(type(err), err)).strip()[:2000]
        conn.execute(
            "UPDATE ml_runs SET status = 'failed', finished_at = now(), error = %s WHERE id = %s", (message, run_id)
        )
        raise
