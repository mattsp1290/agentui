#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=common.sh
source ./common.sh
ios_acquire_work_lock
trap ios_release_work_lock EXIT
printf '%s\n' "$$" > "$ios_work_lock/pid"
node ../../../scripts/check-toolchain.mjs
[[ "$(pod --version)" == 1.16.2 ]] || { echo 'Use CocoaPods 1.16.2.' >&2; exit 1; }
mkdir -p .work
rm -f .work/prepared-inputs.sha256
npm --prefix ../../.. ci --no-audit --no-fund
npm --prefix ../../.. run build --workspace=@agentui/theme --workspace=@agentui/ui-primitives
npm ci --no-audit --no-fund
node normalize-hermes.cjs
cp ios/Podfile.lock ios/Podfile.lock.expected
trap 'if [[ "$ios_interrupted" == 0 ]]; then rm -f ios/Podfile.lock.expected; fi; ios_release_work_lock' EXIT
(cd ios && pod install --deployment)
diff -u ios/Podfile.lock.expected ios/Podfile.lock >&2 || {
  cp ios/Podfile.lock.expected ios/Podfile.lock
  echo 'Podfile.lock changed during preparation.' >&2; exit 1;
}
shasum -a 256 package.json package-lock.json ../package.json ios/Podfile ios/Podfile.lock \
  normalize-hermes.cjs metro.config.cjs ../../../package.json ../../../package-lock.json ../../../.node-version \
  ../../../tsconfig.base.json ../../../packages/{theme,ui-primitives}/{package.json,tsconfig*.json,src/*,dist/*.js} \
  > .work/prepared-inputs.sha256.tmp
mv .work/prepared-inputs.sha256.tmp .work/prepared-inputs.sha256
