# iOS rebuild probe

This standalone generated app qualifies the rebuild workflow, independent of `apps/ios`.
See [the qualification record](../../docs/qualification/ios-updates.md) for results and limits.

Use macOS with Xcode selected, a compatible iOS simulator runtime, CocoaPods 1.16.2,
Node 24.22.3, and npm 11.19.1 on PATH. No Expo, signing credentials, Metro server,
or hosted update service is required for the simulator workflow.

From the repository root:

```sh
bash spikes/ios-updates/prepare.sh
xcrun simctl create 'AgentUI update qualification' \
  com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro \
  com.apple.CoreSimulator.SimRuntime.iOS-26-3
# Set PROBE_SIMULATOR to the returned UUID.
export PROBE_SIMULATOR='<returned UUID>'
xcrun simctl boot "$PROBE_SIMULATOR"
xcrun simctl bootstatus "$PROBE_SIMULATOR" -b
bash spikes/ios-updates/rebuild.sh A "$PROBE_SIMULATOR"
```

Inspect the simulator for `AgentUI update probe A`. Save a screenshot with the
command printed by `rebuild.sh`. A successful build or launch command alone does
not prove the screen rendered. All generated files live in ignored `spikes/ios-updates/.work/`.

Edit `spikes/ios-updates/.work/app/index.js` to display B. Terminate and relaunch the installed app:

```sh
bash spikes/ios-updates/restart.sh no-rebuild "$PROBE_SIMULATOR"
```

Expect A. Local source edits do not replace the installed Release bundle.
Change only `index.js` between these phases; rerun preparation if dependencies change.
Keep the app running before each restart command. The command fails if no process can be terminated.
Now run:

```sh
bash spikes/ios-updates/rebuild.sh B "$PROBE_SIMULATOR"
```

Expect B. Run `bash spikes/ios-updates/restart.sh B "$PROBE_SIMULATOR"` and expect B again. There should be no
listener on port 8081 (`lsof -nP -iTCP:8081 -sTCP:LISTEN`). That check plus the
Release bundle URL in generated `spikes/ios-updates/.work/app/ios/AgentUIUpdateProbe/AppDelegate.swift`
confirms this workflow does not depend on a running Metro server.

`prepare.sh` generates the MIT-licensed React Native Community template 0.86.0
with CLI 20.2.0, then installs the committed npm and CocoaPods locks. `pod install --deployment` and a lock comparison fail on native dependency drift.
The script uses global CocoaPods 1.16.2, not the generated template Gemfile.
The CLI version is fixed, but its bootstrap dependency resolution is not locked.
Generated native project checksums are retained with the evidence. It can run
again after a completed preparation. For a fresh preparation, move `spikes/ios-updates/.work/app`
to a backup directory and run it again. The npm lock and Podfile lock are generated
dependency records, excluded from the implementation line budget. Application
code and native template output stay in `spikes/ios-updates/.work/`.

For a physical device, open `spikes/ios-updates/.work/app/ios/AgentUIUpdateProbe.xcworkspace`, select
your own development team and connected device, set the scheme Run configuration
to Release, then build and run from Xcode. Repeat for B and restart without Metro.
This route needs your signing setup and Developer Mode on the device. It was not
executed in this qualification. Simulator `CODE_SIGNING_ALLOWED=NO` commands do
not qualify signing or physical-device installation.

The qualification used an isolated Node installation created with
`npm install --prefix /tmp/agentui-ios-tools node@24.22.3 npm@11.19.1`, then prepended
`/tmp/agentui-ios-tools/node_modules/.bin` to PATH. Any installation manager that
provides the exact required versions works.

The retained deployment-mode preparation used an already generated tree at one
checkout path on one Mac. Fresh generation with the current deployment-mode
script has not been separately qualified. The historical clean-preparation log
predates that enforcement. Codegen podspec checksum stability across checkout
paths is untested.
