#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
label="${1:?Usage: restart.sh no-rebuild-or-B simulator-UDID}"
simulator="${2:?Supply the dedicated simulator UDID}"
[[ "$label" == no-rebuild || "$label" == B ]] || { echo 'Choose no-rebuild or B.' >&2; exit 1; }
bundle_id=org.reactjs.native.example.AgentUIUpdateProbe
mkdir -p .work/evidence
{
  echo "Source SHA: $(git rev-parse HEAD)"
  echo "Source label: $(grep -o 'update probe [AB]' .work/app/index.js)"
  installed="$(xcrun simctl get_app_container "$simulator" "$bundle_id" app)"
  echo 'Installed bundle:'
  (cd "$installed" && shasum -a 256 main.jsbundle)
  echo 'Checking Metro port 8081:'
  if lsof -nP -iTCP:8081 -sTCP:LISTEN; then
    echo 'A listener exists. Cannot claim a restart without Metro.' >&2; exit 1
  else
    status=$?
    [[ "$status" == 1 ]] || exit "$status"
    echo 'lsof exit 1: no listener'
  fi
  xcrun simctl terminate "$simulator" "$bundle_id"
  xcrun simctl launch "$simulator" "$bundle_id"
} 2>&1 | tee ".work/evidence/restart-$label.txt"
echo "Inspect the screen, then capture .work/evidence/$label.png using simctl io screenshot."
