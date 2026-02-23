#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -n "${1:-}" ]]; then
  ROUND_DIR="$1"
elif [[ -n "${ROUND_DIR:-}" ]]; then
  ROUND_DIR="$ROUND_DIR"
else
  LATEST_ROUND_DIR="$(ls -d "$ROOT_DIR"/ops-rounds/round-* 2>/dev/null | sort -V | tail -n 1 || true)"
  ROUND_DIR="${LATEST_ROUND_DIR:-$ROOT_DIR/ops-rounds/round-008}"
fi

REPORT_DIR="$ROUND_DIR/20-reports"
EVIDENCE_DIR="$REPORT_DIR/desktop-evidence"
OUT_DIR="$REPORT_DIR/desktop-evidence-bundle"
ROUND_BASENAME="$(basename "$ROUND_DIR")"
ROUND_SUFFIX="${ROUND_BASENAME/round-/round}"
HANDOFF_DOC="$REPORT_DIR/desktop-ci-qa-handoff-${ROUND_SUFFIX}.md"
REPLAY_DOC="$REPORT_DIR/desktop-clean-profile-replay-${ROUND_SUFFIX}.md"
TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BUNDLE_DIR="$OUT_DIR/release-evidence-$TIMESTAMP"
ARCHIVE_PATH="$OUT_DIR/release-evidence-$TIMESTAMP.tar.gz"
MANIFEST_PATH="$OUT_DIR/release-evidence-$TIMESTAMP-manifest.txt"

mkdir -p "$OUT_DIR"
mkdir -p "$BUNDLE_DIR"

required_files=(
  "$ROOT_DIR/novaic-app/src-tauri/target/release/bundle/macos/NovAIC.app"
  "$ROOT_DIR/novaic-app/src-tauri/target/release/bundle/dmg/NovAIC_0.3.0_aarch64.dmg"
  "$ROOT_DIR/novaic-app/scripts/validate_fresh_profile.sh"
  "$REPORT_DIR/team-desktop-report.md"
  "$HANDOFF_DOC"
  "$REPLAY_DOC"
)

for req in "${required_files[@]}"; do
  if [[ ! -e "$req" ]]; then
    echo "ERROR: missing required evidence file: $req"
    exit 1
  fi
done

if [[ ! -d "$EVIDENCE_DIR" ]]; then
  echo "ERROR: missing evidence directory: $EVIDENCE_DIR"
  exit 1
fi

cp -R "$EVIDENCE_DIR" "$BUNDLE_DIR/desktop-evidence"
cp "$REPORT_DIR/team-desktop-report.md" "$BUNDLE_DIR/"
cp "$HANDOFF_DOC" "$BUNDLE_DIR/"
cp "$REPLAY_DOC" "$BUNDLE_DIR/"
cp "$ROOT_DIR/novaic-app/scripts/validate_fresh_profile.sh" "$BUNDLE_DIR/"
cp "$ROOT_DIR/novaic-app/src-tauri/target/release/bundle/dmg/NovAIC_0.3.0_aarch64.dmg" "$BUNDLE_DIR/"

tar -czf "$ARCHIVE_PATH" -C "$OUT_DIR" "$(basename "$BUNDLE_DIR")"

{
  echo "bundle_timestamp_utc=$TIMESTAMP"
  echo "bundle_archive=$ARCHIVE_PATH"
  echo "included_dir=$BUNDLE_DIR"
  echo "sha256:"
  shasum -a 256 "$ARCHIVE_PATH"
  echo "files:"
  find "$BUNDLE_DIR" -type f | sed "s|$ROOT_DIR/||g" | sort
} > "$MANIFEST_PATH"

echo "bundle_archive=$ARCHIVE_PATH"
echo "manifest=$MANIFEST_PATH"
