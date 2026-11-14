# Build and launch AgentUI on macOS

AgentUI packages a React shell in a local Tauri application. It opens a disconnected landing page with built-in recovery controls. Pairing, host transport, conversation state, credential storage, and customization activation remain separate work in `agentui-otsp` and its prerequisites. Packaging is tracked by `agentui-gxrk`.

## Prepare your Mac

Install Xcode command-line tools and Rust using the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Use Node 24.22.3 and npm 11.19.1.

From the repository root, install the locked JavaScript dependencies:

```sh
npm ci
```

## Start development

```sh
npm run desktop:dev
```

The Tauri hook builds the shared workspace packages, starts Vite on `127.0.0.1:1420`, and opens the native window. The port is fixed and startup fails if another process owns it. Stop the development command before you qualify the production bundle.

## Build the local application

From the repository root, run:

```sh
./agentui
```

The executable launcher selects Node and npm versions from `.node-version` and `package.json`, installs locked dependencies, builds the bundle, and opens a fresh app instance. It resolves the repository from its own location, so an absolute invocation works from another directory. Installation or build failures stop before opening the app.

The launcher prioritizes macOS system tools and fixes the build output at `apps/desktop/src-tauri/target`, even if your environment sets `CARGO_TARGET_DIR` elsewhere.

To build without opening the app, use the pinned toolchain and run `npm run desktop:bundle`. The resulting bundle is `apps/desktop/src-tauri/target/release/bundle/macos/AgentUI.app`.

The build hook compiles shared package exports and the desktop frontend. Cargo builds the native executable and embeds the frontend assets. The `.app` is ad-hoc signed for local use. Distribution signing, notarization, a universal binary, and an installer are not qualified.

Tauri consumes `apps/desktop/web-dist`. Existing package exports remain in `apps/desktop/dist`. The [official Vite integration guide](https://v2.tauri.app/start/frontend/vite/) describes the development URL and embedded-assets configuration.

## Resolve a shadowed macOS tool

The `./agentui` launcher already prioritizes macOS system tools. If a direct bundle command reports that `xattr` does not recognize `-r`, check `command -v xattr`. A Python environment can shadow Apple's `/usr/bin/xattr`. Run the direct build with system tools first:

```sh
PATH="/usr/bin:/bin:$PATH" npm run desktop:bundle
```

This changes the build process's tool lookup without changing your system installation.

## Check the shell

1. Stop the Vite development process.
2. Open the production `.app` with `./agentui`.
3. Confirm that the native window says **No host connected** and explains that pairing and conversations are unavailable.
4. Click **Restore default view**. Confirm that the built-in landing page remains visible.
5. Click **Reload app**. Confirm that the same page returns.
6. Quit the app and open the same bundle again.

The app starts no host process and manages no backend run. Its recovery controls sit outside the content error boundary. Browser tests inject a throwing content component to check containment and restoration. They do not qualify real customization loading or native error recovery.

## Run package and browser checks

```sh
npm run setup:browser
npm run verify
```

The checks build the production web assets, preserve package exports, and exercise the shell's disconnected content, recovery controls, and failed-content containment. They run on Linux without Rust or Apple toolchains. Native Rust compilation and `.app` launch remain separate local checks.

## Security boundary

The package declares no application IPC commands, native plugins, sidecars, or capabilities. Production CSP denies network connections and loads bundled scripts. Production styles use `style-src 'self'`. The shared theme sets CSS custom properties through the CSSOM without an inline-style allowance. Both browser tests fail on CSP violations. The app stores no credentials. Host authorization and OS-protected credential storage must be designed with pairing before connection controls are added.

## Local qualification record

The local checks below passed on November 14, 2026, against source commit `bdb275229a7624ddd5f45d9d77c585b234dad296`. The final build started from this committed source with a clean working tree. This record is a subsequent documentation change.

| Input | Observed value |
| --- | --- |
| Machine | Apple silicon, arm64 |
| macOS | 26.6.2, build 25G83 |
| Xcode | 26.2, build 17C52 |
| Node and npm | 24.22.3 and 11.19.1 |
| rustc | 1.98.1, 48a229cea |
| Cargo | 1.98.1, 797e8a9bc |
| Tauri crate and CLI | 2.12.5 and 2.12.4 |
| Bundle identifier | `homes.birb.agentui` |
| Native target | arm64 only |
| Signing | Ad-hoc with hardened runtime, no team identity, no notarization |
| Executable SHA-256 | `c4f296ce6d317508d9920b3967034a30d76937d6214d5bc87650ec25e59fe88c` |

`npm run verify` passed all 33 tests, strict TypeScript checks, and lint. The production browser check exercised light and dark appearance, keyboard restore, reload, and enlarged text on a narrow viewport. The failing-content fixture passed recovery containment and repeat restoration.

`npm run desktop:bundle` passed with the system-tool PATH adjustment above. `codesign --verify --deep --strict` and `cargo fmt --check` passed. No process listened on development port 1420 before production launch. The observed native document URL was `tauri://localhost`. Restore and Reload each returned the disconnected landing page. Quitting removed the application process. Reopening the same bundle returned the same page, and the app was left open.

The native window was inspected visually and through its accessibility tree. Failure injection was exercised in the browser fixture only. macOS 11 compatibility, distribution installation, real host connection loss, permission failures, and backend run continuity were not tested.

The [retained verification log](desktop-macos/bdb2752/verification.log.gz) records the exact source, clean-tree check, system-tool PATH prefix, toolchain versions, full verification, native build, formatting, signature check, and executable hash. Decompress it with `gzip -dc` to inspect the commands and exit codes. Native UI observations come from the local computer-use session. No automated native failure injection was performed. Development mode was not exercised.
