#!/bin/bash
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "$(dirname "$0")/common.sh"
simulator="$(require_simulator "$@")"
cd "$ios_native_root"
node ../../../scripts/check-toolchain.mjs
if lsof -nP -iTCP:8081 -sTCP:LISTEN > /dev/null; then
  echo 'Stop the Metro server on port 8081 before offline verification.' >&2; exit 1
fi
[[ -s "$ios_product/main.jsbundle" ]] || { echo 'Run ios:run first.' >&2; exit 1; }
ios_source_snapshot | cmp -s - .work/build-source.txt || {
  echo 'Source changed since ios:run; rebuild before verifying.' >&2; exit 1;
}
bundle_id="$(ios_bundle_id)"
evidence="$PWD/.work/evidence"
mkdir -p "$evidence"
cp .work/build-source.txt "$evidence/build-source.txt"
installed="$(xcrun simctl get_app_container "$simulator" "$bundle_id" app)"
cmp "$ios_product/main.jsbundle" "$installed/main.jsbundle"
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
{
  git rev-parse HEAD
  git status --porcelain
  xcrun simctl list devices | grep -F "$simulator"
  xcrun simctl list runtimes
  sw_vers
  xcodebuild -version
  node --version
  npm --version
  pod --version
} > "$evidence/toolchain.txt"
{
  if [[ -z "$(git status --porcelain --untracked-files=no)" ]]; then
    printf 'verification tracked tree clean\n'
  else
    printf 'verification tracked tree dirty\n'
  fi
  printf 'source snapshot\n'
  cat "$evidence/build-source.txt"
  printf 'preparation inputs\n'
  cat .work/prepared-inputs.sha256
  printf 'installed JavaScript bundle\n'
  cat "$evidence/bundle.sha256"
} > "$evidence/provenance.txt"
echo "Inspect $evidence/relaunch.png for the disconnected AgentUI screen."
