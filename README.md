# AgentUI

AgentUI is a conversation client for existing agent installations, with React customization for Tauri desktop and a separate React Native iOS client.

The macOS desktop package launches a Tauri shell with a disconnected landing page and built-in recovery controls. The iOS package builds a React Native app with a disconnected landing screen. A separate browser development entry connects the desktop shell to a persistent recorded host. Native host connections remain separate work.

Use Node 24.22.3 and npm 11.19.1.

```sh
npm ci
npm run setup:browser
npm run verify
```

Build before running standalone `npm run check` or `npm test`. Consumers resolve emitted package exports in dependency order.

Read [architecture boundaries](docs/architecture/boundaries.md), [Apple qualification](docs/architecture/apple-qualification.md), and [Switchboard artifact provenance](vendor/README.md).
The [AG-UI conformance matrix](docs/protocol/README.md) separates canonical wire coverage, installed projection fixtures and pending product qualification.

Linux CI runs the same package checks and browser fixtures with the pinned toolchain.
Apple application builds remain separate.

Read [recorded host development](docs/development/recorded-host.md) to run paired browser views against the independent host process.

Read the [default theme and primitives](docs/design/theme.md) and [T3 Code design findings](docs/design/t3-code.md).
Run `npm run preview:theme` after building to inspect the local visual fixture.

## Launch the desktop app

On macOS, install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and make Node.js and npm available. From the repository root, run:

```sh
./agentui
```

The launcher selects the pinned Node and npm versions, installs locked dependencies, builds the macOS bundle, and opens a fresh app instance. A failed install or build stops the launch. You can also invoke the script by its absolute path from another directory.

For development with a live server, use the pinned toolchain and run:

```sh
npm ci
npm run desktop:dev
```

The bundle loads embedded assets without a development server. This is a local build, without distribution signing or notarization. Read the [desktop packaging guide](docs/qualification/desktop-macos.md) for checks and limitations.

## Launch the iOS app

On macOS, install Xcode with an iOS Simulator runtime and CocoaPods 1.16.2. Make Node.js and npm available. List available simulators:

```sh
xcrun simctl list devices available
```

From the repository root, pass a simulator UDID to the launcher:

```sh
./agentui-ios SIMULATOR_UDID
```

The launcher selects Node 24.22.3 and npm 11.19.1, installs locked JavaScript and native dependencies, and builds a Release app. It boots the selected simulator, installs AgentUI, and launches the disconnected screen. The app uses an embedded bundle without a Metro development server.

Read the [iOS packaging guide](docs/qualification/ios-app.md) for preparation commands, relaunch checks, and qualification limits. Physical-device signing and distribution remain separate work.
