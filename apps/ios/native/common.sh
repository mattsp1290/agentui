#!/bin/bash

ios_native_root="$(CDPATH='' cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ios_native_root
readonly ios_product="$ios_native_root/.work/build/Build/Products/Release-iphonesimulator/AgentUI.app"

require_simulator() {
  [[ $# -eq 1 && "$1" =~ ^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$ ]] || {
    echo 'Supply one simulator UDID.' >&2; return 1;
  }
  printf '%s\n' "$1" | tr 'a-f' 'A-F'
}

ios_bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$ios_product/Info.plist"
}

ios_source_snapshot() (
  cd "$ios_native_root/../../.." || exit 1
  local paths=(apps/ios packages/theme packages/ui-primitives package.json package-lock.json
    tsconfig.base.json .node-version scripts/check-toolchain.mjs agentui-ios)
  git rev-parse HEAD
  git diff HEAD --binary -- "${paths[@]}" | shasum -a 256
  while IFS= read -r -d '' file; do
    shasum -a 256 "$file"
  done < <(git ls-files --others --exclude-standard -z -- "${paths[@]}")
)
