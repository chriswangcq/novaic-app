#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROUND_DIR="${1:-$ROOT_DIR/ops-rounds/round-009}"
BUNDLE_DIR="$ROUND_DIR/20-reports/desktop-evidence-bundle"

if [[ ! -d "$BUNDLE_DIR" ]]; then
  echo "ERROR: bundle directory missing: $BUNDLE_DIR"
  exit 1
fi

MANIFEST_PATH="$(ls -t "$BUNDLE_DIR"/*-manifest.txt 2>/dev/null | head -n 1 || true)"
if [[ -z "$MANIFEST_PATH" ]]; then
  echo "ERROR: no manifest found in $BUNDLE_DIR"
  exit 1
fi

required_markers=(
  "bundle_archive="
  "sha256:"
  "validate_fresh_profile.sh"
  "team-desktop-report.md"
  "desktop-ci-qa-handoff-round009.md"
  "desktop-clean-profile-replay-round009.md"
  "NovAIC_0.3.0_aarch64.dmg"
)

for marker in "${required_markers[@]}"; do
  if ! grep -Fq "$marker" "$MANIFEST_PATH"; then
    echo "ERROR: manifest missing required marker: $marker"
    echo "manifest=$MANIFEST_PATH"
    exit 2
  fi
done

echo "manifest=$MANIFEST_PATH"
echo "manifest_completeness=PASS"
