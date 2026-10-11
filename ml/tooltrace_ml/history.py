"""
Imports the synthetic history into a database (demo and test environments only).

History is imported the way a real data migration would be: per-row triggers
are paused for the import (otherwise a year of history would land in the audit
trail as a thousand "checked out just now" entries), and the import itself is
recorded in the audit trail as one entry with its size and parameters. Runs as
the database owner. Refuses to run twice.
"""

from __future__ import annotations

import os
import random
from datetime import UTC, datetime, timedelta

import psycopg
from psycopg.types.json import Jsonb

from . import synth
from .job import AUDIT_LOCK_ID


def seed_history(conn: psycopg.Connection, *, days: int = 365, seed: int = 7, with_open: bool = False) -> dict:
    """`conn` must be in autocommit mode and connected as the schema owner."""
    now = datetime.now(tz=UTC)
    exists = conn.execute("SELECT count(*) FROM users WHERE email LIKE %s", (f"%@{synth.EMAIL_DOMAIN}",)).fetchone()[0]
    if exists:
        return {"skipped": True, "reason": "synthetic history is already imported"}

    rows = conn.execute(
        "SELECT id::text, asset_tag, category, requires_calibration, calibration_due_on, status "
        "FROM tools ORDER BY asset_tag"
    ).fetchall()
    if not rows:
        raise SystemExit("No tools found. Run the API's seed-demo script first.")
    tools = [
        {
            "id": r[0],
            "asset_tag": r[1],
            "category": r[2],
            "requires_calibration": r[3],
            "calibration_due_on": r[4],
            "status": r[5],
        }
        for r in rows
    ]
    people, checkouts = synth.generate(tools, days=days, seed=seed, now=now)
    rng = random.Random(seed)

    with conn.transaction():
        conn.execute("SELECT pg_advisory_xact_lock(%s)", (AUDIT_LOCK_ID,))
        conn.execute("ALTER TABLE users DISABLE TRIGGER USER")
        conn.execute("ALTER TABLE checkouts DISABLE TRIGGER USER")
        ids = []
        for p in people:
            ids.append(
                conn.execute(
                    """INSERT INTO users (email, display_name, role, webauthn_user_id, created_at)
                       VALUES (%s, %s, %s, %s, %s) RETURNING id::text""",
                    (p.email, p.name, p.role, os.urandom(32), now - timedelta(days=days + 14)),
                ).fetchone()[0]
            )
        storekeepers = [ids[i] for i, p in enumerate(people) if p.role == "storekeeper"]
        with conn.cursor() as cur:
            cur.executemany(
                """INSERT INTO checkouts (tool_id, holder_id, issued_by, checked_out_at, due_back_at,
                                          returned_at, received_by, condition_on_return)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                [
                    (
                        tools[c.tool_index]["id"],
                        ids[c.holder],
                        ids[c.issued_by],
                        c.checked_out_at,
                        c.due_back_at,
                        c.returned_at,
                        rng.choice(storekeepers),
                        c.condition,
                    )
                    for c in checkouts
                ],
            )

        opened = []
        if with_open:
            # A few tools out right now, so the Insights page has something to show in a demo.
            free = [
                t
                for t in tools
                if t["status"] == "available"
                and not (t["requires_calibration"] and t["calibration_due_on"] and t["calibration_due_on"] < now.date())
            ]
            plans = [  # (person index, started hours ago, due in hours: negative = overdue)
                (0, 74, -50),  # chronically late person, two days overdue
                (3, 5, 30),  # night shift, due tomorrow
                (2, 2, 6),  # very reliable, due this afternoon
            ]
            for tool, (pi, ago, due_in) in zip(free[-len(plans) :], plans, strict=False):
                conn.execute(
                    """INSERT INTO checkouts (tool_id, holder_id, issued_by, checked_out_at, due_back_at)
                       VALUES (%s, %s, %s, %s, %s)""",
                    (tool["id"], ids[pi], ids[pi], now - timedelta(hours=ago), now + timedelta(hours=due_in)),
                )
                conn.execute("UPDATE tools SET status = 'checked_out' WHERE id = %s", (tool["id"],))
                opened.append(tool["asset_tag"])

        conn.execute("ALTER TABLE checkouts ENABLE TRIGGER USER")
        conn.execute("ALTER TABLE users ENABLE TRIGGER USER")
        summary = {
            "kind": "synthetic demo history",
            "people": len(people),
            "checkouts": len(checkouts) + len(opened),
            "open": opened,
            "days": days,
            "seed": seed,
        }
        conn.execute("SELECT audit_append('data.imported', 'dataset', 'synthetic-history', %s)", (Jsonb(summary),))
    return summary
