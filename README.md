# AgentUI

AgentUI is a conversation client for existing agent installations, with React customization for Tauri desktop and a separate React Native iOS client.

The macOS launcher starts the host and desktop client together. Run the host locally or on an SSH-accessible Mac or Linux machine. The launcher provisions the matching runtime, connects automatically, and opens the conversation UI without a pairing code or Keychain access. Read [launcher setup](docs/development/launcher.md) for local and remote workspaces. The separate iOS client still starts disconnected.

To choose among configured agents when creating a chat, read [agent choice setup](docs/development/agent-choice.md). Saved chats keep their original agent.

For GPT 6.1 Sol chat through your Codex subscription, read [Codex SDK setup](docs/development/codex-sdk-host.md). This separate mode supports completed assistant messages, follow-up messages, saved sessions, and Stop.

For Opus or Sonnet text chat with your host API key, read [Claude SDK setup](docs/development/claude-sdk-host.md). Each Claude agent selects one model family and supports follow-up messages, saved sessions, and Stop.

For GLM 5.3 text chat through an OpenCode Go subscription, read [Pi setup](docs/development/pi-host.md). Pi supports streamed replies, follow-up messages, saved sessions, and Stop. This mode has no tools or file access.

Use Node 24.22.3 and npm 11.19.1.

```sh
npm ci
npm run setup:browser
npm run verify
```

Build before running standalone `npm run check` or `npm test`. Consumers resolve emitted package exports in dependency order.

Read [architecture boundaries](docs/architecture/boundaries.md), the [native credential contract](docs/architecture/native-credentials.md), [Apple qualification](docs/architecture/apple-qualification.md), and [Switchboard artifact provenance](vendor/README.md).
The [AG-UI conformance matrix](docs/protocol/README.md) separates canonical wire coverage, installed projection fixtures and pending product qualification.

Linux CI runs the same package checks and browser fixtures with the pinned toolchain.
Apple application builds remain separate.

Read [recorded host development](docs/development/recorded-host.md) to run paired browser views against the independent host process.

Read [host observability](docs/development/observability.md) to export opt-in OpenTelemetry request and agent-run traces to a Collector or local Datadog Agent.

Read the [default theme and primitives](docs/design/theme.md) and [T3 Code design findings](docs/design/t3-code.md).
Run `npm run preview:theme` after building to inspect the local visual fixture.

## Launch the desktop app

On macOS, install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and make Node.js and npm available. From the repository root, run:

```sh
./agentui
```

The launcher builds the app, starts a local Codex host in your current directory, and opens the client. Keep the terminal running. Select **New conversation** to begin.

To run the host on another machine, pass its SSH destination:

```sh
./agentui --ssh lunus@100.102.195.3
./agentui --ssh infra-admin@100.82.43.93
./agentui --ssh punk1290@100.69.236.34
```

The launcher detects the remote operating system and architecture, provisions private tools and the built host, and connects through an SSH tunnel. The remote workspace defaults to that user's home directory. Add `--workspace /absolute/remote/project` to choose a project. Files stay on the selected host.

To use Pi with GLM 5.3, export `OPENCODE_GO_API_KEY` and select Pi:

```sh
./agentui --agent pi
./agentui --ssh infra-admin@100.82.43.93 --agent pi
```

[Launcher setup](docs/development/launcher.md) covers provider credentials, persistent history, troubleshooting, and repeatable local and remote verification. The launcher trusts the selected user and connection. It does not require AgentUI enrollment.

For development with a live frontend server, use the pinned toolchain:

```sh
npm ci
npm run desktop:dev
```

The macOS bundle is a local build without distribution signing or notarization. Read the [desktop packaging guide](docs/qualification/desktop-macos.md) for packaging checks.

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
