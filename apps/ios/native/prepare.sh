#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
node ../../../scripts/check-toolchain.mjs
[[ "$(pod --version)" == 1.16.2 ]] || { echo 'Use CocoaPods 1.16.2.' >&2; exit 1; }
npm ci --no-audit --no-fund
node normalize-hermes.cjs
cp ios/Podfile.lock ios/Podfile.lock.expected
trap 'rm -f ios/Podfile.lock.expected' EXIT
(cd ios && pod install --deployment)
cmp ios/Podfile.lock.expected ios/Podfile.lock
