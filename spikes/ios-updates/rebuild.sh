#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
revision="${1:?Usage: rebuild.sh A-or-B simulator-UDID}"
simulator="${2:?Supply the dedicated simulator UDID}"
[[ "$revision" == A || "$revision" == B ]] || { echo 'Choose A or B.' >&2; exit 1; }
[[ "$(node --version)" == v24.22.3 && "$(npm --version)" == 11.19.1 ]] || {
  echo 'Use Node 24.22.3 and npm 11.19.1.' >&2; exit 1;
}
xcrun simctl list devices booted | grep -Fq "$simulator" || { echo 'Boot the simulator first.' >&2; exit 1; }
app="$PWD/.work/app"
[[ -d "$app/ios/AgentUIUpdateProbe.xcworkspace" ]] || { echo 'Run prepare.sh first.' >&2; exit 1; }
mkdir -p .work/evidence
# The unquoted heredoc deliberately substitutes the validated A/B revision.
cat > "$app/index.js" <<JS
import React from 'react';
import {AppRegistry, Text, View} from 'react-native';
function Probe() {
  return React.createElement(View, {style: {flex: 1, justifyContent: 'center', padding: 32}},
    React.createElement(Text, {style: {fontSize: 28, color: '#111111'}}, 'AgentUI update probe $revision'),
    React.createElement(Text, {style: {fontSize: 18, color: '#111111'}}, 'Embedded bundle. Rebuild required.'));
}
AppRegistry.registerComponent('AgentUIUpdateProbe', () => Probe);
JS
# Release embeds its bundle and never uses a development Metro server.
export NODE_BINARY="$(command -v node)"
printf 'export NODE_BINARY="%s"\n' "$NODE_BINARY" > "$app/ios/.xcode.env.local"
{ git rev-parse HEAD; xcodebuild -version; } > ".work/evidence/build-$revision.log"
xcodebuild -workspace "$app/ios/AgentUIUpdateProbe.xcworkspace" \
  -scheme AgentUIUpdateProbe -configuration Release \
  -sdk iphonesimulator -destination "id=$simulator" \
  -derivedDataPath "$PWD/.work/build" CODE_SIGNING_ALLOWED=NO build \
  >> ".work/evidence/build-$revision.log" 2>&1
product="$PWD/.work/build/Build/Products/Release-iphonesimulator/AgentUIUpdateProbe.app"
grep -aq "AgentUI update probe $revision" "$product/main.jsbundle" || { echo 'Embedded revision missing.' >&2; exit 1; }
bundle_id=$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$product/Info.plist")
xcrun simctl install "$simulator" "$product"
xcrun simctl terminate "$simulator" "$bundle_id" 2>/dev/null || true
xcrun simctl launch "$simulator" "$bundle_id"
installed="$(xcrun simctl get_app_container "$simulator" "$bundle_id" app)"
(cd "$installed" && shasum -a 256 main.jsbundle) > ".work/evidence/bundle-$revision.sha256"
echo "Installed $revision. Inspect the screen, then run:"
echo "xcrun simctl io $simulator screenshot $PWD/.work/evidence/$revision.png"
