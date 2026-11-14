#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
[[ "$(node --version)" == v24.22.3 && "$(npm --version)" == 11.19.1 ]] || {
  echo 'Use Node 24.22.3 and npm 11.19.1.' >&2; exit 1;
}
mkdir -p .work
if [[ ! -d .work/app ]]; then
  npx --yes @react-native-community/cli@20.2.0 init AgentUIUpdateProbe \
    --version 0.86.0 --skip-install --skip-git-init --directory "$PWD/.work/app"
fi
cp package.json package-lock.json .work/app/
(cd .work/app && npm ci --no-audit --no-fund)
# Freeze native dependencies after the first measured pod resolution.
if [[ -f Podfile.lock ]]; then cp Podfile.lock .work/app/ios/; fi
(cd .work/app/ios && pod install)
