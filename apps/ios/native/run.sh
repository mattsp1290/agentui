#!/bin/bash
set -euo pipefail
# shellcheck source-path=SCRIPTDIR
# shellcheck source=common.sh
source "$(dirname "$0")/common.sh"
simulator="$(require_simulator "$@")"
cd "$ios_native_root"
ios_acquire_work_lock
trap ios_release_work_lock EXIT
printf '%s\n' "$$" > "$ios_work_lock/pid"
node ../../../scripts/check-toolchain.mjs
[[ -f .work/prepared-inputs.sha256 ]] || { echo 'Run ios:prepare first.' >&2; exit 1; }
shasum -a 256 -c .work/prepared-inputs.sha256 > /dev/null 2>&1 || {
  echo 'Preparation inputs changed; run ios:prepare.' >&2; exit 1;
}
mkdir -p .work
xcrun simctl bootstatus "$simulator" -b
export NODE_BINARY
NODE_BINARY="$(command -v node)"
printf 'export NODE_BINARY=%q\n' "$NODE_BINARY" > ios/.xcode.env.local
rm -f "$ios_product/main.jsbundle" .work/build-source.txt .work/build-prepared-inputs.sha256 .work/build-simulator.txt
cp .work/prepared-inputs.sha256 .work/build-prepared-inputs.pending
ios_source_snapshot > .work/build-source.pending
env -u SKIP_BUNDLING -u FORCE_BUNDLING -u ENTRY_FILE -u PROJECT_ROOT \
  -u BUNDLE_CONFIG -u BUNDLE_COMMAND -u CLI_PATH -u NODE_ARGS \
  -u CONFIG_JSON -u CONFIG_CMD -u BUNDLE_NAME -u EXTRA_PACKAGER_ARGS \
  -u EXTRA_COMPILER_ARGS -u COMPOSE_SOURCEMAP_PATH -u SOURCEMAP_FILE \
  -u HERMES_CLI_PATH -u USE_HERMES \
  xcodebuild -workspace ios/AgentUI.xcworkspace -scheme AgentUI -configuration Release \
  -sdk iphonesimulator -destination "id=$simulator" -derivedDataPath "$PWD/.work/build" \
  CODE_SIGNING_ALLOWED=NO build > .work/build.log 2>&1 || {
  tail -80 .work/build.log >&2; exit 1;
}
[[ -s "$ios_product/main.jsbundle" ]] || { echo 'Embedded Release bundle missing.' >&2; exit 1; }
ios_source_snapshot | cmp -s - .work/build-source.pending || {
  echo 'Source changed during build; run ios:run again.' >&2; exit 1;
}
cmp -s .work/prepared-inputs.sha256 .work/build-prepared-inputs.pending || {
  echo 'Preparation receipt changed during build; run ios:run again.' >&2; exit 1;
}
shasum -a 256 -c .work/build-prepared-inputs.pending > /dev/null 2>&1 || {
  echo 'Preparation inputs changed during build; run ios:prepare.' >&2; exit 1;
}
bundle_id="$(ios_bundle_id)"
xcrun simctl install "$simulator" "$ios_product"
xcrun simctl terminate "$simulator" "$bundle_id" 2>/dev/null || true
xcrun simctl launch "$simulator" "$bundle_id"
mv .work/build-source.pending .work/build-source.txt
mv .work/build-prepared-inputs.pending .work/build-prepared-inputs.sha256
printf '%s\n' "$simulator" > .work/build-simulator.txt
echo "Built and launched $bundle_id. Build log: $PWD/.work/build.log"
