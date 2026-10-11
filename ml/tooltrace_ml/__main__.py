"""
Command line:

    python -m tooltrace_ml run                   # nightly job: train, score, flag
    python -m tooltrace_ml seed-history [--open] # demo/test databases only

Reads DATABASE_URL from the environment.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import psycopg


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="tooltrace_ml", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run", help="train the models, score open check-outs and flag unusual ones")
    run.add_argument("--seed", type=int, default=0)
    hist = sub.add_parser("seed-history", help="import a year of synthetic history (demo and test only)")
    hist.add_argument("--days", type=int, default=365)
    hist.add_argument("--seed", type=int, default=7)
    hist.add_argument("--open", action="store_true", help="also leave a few tools checked out right now")
    args = parser.parse_args(argv)

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    with psycopg.connect(url, autocommit=True, application_name="tooltrace-ml") as conn:
        if args.command == "run":
            from .job import run as run_job

            result = run_job(conn, seed=args.seed)
            late = result["metrics"]["late"]
            auc = late.get("test", {}).get("rocAuc")
            print(
                f"[ml] run {result['runId']}: {result['version']}, trained on {result['trained_on']} check-outs, "
                f"late-risk test ROC AUC {auc}, scored {result['scored']} open, flagged {result['flagged']} new"
            )
        else:
            from .history import seed_history

            summary = seed_history(conn, days=args.days, seed=args.seed, with_open=args.open)
            print("[ml] " + json.dumps(summary, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
