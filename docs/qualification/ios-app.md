# Build and launch AgentUI on iOS Simulator

AgentUI packages its React Native shell in a local iOS Release app. It opens a disconnected screen and explains that pairing and conversations are unavailable. Packaging is tracked by `agentui-kq76`. Host pairing, credentials, reconnect, and conversation navigation remain in `agentui-3xme` and its prerequisites.

## Prepare your Mac

Install Xcode with an iOS Simulator runtime and select its developer directory. Install CocoaPods 1.16.2. Make Node.js and npm available.

Check the Apple tools and list available simulators:

```sh
xcodebuild -version
pod --version
xcrun simctl list devices available
```

Choose an available simulator UDID. The build targets that simulator and does not use a physical device.

## Build and launch the app

From the repository root, replace `SIMULATOR_UDID` with the chosen UDID:

```sh
./agentui-ios SIMULATOR_UDID
```

The launcher selects Node 24.22.3 and npm 11.19.1. It runs `npm ci` in `apps/ios/native`, then `pod install --deployment`. Preparation compares `Podfile.lock` before and after installation and fails on drift.

The build boots the selected simulator and compiles the shared `AgentUI` scheme in Release mode with signing disabled. It checks that `main.jsbundle` exists, installs the app, and launches `homes.birb.agentui`. Confirm that the screen says **AgentUI**, **Not connected**, and **This developer build**.

The app is `apps/ios/native/.work/build/Build/Products/Release-iphonesimulator/AgentUI.app`. The native build log is `apps/ios/native/.work/build.log`. Installation or build failures stop the launcher.

To run preparation and build separately, use the pinned Node and npm versions:

```sh
npm run ios:prepare
npm run ios:run -- SIMULATOR_UDID
```

The native package has its own JavaScript lockfile. Root `npm ci` and `npm run verify` do not install CocoaPods or build the iOS app.

## Check launch without Metro

Ensure that no Metro process listens on port 8081:

```sh
lsof -nP -iTCP:8081 -sTCP:LISTEN
```

No output means that the port has no listener. If a Metro process is running, stop that process before the check.

Terminate and relaunch the installed app:

```sh
xcrun simctl terminate SIMULATOR_UDID homes.birb.agentui
xcrun simctl launch SIMULATOR_UDID homes.birb.agentui
```

Confirm that the same disconnected screen returns. Capture the screen for the qualification record:

```sh
xcrun simctl io SIMULATOR_UDID screenshot /tmp/agentui-ios-relaunch.png
```

Record the source revision, tool versions, simulator identity, build result, and installed bundle hash with the screenshot. A successful TypeScript check or native compilation alone does not prove that the screen rendered.

## Packaging boundaries

The committed native project is a pruned React Native Community 0.86.0 template. React is 19.3.1 and the Community CLI is 20.2.0. The project loads `apps/ios/src/shell/App.tsx` through `apps/ios/native/index.js`. Metro resolves dependencies from the isolated native package.

Release loads `main.jsbundle` from the application bundle. Changes to the shell require another build and installation. The independent [iOS update probe](ios-updates.md) records the earlier rebuild strategy qualification.

This slice covers an iOS Simulator app. Physical-device provisioning, signing, installation, distribution, VoiceOver, and live customization updates are not qualified. The app has no host connection or credential storage. Pairing, reconnect, pending decisions, and shared conversations require their own acceptance checks. The current mobile plan targets iOS and does not define an Android package.

## Reproduce the offline check

After `ios:run`, use the pinned toolchain to run:

```sh
npm run ios:verify -- SIMULATOR_UDID
```

The check rejects a listener on port 8081, compares the installed embedded bundle with the build product, and relaunches the app. It records the process, bundle hash, tool versions, and screenshot under `apps/ios/native/.work/evidence`. Inspect the screenshot to confirm the disconnected screen rendered.

Preparation normalizes React Native 0.86.0's Hermes compiler path to `${PODS_ROOT}/../../node_modules/hermes-compiler/hermesc/osx-bin/hermesc`. The upstream podspec uses an absolute checkout path in `HERMES_CLI_PATH`, which otherwise changes its CocoaPods checksum across checkout locations. `normalize-hermes.cjs` checks the expected upstream expression before changing it. Review that normalization when upgrading React Native. Native dependency versions remain locked.

The qualification below records Xcode and simulator versions rather than enforcing them on other Macs. Prebuilt React Native and Hermes artifacts use their upstream versioned downloads and upstream integrity checks. This package does not provide an independent SHA-256 allowlist for those downloads. The Podfile clears native build overrides inherited from the invoking environment before resolving dependencies. `ios:run` regenerates the local Node path for each build.
