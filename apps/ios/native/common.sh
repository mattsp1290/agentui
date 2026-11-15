#!/bin/bash

ios_native_root="$(CDPATH='' cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly ios_native_root
readonly ios_product="$ios_native_root/.work/build/Build/Products/Release-iphonesimulator/AgentUI.app"

ios_acquire_work_lock() {
  mkdir -p .work
  ios_work_lock="$PWD/.work/evidence.lock"
  if ! mkdir "$ios_work_lock" 2>/dev/null; then
    echo 'Another preparation, build, or verification may be running. If none is running, remove .work/evidence.lock and retry.' >&2; return 1
  fi
  ios_interrupted=0
  trap 'ios_interrupted=1; exit 129' HUP
  trap 'ios_interrupted=1; exit 130' INT
  trap 'ios_interrupted=1; exit 143' TERM
}

ios_release_work_lock() {
  if [[ "$ios_interrupted" == 0 ]]; then rm -rf "$ios_work_lock"; fi
}

require_simulator() {
  [[ $# -eq 1 && "$1" =~ ^[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$ ]] || {
    echo 'Supply one simulator UDID.' >&2; return 1;
  }
  printf '%s\n' "$1" | tr 'a-f' 'A-F'
}

ios_bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$ios_product/Info.plist"
}

ios_bundle_executable() {
  /usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$ios_product/Info.plist"
}

ios_source_snapshot() (
  set -o pipefail
  cd "$ios_native_root/../../.." || exit 1
  local paths=(apps/ios packages/theme packages/ui-primitives package.json package-lock.json
    tsconfig.base.json .node-version scripts/check-toolchain.mjs agentui-ios)
  local untracked
  untracked="$(mktemp)" || exit 1
  trap 'rm -f "$untracked"' EXIT
  git rev-parse HEAD || exit 1
  git diff --no-ext-diff --no-textconv --no-color HEAD --binary -- "${paths[@]}" | shasum -a 256 || exit 1
  git -c core.excludesFile=/dev/null ls-files --others --exclude-standard -z -- "${paths[@]}" > "$untracked" || exit 1
  while IFS= read -r -d '' file; do
    shasum -a 256 "$file" || exit 1
  done < "$untracked"
)
