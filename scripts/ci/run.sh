#!/usr/bin/env bash
# Runs a command; if it fails, the last lines of its output become a GitHub
# annotation, so the reason is visible on the run page without opening logs.
# Usage: scripts/ci/run.sh "Title" command args...
set -uo pipefail
title="$1"; shift
log="$(mktemp)"
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ "$status" -ne 0 ]; then
  tail_text="$(grep -v '^::' "$log" | tail -n 25 | cut -c1-300)"
  tail_text="${tail_text//'%'/'%25'}"; tail_text="${tail_text//$'\r'/'%0D'}"; tail_text="${tail_text//$'\n'/'%0A'}"
  echo "::error title=${title//:/%3A} failed (exit $status)::${tail_text}"
fi
exit "$status"
