#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
node ../../../scripts/check-toolchain.mjs
simulator="${1:?Usage: verify.sh simulator-UDID}"
[[ "$simulator" =~ ^[0-9A-Fa-f-]{36}$ ]] || { echo 'Supply a simulator UDID.' >&2; exit 1; }
if lsof -nP -iTCP:8081 -sTCP:LISTEN > /dev/null; then
  echo 'Stop the Metro server on port 8081 before offline verification.' >&2; exit 1
fi
product="$PWD/.work/build/Build/Products/Release-iphonesimulator/AgentUI.app"
[[ -s "$product/main.jsbundle" ]] || { echo 'Run ios:run first.' >&2; exit 1; }
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$product/Info.plist")
evidence="$PWD/.work/evidence"
mkdir -p "$evidence"
installed="$(xcrun simctl get_app_container "$simulator" "$bundle_id" app)"
cmp "$product/main.jsbundle" "$installed/main.jsbundle"
(cd "$installed" && shasum -a 256 main.jsbundle) > "$evidence/bundle.sha256"
xcrun simctl terminate "$simulator" "$bundle_id" 2>/dev/null || true
xcrun simctl launch "$simulator" "$bundle_id" > "$evidence/relaunch.txt"
launched_pid=$(awk -F': ' '{print $2}' "$evidence/relaunch.txt")
sleep 3
xcrun simctl spawn "$simulator" launchctl list > "$evidence/processes.txt"
awk -v pid="$launched_pid" -v app="$bundle_id" \
  '$1 == pid && index($3, "UIKitApplication:" app "[") { found=1 } END { exit !found }' \
  "$evidence/processes.txt" || { echo 'App exited after launch.' >&2; exit 1; }
xcrun simctl io "$simulator" screenshot "$evidence/relaunch.png"
{ git rev-parse HEAD; git status --porcelain; xcrun simctl list devices | grep -F "$simulator"; xcrun simctl list runtimes; sw_vers; xcodebuild -version; node --version; npm --version; pod --version; } > "$evidence/toolchain.txt"
echo "Inspect $evidence/relaunch.png for the disconnected AgentUI screen."
