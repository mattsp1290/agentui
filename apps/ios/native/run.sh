#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
node ../../../scripts/check-toolchain.mjs
simulator="${1:?Usage: run.sh simulator-UDID}"
[[ "$simulator" =~ ^[0-9A-Fa-f-]{36}$ ]] || { echo 'Supply a simulator UDID.' >&2; exit 1; }
[[ -d ios/AgentUI.xcworkspace ]] || { echo 'Run ios:prepare first.' >&2; exit 1; }
mkdir -p .work
if ! xcrun simctl list devices booted | grep -F "$simulator" > /dev/null; then
  xcrun simctl boot "$simulator"
fi
xcrun simctl bootstatus "$simulator" -b
export NODE_BINARY
NODE_BINARY="$(command -v node)"
printf 'export NODE_BINARY="%s"\n' "$NODE_BINARY" > ios/.xcode.env.local
xcodebuild -workspace ios/AgentUI.xcworkspace -scheme AgentUI -configuration Release \
  -sdk iphonesimulator -destination "id=$simulator" -derivedDataPath "$PWD/.work/build" \
  CODE_SIGNING_ALLOWED=NO build > .work/build.log 2>&1 || {
  tail -80 .work/build.log >&2; exit 1;
}
product="$PWD/.work/build/Build/Products/Release-iphonesimulator/AgentUI.app"
[[ -s "$product/main.jsbundle" ]] || { echo 'Embedded Release bundle missing.' >&2; exit 1; }
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$product/Info.plist")
xcrun simctl install "$simulator" "$product"
xcrun simctl terminate "$simulator" "$bundle_id" 2>/dev/null || true
xcrun simctl launch "$simulator" "$bundle_id"
echo "Built and launched $bundle_id. Build log: $PWD/.work/build.log"
