#!/usr/bin/env bash
set -euo pipefail

# Round-007 desktop operability validation:
# Run bundled app with a fresh HOME profile and verify startup diagnostics.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_BUNDLE_DEFAULT="$ROOT_DIR/novaic-app/src-tauri/target/release/bundle/macos/NovAIC.app"
APP_BUNDLE="${1:-$APP_BUNDLE_DEFAULT}"
WAIT_SECONDS="${WAIT_SECONDS:-75}"

if [[ -z "${ROUND_DIR:-}" ]]; then
  LATEST_ROUND_DIR="$(ls -d "$ROOT_DIR"/ops-rounds/round-* 2>/dev/null | sort -V | tail -n 1 || true)"
  ROUND_DIR="${LATEST_ROUND_DIR:-$ROOT_DIR/ops-rounds/round-008}"
fi

EVIDENCE_DIR="${EVIDENCE_DIR:-$ROUND_DIR/20-reports/desktop-evidence}"
RUN_LABEL="${RUN_LABEL:-default}"
OPERATOR_ID="${OPERATOR_ID:-operator-unknown}"

if [[ ! -d "$APP_BUNDLE" ]]; then
  echo "ERROR: app bundle not found: $APP_BUNDLE"
  exit 1
fi

mkdir -p "$EVIDENCE_DIR"

for port in 19993 19994 19995 19996 19997 19998 19999; do
  lsof -ti ":${port}" | xargs kill -9 2>/dev/null || true
done

CLEAN_HOME="$(mktemp -d /tmp/novaic-fresh-home.XXXXXX)"
STARTUP_LOG="$CLEAN_HOME/startup.log"
DIAG_PATH="$CLEAN_HOME/Library/Application Support/com.novaic.app/logs/startup-diagnostics.jsonl"

echo "Using app bundle: $APP_BUNDLE"
echo "Using fresh HOME: $CLEAN_HOME"

HOME="$CLEAN_HOME" "$APP_BUNDLE/Contents/MacOS/novaic" >"$STARTUP_LOG" 2>&1 &
APP_PID=$!

sleep "$WAIT_SECONDS"
kill "$APP_PID" 2>/dev/null || true
sleep 2

if [[ ! -f "$DIAG_PATH" ]]; then
  echo "ERROR: startup diagnostics not found: $DIAG_PATH"
  exit 2
fi

export DIAG_PATH
SUMMARY_TXT="$EVIDENCE_DIR/fresh-profile-${RUN_LABEL}-summary.txt"
ERROR_TIMEOUT_COUNT="$(
SUMMARY_TXT_PATH="$SUMMARY_TXT" python3 - <<'PY'
import json
import os

diag_path = os.environ["DIAG_PATH"]
events = []
with open(diag_path, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if line:
            events.append(json.loads(line))

statuses = [e.get("status", "") for e in events]
stages = [e.get("stage", "") for e in events]
error_timeout = [s for s in statuses if s in ("error", "timeout")]

print(len(error_timeout))
with open(os.environ.get("SUMMARY_TXT_PATH"), "w", encoding="utf-8") as out:
    out.write(f"event_count={len(events)}\n")
    out.write(f"error_timeout_count={len(error_timeout)}\n")
    out.write("stages=" + ",".join(stages) + "\n")
    out.write("last_events:\n")
    for evt in events[-5:]:
        out.write(json.dumps(evt, ensure_ascii=True) + "\n")
PY
)"

cp "$STARTUP_LOG" "$EVIDENCE_DIR/fresh-profile-${RUN_LABEL}-startup.log"
cp "$DIAG_PATH" "$EVIDENCE_DIR/fresh-profile-${RUN_LABEL}-startup-diagnostics.jsonl"

METADATA_PATH="$EVIDENCE_DIR/fresh-profile-${RUN_LABEL}-metadata.txt"
{
  echo "run_label=$RUN_LABEL"
  echo "operator_id=$OPERATOR_ID"
  echo "app_bundle=$APP_BUNDLE"
  echo "wait_seconds=$WAIT_SECONDS"
  echo "clean_home=$CLEAN_HOME"
  echo "timestamp_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$METADATA_PATH"

for port in 19993 19994 19995 19996 19997 19998 19999; do
  lsof -ti ":${port}" | xargs kill -9 2>/dev/null || true
done

echo "Validation summary:"
cat "$SUMMARY_TXT"
echo "evidence_dir=$EVIDENCE_DIR"
echo "clean_home=$CLEAN_HOME"
echo "run_label=$RUN_LABEL"
echo "operator_id=$OPERATOR_ID"

if [[ "$ERROR_TIMEOUT_COUNT" != "0" ]]; then
  echo "ERROR: startup diagnostics includes error/timeout events"
  exit 3
fi
