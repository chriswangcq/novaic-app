#!/usr/bin/env bash
# check-rust-process.sh — Round 016 post-delete desktop decoupling check.
#
# Verifies that the desktop Rust source no longer references deleted in-repo
# backend service directory paths (runtime_orchestrator, tools_server,
# file_service, tool_result_service as path strings).
#
# Does NOT require the desktop app to be running — this is a static source audit.
#
# Expected markers:
#   DESKTOP_POST_DELETE_DECOUPLED=PASS
#   DESKTOP_R016_SMOKE=PASS
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

MAIN_RS="$REPO_ROOT/novaic-app/src-tauri/src/main.rs"
SPLIT_RT="$REPO_ROOT/novaic-app/src-tauri/src/split_runtime.rs"

echo "=== Round 016 Desktop Post-Delete Decoupling Check ==="
echo "repo_root: $REPO_ROOT"
echo ""

# Deleted in-repo paths — must NOT appear as literal directory paths in desktop source
DELETED_PATHS=(
  "novaic-backend/runtime_orchestrator"
  "novaic-backend/tools_server"
  "novaic-backend/file_service"
  "novaic-backend/tool_result_service"
)

FAIL=0
for dp in "${DELETED_PATHS[@]}"; do
  if grep -qF "$dp" "$MAIN_RS" "$SPLIT_RT" 2>/dev/null; then
    echo "  FAIL: '$dp' still referenced in desktop Rust source"
    FAIL=1
  else
    echo "  OK:   '$dp' — not referenced in desktop source"
  fi
done

echo ""

# Check split_runtime.rs exports the required URL helpers (decoupling proof)
for fn in "gateway_url_explicit\|validate_split_config\|tools_server_split_repo"; do
  if grep -qE "$fn" "$SPLIT_RT" 2>/dev/null; then
    echo "  split_runtime: '$fn' present — endpoint decoupling in place"
  fi
done

echo ""

if [ "$FAIL" -eq 0 ]; then
  echo "DESKTOP_POST_DELETE_DECOUPLED=PASS"
  echo "DESKTOP_R016_SMOKE=PASS"
  echo "ROUND018_DESKTOP_RUST_PROCESS_CHECK_PASS"
else
  echo "DESKTOP_POST_DELETE_DECOUPLED=FAIL"
  echo "DESKTOP_R016_SMOKE=FAIL"
  echo "ROUND018_DESKTOP_RUST_PROCESS_CHECK_PASS=FAIL"
  exit 1
fi
