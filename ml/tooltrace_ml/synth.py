"""
Synthetic check-out history for demos and tests.

ToolTrace is new, so there is no real history to learn from yet. This module
generates a year of plausible activity from a *known* generative model,
with deliberate patterns planted in it:

- each person has a hidden tendency to be late (a few are chronically late,
  a few are very reliable),
- long check-outs, night-shift check-outs and check-outs spanning a weekend
  are more often late,
- power tools and inspection gear go astray more than calibrated instruments,
- a small number of check-outs are deliberately odd (3 a.m. for a day-shift
  worker, or a three-week check-out).

Because the truth is known, the tests can check that the models really
recover these patterns. Everything here is fictional.
"""

from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

import numpy as np

from . import LATE_GRACE_HOURS, SITE_TZ

EMAIL_DOMAIN = "history.tooltrace.example"

TECHNICIANS = [
    "Arjun Mehta",
    "Kavya Iyer",
    "Rohan Das",
    "Sneha Pillai",
    "Vikram Singh",
    "Meera Joshi",
    "Imran Qureshi",
    "Pooja Rawat",
    "Karan Malhotra",
    "Divya Menon",
    "Neha Kulkarni",
    "Aditya Bose",
    "Farhan Sheikh",
    "Tanvi Shah",
]
STOREKEEPERS = ["Gopal Mishra", "Rekha Sinha"]

CATEGORY_EFFECT = {"Power Tools": 0.45, "Inspection": 0.25, "Electrical": 0.1, "Measuring": -0.25, "Torque": -0.3}


@dataclass
class Person:
    name: str
    role: str
    shift: str  # "day" (07-17) or "night" (21-05)
    propensity: float  # hidden log-odds of lateness
    preferred: set[str] = field(default_factory=set)

    @property
    def email(self) -> str:
        return self.name.lower().replace(" ", ".") + "@" + EMAIL_DOMAIN


@dataclass
class Checkout:
    tool_index: int
    holder: int  # index into people
    issued_by: int
    checked_out_at: datetime
    due_back_at: datetime
    returned_at: datetime | None
    condition: str | None
    planted: str | None = None  # "odd_hour" / "very_long": ground truth for the anomaly tests
    true_p_late: float | None = None  # the generator's real probability: the best any model could know


def sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x))


def make_people(rng: np.random.Generator, categories: list[str]) -> list[Person]:
    people: list[Person] = []
    for i, name in enumerate(TECHNICIANS):
        if i < 2:
            propensity = 1.7  # chronically late
        elif i < 5:
            propensity = -1.3  # very reliable
        else:
            propensity = float(rng.normal(0, 0.7))
        shift = "night" if i % 4 == 3 else "day"
        preferred = set(rng.choice(categories, size=min(2, len(categories)), replace=False).tolist())
        people.append(Person(name, "technician", shift, propensity, preferred))
    for name in STOREKEEPERS:
        people.append(Person(name, "storekeeper", "day", -0.5, set(categories)))
    return people


def _is_workday(d: date) -> bool:
    return d.weekday() < 5  # Monday to Friday


def _next_start(t0: datetime, shift: str, rng: np.random.Generator, odd_hour: bool) -> datetime:
    """The first moment at or after t0 when this person would plausibly check a tool out (UTC)."""
    local = t0.astimezone(SITE_TZ)
    for day_offset in range(0, 10):
        d = (local + timedelta(days=day_offset)).date()
        if not _is_workday(d):
            continue
        if odd_hour:
            hour = rng.uniform(1, 4)  # 01:00-04:00, deliberately unusual for a day-shift worker
        elif shift == "day":
            hour = rng.uniform(7, 16.5)
        else:
            hour = rng.uniform(21, 23.9)
        start = datetime(d.year, d.month, d.day, tzinfo=SITE_TZ) + timedelta(hours=float(hour))
        if start >= local:
            return start.astimezone(t0.tzinfo)
    return t0  # unreachable in practice


def spans_weekend(start: datetime, end: datetime) -> bool:
    d = start.astimezone(SITE_TZ).date()
    last = end.astimezone(SITE_TZ).date()
    while d <= last:
        if d.weekday() >= 5:
            return True
        d += timedelta(days=1)
    return False


def is_night(t: datetime) -> bool:
    h = t.astimezone(SITE_TZ).hour
    return h >= 21 or h < 5


def generate(
    tools: list[dict], *, days: int = 365, seed: int = 7, now: datetime | None = None
) -> tuple[list[Person], list[Checkout]]:
    """
    tools: dicts with "category", "requires_calibration" and "calibration_due_on" (date or None).
    Returns people and closed check-outs, all returned before `now`.
    """
    rng = np.random.default_rng(seed)
    now = now or datetime.now(tz=SITE_TZ)
    categories = sorted({t["category"] for t in tools})
    people = make_people(rng, categories)
    storekeepers = [i for i, p in enumerate(people) if p.role == "storekeeper"]
    checkouts: list[Checkout] = []

    # Two odd check-outs in the last fortnight, so a fresh demo always has something to review.
    recent_odd_left = 2
    heap = [(now - timedelta(days=days) + timedelta(hours=float(rng.uniform(0, 24))), i) for i in range(len(tools))]
    heapq.heapify(heap)
    while heap:
        available_from, ti = heapq.heappop(heap)
        tool = tools[ti]
        weights = np.array(
            [
                (0.15 if p.role == "storekeeper" else 1.0) * (6.0 if tool["category"] in p.preferred else 1.0)
                for p in people
            ]
        )
        holder = int(rng.choice(len(people), p=weights / weights.sum()))
        person = people[holder]

        r = rng.random()
        planted = "odd_hour" if (r < 0.012 and person.shift == "day") else "very_long" if r < 0.02 else None
        if recent_odd_left and person.shift == "day" and available_from >= now - timedelta(days=12):
            planted, recent_odd_left = "odd_hour", recent_odd_left - 1
        start = _next_start(
            available_from + timedelta(hours=float(rng.exponential(10))), person.shift, rng, planted == "odd_hour"
        )
        if start > now - timedelta(hours=30):
            continue
        due_on = tool.get("calibration_due_on")
        if tool.get("requires_calibration") and due_on and start.astimezone(SITE_TZ).date() > due_on:
            continue  # nobody may take an out-of-calibration tool

        if planted == "very_long":
            planned_h = rng.uniform(14, 25) * 24
        else:
            k = rng.random()
            if k < 0.75:
                planned_h = rng.uniform(2, 9)
            elif k < 0.96:
                planned_h = float(rng.choice([24, 48, 72, 96])) + rng.uniform(-2, 2)
            else:
                planned_h = rng.uniform(120, 168)
        due = start + timedelta(hours=float(planned_h))

        open_now = sum(
            1 for c in checkouts if c.holder == holder and c.checked_out_at <= start and (c.returned_at or now) > start
        )
        logit = (
            -1.7
            + person.propensity
            + 0.55 * math.log(planned_h / 8)
            + 0.9 * is_night(start)
            + 0.7 * spans_weekend(start, due)
            + CATEGORY_EFFECT.get(tool["category"], 0.0)
            + 0.5 * (open_now >= 1)
        )
        p_late, p_loss = sigmoid(logit), sigmoid(logit - 2.8)
        u = rng.random()
        if u < p_loss:
            returned = due + timedelta(days=float(rng.uniform(7.5, 21)))
        elif u < p_late:
            hours = float(np.clip(rng.lognormal(math.log(4), 1.0), LATE_GRACE_HOURS + 0.1, 160))
            returned = due + timedelta(hours=hours)
        else:
            early = float(rng.uniform(0, min(planned_h * 0.7, 6)))
            returned = max(due - timedelta(hours=early), start + timedelta(minutes=15))
        if returned >= now - timedelta(minutes=5):
            continue  # history is closed: everything has come back

        c = rng.random()
        if tool.get("requires_calibration") and c < 0.03:
            condition = "needs_calibration"
        elif c < 0.07:
            condition = "damaged"
        else:
            condition = "ok"
        issued_by = int(rng.choice(storekeepers)) if rng.random() < 0.3 else holder
        checkouts.append(Checkout(ti, holder, issued_by, start, due, returned, condition, planted, p_late))
        heapq.heappush(heap, (returned, ti))

    checkouts.sort(key=lambda c: c.checked_out_at)
    return people, checkouts


DEMO_TOOLS = [
    # (asset tag, category, calibration interval days, days since last calibration)
    ("TW-0101", "Torque", 180, 30),
    ("TW-0102", "Torque", 180, 172),
    ("TW-0103", "Torque", 180, 200),
    ("MM-0201", "Electrical", 365, 90),
    ("VC-0301", "Measuring", 365, 20),
    ("DFT-0401", "Measuring", 90, 85),
    ("CR-0501", "Electrical", None, None),
    ("BS-0601", "Inspection", None, None),
    ("IW-0701", "Power Tools", None, None),
]


def demo_tools(today: date) -> list[dict]:
    """The same nine tools the API's demo seed creates (for tests that run without a database)."""
    return [
        {
            "id": f"tool-{i}",
            "asset_tag": tag,
            "category": cat,
            "requires_calibration": interval is not None,
            "calibration_due_on": (today - timedelta(days=ago) + timedelta(days=interval)) if interval else None,
        }
        for i, (tag, cat, interval, ago) in enumerate(DEMO_TOOLS)
    ]


def to_frames(tools: list[dict], people: list[Person], checkouts: list[Checkout]):
    """In-memory equivalent of what the job reads from the database."""
    import pandas as pd

    from .features import Frames

    rows = [
        {
            "id": f"co-{i}",
            "tool_id": tools[c.tool_index]["id"],
            "holder_id": f"person-{c.holder}",
            "issued_by": f"person-{c.issued_by}",
            "checked_out_at": c.checked_out_at,
            "due_back_at": c.due_back_at,
            "returned_at": c.returned_at,
            "planted": c.planted,
            "true_p_late": c.true_p_late,
        }
        for i, c in enumerate(checkouts)
    ]
    co = pd.DataFrame(rows)
    for col in ("checked_out_at", "due_back_at", "returned_at"):
        co[col] = pd.to_datetime(co[col], utc=True)
    tl = pd.DataFrame([{"id": t["id"], "asset_tag": t["asset_tag"], "category": t["category"]} for t in tools])
    return Frames(checkouts=co, tools=tl)
