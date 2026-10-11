from __future__ import annotations

import os
import uuid
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd
import psycopg
import pytest

from tooltrace_ml import features, synth

NOW = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)
MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


def history(seed: int = 7, now: datetime = NOW):
    tools = synth.demo_tools(now.date())
    people, checkouts = synth.generate(tools, now=now, seed=seed)
    return tools, people, checkouts, synth.to_frames(tools, people, checkouts)


@pytest.fixture(scope="session")
def synthetic():
    tools, people, checkouts, frames = history()
    f = features.build(frames, prior_late_rate=features.training_prior(frames.checkouts, pd.Timestamp(NOW)))
    return {"tools": tools, "people": people, "checkouts": checkouts, "frames": frames, "features": f}


@pytest.fixture
def database():
    """A fresh, migrated database with the nine demo tools. Needs TEST_DATABASE_ADMIN_URL."""
    admin_url = os.environ.get("TEST_DATABASE_ADMIN_URL")
    if not admin_url:
        pytest.skip("TEST_DATABASE_ADMIN_URL not set")
    name = f"tooltrace_ml_test_{uuid.uuid4().hex[:10]}"
    with psycopg.connect(admin_url, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    url = psycopg.conninfo.make_conninfo(admin_url, dbname=name)
    try:
        with psycopg.connect(url, autocommit=True) as conn:
            for path in sorted(MIGRATIONS.glob("[0-9][0-9][0-9]_*.sql")):
                conn.execute(path.read_text())
            loc = conn.execute(
                "INSERT INTO locations (name, kind) VALUES ('Main Tool Crib', 'crib') RETURNING id"
            ).fetchone()[0]
            for tool in synth.demo_tools(datetime.now(tz=UTC).date()):
                cal = tool["requires_calibration"]
                due = tool["calibration_due_on"]
                interval = next(i for t, _, i, _ in synth.DEMO_TOOLS if t == tool["asset_tag"])
                conn.execute(
                    """INSERT INTO tools (asset_tag, name, category, home_location_id, requires_calibration,
                                          calibration_interval_days, last_calibrated_on, calibration_due_on)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        tool["asset_tag"],
                        tool["asset_tag"],
                        tool["category"],
                        loc,
                        cal,
                        interval,
                        (due - pd.Timedelta(days=interval)) if cal else None,
                        due,
                    ),
                )
        yield url
    finally:
        with psycopg.connect(admin_url, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
