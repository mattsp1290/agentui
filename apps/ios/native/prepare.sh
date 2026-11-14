#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
node ../../../scripts/check-toolchain.mjs
[[ "$(pod --version)" == 1.16.2 ]] || { echo 'Use CocoaPods 1.16.2.' >&2; exit 1; }
mkdir -p .work
rm -f .work/prepared-inputs.sha256
npm ci --no-audit --no-fund
node normalize-hermes.cjs
cp ios/Podfile.lock ios/Podfile.lock.expected
trap 'rm -f ios/Podfile.lock.expected' EXIT
(cd ios && pod install --deployment)
diff -u ios/Podfile.lock.expected ios/Podfile.lock >&2 || {
  echo 'Podfile.lock changed during preparation.' >&2; exit 1;
}
shasum -a 256 package.json package-lock.json ../package.json ios/Podfile ios/Podfile.lock \
  normalize-hermes.cjs > .work/prepared-inputs.sha256.tmp
mv .work/prepared-inputs.sha256.tmp .work/prepared-inputs.sha256
