"""The whole job against a real PostgreSQL, as the least-privileged ML role."""

from __future__ import annotations

import psycopg
import pytest
from psycopg import errors

from tooltrace_ml import job
from tooltrace_ml.history import seed_history


@pytest.fixture
def seeded(database):
    with psycopg.connect(database, autocommit=True) as conn:
        summary = seed_history(conn, with_open=True)
    return database, summary


def test_history_import_is_recorded_once_and_refuses_to_run_twice(seeded):
    url, summary = seeded
    assert summary["checkouts"] > 900 and len(summary["open"]) == 3
    with psycopg.connect(url, autocommit=True) as conn:
        assert seed_history(conn)["skipped"] is True
        actions = [r[0] for r in conn.execute("SELECT action FROM audit_log WHERE action LIKE 'data.%'")]
        assert actions == ["data.imported"]
        # One audit entry for the import, not a thousand "checked out" entries.
        assert conn.execute("SELECT count(*) FROM audit_log WHERE action = 'tool.checked_out'").fetchone()[0] == 0
        statuses = conn.execute("SELECT count(*) FROM tools WHERE status = 'checked_out'").fetchone()[0]
        assert statuses == 3


def test_run_writes_scores_flags_and_an_audited_run_record(seeded):
    url, _ = seeded
    with psycopg.connect(url, autocommit=True) as conn:
        result = job.run(conn)
        assert result["scored"] == 3 and result["flagged"] >= 1
    with psycopg.connect(url, autocommit=True) as conn:
        status, trained, metrics = conn.execute(
            "SELECT status, trained_on, metrics FROM ml_runs ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
        assert status == "succeeded" and trained > 900
        assert metrics["late"]["test"]["rocAuc"] > 0.7
        assert conn.execute("SELECT count(*) FROM risk_scores").fetchone()[0] == 3
        actions = [r[0] for r in conn.execute("SELECT action FROM audit_log ORDER BY id DESC LIMIT 3")]
        assert actions[0] == "ml.run_completed" and "anomaly.flagged" in actions

        # A second run updates scores in place and never flags the same check-out twice.
        flagged = conn.execute("SELECT count(*) FROM anomalies").fetchone()[0]
        conn.execute("RESET ROLE")
        again = job.run(conn)
        assert again["flagged"] == 0
        assert conn.execute("SELECT count(*) FROM anomalies").fetchone()[0] == flagged
        assert conn.execute("SELECT count(*) FROM risk_scores").fetchone()[0] == 3


def test_a_returned_tool_loses_its_score(seeded):
    url, _ = seeded
    with psycopg.connect(url, autocommit=True) as conn:
        job.run(conn)
        conn.execute("RESET ROLE")
        sk = conn.execute("SELECT id FROM users WHERE role = 'storekeeper' LIMIT 1").fetchone()[0]
        conn.execute(
            """UPDATE checkouts SET returned_at = now(), received_by = %s, condition_on_return = 'ok'
               WHERE id = (SELECT checkout_id FROM risk_scores LIMIT 1)""",
            (sk,),
        )
        job.run(conn)
        assert conn.execute("SELECT count(*) FROM risk_scores").fetchone()[0] == 2


def test_ml_role_reads_only_what_it_learns_from(seeded):
    url, _ = seeded
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("SET ROLE tooltrace_ml")
        for query in (
            "SELECT email FROM users",
            "SELECT display_name FROM users",
            "SELECT notes FROM checkouts",
            "SELECT * FROM passkeys",
            "SELECT * FROM audit_log",
            "UPDATE checkouts SET due_back_at = now() + interval '1 day'",
            "UPDATE anomalies SET status = 'dismissed'",
            "SELECT audit_append('x', 'y', 'z', '{}')",
        ):
            with pytest.raises(errors.InsufficientPrivilege):
                conn.execute(query)


def test_a_failed_run_is_recorded_as_failed(seeded, monkeypatch):
    url, _ = seeded

    def boom(*_args, **_kwargs):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(job, "analyse", boom)
    with psycopg.connect(url, autocommit=True) as conn, pytest.raises(RuntimeError):
        job.run(conn)
    with psycopg.connect(url, autocommit=True) as conn:
        status, error = conn.execute("SELECT status, error FROM ml_runs ORDER BY started_at DESC LIMIT 1").fetchone()
        assert status == "failed" and "model exploded" in error
        last = conn.execute("SELECT action FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()[0]
        assert last == "ml.run_failed"
