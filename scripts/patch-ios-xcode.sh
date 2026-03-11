#!/usr/bin/env bash
# 修复 Xcode 构建脚本：Build Rust Code 需在 novaic-app 目录执行 npm
set -e
cd "$(dirname "$0")/.."
GEN=src-tauri/gen/apple
[ ! -d "$GEN" ] && exit 0

# FORCE_COLOR 修复
sed -i '' 's/\${FORCE_COLOR} //g' "$GEN/project.yml" 2>/dev/null || true
sed -i '' 's/} 0 \${/} \${/g' "$GEN/novaic.xcodeproj/project.pbxproj" 2>/dev/null || true

# Build Rust Code 使用 wrapper 脚本（用 $0 定位项目根，不依赖 SRCROOT）
if ! grep -q 'run-ios-xcode-script.sh' "$GEN/project.yml" 2>/dev/null; then
  sed -i '' 's|script: npm run -- tauri ios xcode-script -v|script: "\"$(SRCROOT)/../../../scripts/run-ios-xcode-script.sh\" -v|' "$GEN/project.yml"
fi
if ! grep -q 'run-ios-xcode-script.sh' "$GEN/novaic.xcodeproj/project.pbxproj" 2>/dev/null; then
  sed -i '' 's|shellScript = "cd \\"$(SRCROOT)/../../..\\" \&\& npm run -- tauri ios xcode-script -v|shellScript = "\"${SRCROOT}/../../../scripts/run-ios-xcode-script.sh\" -v|' "$GEN/novaic.xcodeproj/project.pbxproj"
  sed -i '' 's|shellScript = "npm run -- tauri ios xcode-script -v|shellScript = "\"${SRCROOT}/../../../scripts/run-ios-xcode-script.sh\" -v|' "$GEN/novaic.xcodeproj/project.pbxproj"
fi

# ATS：允许 ws://127.0.0.1（VncProxy WebSocket），否则 iOS 会阻止连接
PLIST="$GEN/novaic_iOS/Info.plist"
if [ -f "$PLIST" ] && ! grep -q 'NSAppTransportSecurity' "$PLIST" 2>/dev/null; then
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity dict" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSAppTransportSecurity:NSAllowsLocalNetworking bool true" "$PLIST" 2>/dev/null || true
fi
