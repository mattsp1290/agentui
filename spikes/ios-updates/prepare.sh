#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
[[ "$(node --version)" == v24.22.3 && "$(npm --version)" == 11.19.1 ]] || {
  echo 'Use Node 24.22.3 and npm 11.19.1.' >&2; exit 1;
}
[[ "$(pod --version)" == 1.16.2 ]] || { echo 'Use CocoaPods 1.16.2.' >&2; exit 1; }
mkdir -p .work
if [[ ! -d .work/app ]]; then
  npx --yes @react-native-community/cli@20.2.0 init AgentUIUpdateProbe \
    --version 0.86.0 --skip-install --skip-git-init --directory "$PWD/.work/app"
fi
# The probe replaces the template app dependencies with its minimal locked set.
cp package.json package-lock.json .work/app/
(cd .work/app && npm ci --no-audit --no-fund)
# Require the committed native lock and fail on drift.
cp Podfile.lock .work/app/ios/
(cd .work/app/ios && pod install --deployment)
cmp Podfile.lock .work/app/ios/Podfile.lock
