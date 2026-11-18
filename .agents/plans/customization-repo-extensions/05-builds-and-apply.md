# WP6 and WP7: Worker builds, delivery, apply by restart, client reconnect and reload

## Repository evidence

- `scripts/build-local-customization.mjs`: flags `--repository --commit --out [--subdirectory]`; steps prepare, plan, Vite browser build of the whole desktop application, identity file, artifact manifest, `qualifyDesktopArtifact` in Chromium, rename into `--out`. It prints `{ directory, artifactId, root }`. Qualification is mandatory. It never replaces an existing output directory. It needs built host output under `apps/host/build/tsc`, the `@agentui/host/customization` and `@agentui/sdk` dists, Vite, Playwright Chromium, Node 24.22.3, npm 11.19.1 and registry access.
- `scripts/build-server-customization.mjs`: the same flags; writes `entries.mjs` and `customization.json`.
- `scripts/prepare-customization-sources.mjs`: `prepareCustomizationSources({ reference, scratchParent })` copies the repository per acquisition and runs `npm ci --ignore-scripts` per owning npm directory with a private empty cache (`npm_config_cache` set to a private directory), a per-install cap of 120 seconds, and one 600-second deadline for the whole preparation. `packages/host/src/customization/budget.ts` gives source resolution its own 600-second budget. Each build script runs its own preparation.
- `packages/host/src/customization/server-artifact.ts`: the host loads an artifact only when `artifactId`, `sdkVersion`, `runtime.version`, `runtime.modules` and `abiIdentity` match. `apps/host/src/server-artifact-runtime.ts` supplies the running host's values. `scripts/server-customization-abi.mjs` computes the ABI identity from the SDK's built files; it has no platform or architecture part.
- `scripts/build-host.mjs` defines `AGENTUI_SERVER_CUSTOMIZATION_ABI`. The SSH release copies `apps/host/dist` byte for byte, so a remote host has the same host artifact ID and ABI identity as the local build.
- `apps/host/src/server-extension-config.ts`: a version 2 configuration with `ownership: "transient"` accepts `{ kind: 'artifact', directory, artifactId, installations }`. `directory` resolves against the configuration file. A missing or blank token variable fails that grant and host startup. The host deletes the variables it consumed from its environment.
- `apps/host/src/main.ts`: the ready line is JSON with `mode`, `origin` and `hostId`. `parseArgs` keeps the last value of a repeated flag.
- `scripts/agentui-launch-session.mjs` (60 lines, copied alone into the SSH release as `session.mjs`): reads one JSON line from standard input (`OPENCODE_GO_API_KEY`, `AGENTUI_SETUP_CAPABILITY`) into `environment`, spawns the host detached with standard output inherited, stops it on signal or when standard input closes, and exits with the host's exit code.
- `scripts/agentui-launch.mjs`: `deploy` uploads a release with tar over ssh into `<remote setup root>/releases/<id>` and skips an existing release; `sessionArguments` builds the `desktop` command line; `waitForHost` reads the ready line from the session output and checks the host artifact ID; `extensionArguments` handles the setup-root `extensions.json`.
- `packages/host/src/local-host.ts`: a private `active` counter for native turns. `packages/host/src/extensions/index.ts`: `status()` reports pending provider work. `apps/host/src/server.ts`: `host.close()` drains and force-closes HTTP after 2 seconds.
- `apps/desktop/src/application/application-controller.ts`: on `ServiceConnectionLost` it publishes `host: { kind: 'unavailable' }` and pauses. `apps/desktop/src/application/ArtifactIdentity.tsx` reads `/artifact.json` once on mount. `apps/desktop/src-tauri/src/main.rs` allows navigation only to bundled URLs or the exact `--host-url`.

## WP6: Worker builds

Prerequisite state: WP5 merged.

### Keys and records

- Builder identity (new): `{ hostArtifactId, abiIdentity, sdkVersion, wireVersion }`, read from the checkout's built host (`apps/host/dist/artifact.json`, the ABI module, `packages/contracts` constants).
- Inputs key (new): a SHA-256 over the resolved customization graph without the settings file: for each enabled reference in order, the resolved package's identity; the root's `extension`, `sources`, `shared`, `extensions` and `installations` in canonical JSON; and, only when the root has a local extension, a hash of the root package's file inventory with `agentui-settings.json` removed from it. The settings file never enters the key. Computing it needs source resolution but no install.
- Build key (new): a SHA-256 over the inputs key and the builder identity.
- Directory layout, fixed because the builders create their `--out` directory themselves, refuse an existing one, put scratch beside it, and remove it on failure:
  - `builds/<build key>/build.json` and `builds/<build key>/log.txt`: written by the worker;
  - `builds/<build key>/desktop` and `builds/<build key>/server`: the builders' `--out` targets, never created by the worker;
  - `scratch/<build key>/`: the scratch parent for preparation and builds, outside `builds/`, removed when the build ends.
- Build record `builds/<build key>/build.json` (new): `{ version: 1, buildKey, inputsKey, builderIdentity, commit, state, failure?, phases: { resolve, prepare, desktop, server }: { startedAt, finishedAt }, desktopArtifactId?, serverArtifactId?, namespaces, grants, ignoredGrants }`. `grants` are the root's installation grants whose namespace was built. The record holds no secret.
- `BuildStatus` on the wire (new): `{ buildKey, inputsKey, commit, state: 'queued' | 'resolving' | 'preparing' | 'building-desktop' | 'building-server' | 'ready' | 'failed' | 'cancelled'; failure?: 'toolchain-missing' | 'builder-changed' | 'resolve-failed' | 'sdk-mismatch' | 'prepare-failed' | 'desktop-build-failed' | 'qualification-failed' | 'server-build-failed' | 'timeout' | 'interrupted'; startedAt; finishedAt?; namespaces; ignoredGrants }`.

### Build procedure

- New script `scripts/build-customization.mjs` (new, beside the two existing build scripts): prepares once and runs both builds from that one preparation. Flags: `--repository --commit [--subdirectory] --out --npm-cache <directory> --install-timeout-seconds <n> --prepare-timeout-seconds <n> --resolve-timeout-seconds <n>`. First step: read both existing scripts and `prepareCustomizationSources`, and factor their post-preparation steps into functions that accept a prepared graph. If a shared preparation is not possible without rewriting the builders, run the two existing scripts in sequence with the new timeout and cache flags and record that choice.
- `scripts/prepare-customization-sources.mjs`: the per-install cap, the overall deadline and the npm cache directory become optional parameters with today's values as defaults. `packages/host/src/customization/budget.ts`: the graph time budget becomes a parameter with today's default.
- The worker runs the script as a child process with a fixed argument list, in its own process group, with `--npm-cache <setup root>/customization/npm-cache`, an install cap of 900 seconds, a preparation deadline of 1,200 seconds, a resolve budget of 600 seconds, and an overall limit of 30 minutes.
- Preflight before every build: Playwright's Chromium must be installed for the checkout (the qualifier launches it, and the launcher's own build step does not install it). Check with the Playwright API for the executable path; when it is missing, record `failed` with `toolchain-missing` and start no child. The UI sentence names `npm run setup:browser`.
- Before a build starts, the worker (under the store lock) deletes `builds/<build key>/` and `scratch/<build key>/` if they exist, creates `builds/<build key>/`, and writes `build.json` with `state: 'queued'`. Once the child is spawned it records the child's process group ID and process start time, registers the child with the launcher, and releases the lock.
- The checkout must not change under a build. Before the launcher's own rebuild step (`npm ci && npm run build`), the launcher checks the store for a build in a non-final state whose owner is alive; if one exists it skips the rebuild for this start and prints one line that says so. After a build ends, the worker compares the checkout's builder identity with the one recorded at the build's start; when they differ it records `failed` with `builder-changed`.
- When a build finishes or fails, the worker updates `build.json` and pushes status.
- Map each script failure category to one `failure` value. The implementer reads the scripts' categories (`install-failed`, `resource-limit`, `build-failed`, `npm-mismatch`, `invalid-graph`, `toolchain-mismatch`, the qualifier's result) and writes the table into the pull request. A manifest whose `sdkVersion` differs from the builder's maps to `sdk-mismatch`.
- No script output reaches the host. The worker writes the last 64 KiB of the child's output to `builds/<build key>/log.txt`.

### When builds run

- After `connect`, after a `sync` or `toggle` that changed the inputs key, and on `customization-rebuild`.
- When a `ready` build with the same build key exists, no build runs; the worker reports that build.
- One build at a time per machine, tracked by a build slot in the store (the record in a non-final state), not by holding the store lock. A mutation that changes the inputs key preempts a running build: under the lock, kill its process group, mark it `cancelled`, then start the new build. A worker in another session sees the slot taken and shows that build's status.
- An enabled set that is empty and a root with no local extension need no child process: the record is `ready` with empty namespaces and no artifacts.
- At worker start, after acquiring the store lock: for every record in a non-final state whose owning worker is dead (the lock's owner rules), kill the recorded process group only when a process with that group ID and the recorded start time still exists, then mark the record `interrupted`. A record owned by a live worker in another session is left alone. Then, if the connection exists and no `ready` build matches the current head and builder identity, start a build. This rebuilds automatically after an AgentUI update.
- When the worker's `signal` aborts (launcher exit): kill the running build's process group, mark it `interrupted`, release the lock.
- Pruning after each finished build, under the lock: read every `profiles/*.json`; keep every build key any profile references, plus the newest `ready` build; delete the rest. Each worker rewrites its profile file whenever its host reports a new `launch.json` state.
- Remote hosts: after a successful apply on an SSH target, the worker removes directories under `<remote setup root>/customization/builds/` other than that host's `current` and `next` (one ssh command with a fixed script).

### Tests and acceptance (WP6)

- Test fixture `tests/support/customization-fixture.mjs` (new): a small, dependency-free customization repository (npm inputs `absent`) with two tiny extensions, each with a desktop entry and a server entry that registers one trivial provider. The real build scripts build it offline in seconds.
- New `tests/desktop/customization-builds.test.mjs`:
  - the worker builds the fixture with the real `scripts/build-customization.mjs` and reaches `ready` with both artifact IDs, both namespaces and both grants; the host's artifact loader accepts the server artifact;
  - a settings commit does not change the inputs key and starts no build;
  - a toggle changes the inputs key, cancels a running build and builds the new one;
  - a second identical request reuses the `ready` build;
  - a changed builder identity (stub the identity reader) yields a different build key and a new build;
  - with a stub builder that sleeps, the overall limit kills the process group and reports `timeout`;
  - a worker restart with a live orphan child whose owner is dead kills it and marks the record `interrupted`, and a rebuild of the same key succeeds because the directories were removed first; a record whose process group ID now belongs to an unrelated process (different start time) is marked `interrupted` without killing anything;
  - a second live worker starting during the first worker's build does not kill or interrupt it;
  - aborting the launcher signal mid-build leaves no descendant process;
  - a missing Chromium yields `toolchain-missing` and no child process;
  - the builders' `--out` directories do not exist before the child starts, and `build.json` survives a builder failure that removes its output;
  - pruning keeps a build key referenced by another profile's file;
  - a builder identity that changes during a build yields `builder-changed`;
  - each failure fixture maps to its `failure` value, and no status contains script output;
  - an all-disabled package becomes `ready` with no child process.
- Gate G2: with `AGENTUI_CUSTOMIZATION_NETWORK_TESTS=1` or by hand, run one real build of `examples/customization` through the worker and record the duration of each phase and the result in the pull request. Run it once more with an empty Playwright browser cache (`PLAYWRIGHT_BROWSERS_PATH` pointing at an empty directory) to confirm the `toolchain-missing` path. If it cannot finish within the limits, stop and report the phase times.
- `npm run verify` passes.

## WP7: Delivery, apply by restart, client reconnect and reload

Prerequisite state: WP6 merged and gate G2 passed.

### Host-side files (`<data-dir>/customization/`)

- `launch.json` (host is the only writer): `{ version: 1, current: LaunchTarget | null, next: LaunchTarget | null }`. `LaunchTarget` is `{ buildKey, inputsKey, hostArtifactId, assets: <absolute path> | null, server: { directory, artifactId } | null, grants }`.
- `launch-result.json` (session wrapper is the only writer): `{ version: 1, attempted: buildKey | null, started: buildKey | null, outcome: 'ok' | 'start-failed' | 'stale' | 'defaults', omittedGrants: [variable names] }`.
- `extensions.generated.json`: written by the wrapper for each start.

### Apply

- `customization-apply { requestId, buildKey }`, handled by the host relay:
  1. Refuse `not-ready` unless the worker's status shows a `ready` build with that key whose builder identity's `hostArtifactId` equals the running host's artifact ID.
  2. Refuse `missing-token` when a grant of the build names a variable that is neither in the worker's reported present names nor already consumed by this host. The reply path is `results`, and `missingTokens` in status names the variables.
  3. Set a draining gate: refuse new turns, new provider operations and new customization mutations (`draining`). Then check active work. First step of this work package: establish which host state shows that a turn is running. The `active` counter in `packages/host/src/local-host.ts` wraps host calls and may not cover a native driver turn after dispatch returns; the drivers keep run state (see `currentRunId` handling in `apps/host/src/server.ts` and the driver modules in `packages/host/src`). Add a read-only accessor (new) that reports a running turn for every driver kind and for provider conversations, and write the evidence into the pull request. If any work is active, clear the gate and return `active-work`.
  4. Queue a `deliver` request for the worker. The gate has a deadline: if no `delivered` or `delivery-failed` arrives within 10 minutes, or the worker becomes `worker-offline`, the host clears the gate and records `delivery-failed`.
- `deliver` in the worker:
  - Local session: the build directory is already on this machine. Report `delivered` with the absolute paths under `<setup root>/customization/builds/<build key>/`.
  - SSH session: upload `builds/<build key>/` to `<remote setup root>/customization/builds/<build key>/` with the tar-over-ssh helper exported in WP5, into a temporary directory renamed into place. Skip the upload only when the remote copy's `build.json` names the same desktop and server artifact IDs as the local record; otherwise replace the remote copy. A build key can be rebuilt after a failure, so existence alone proves nothing. Report `delivered` with the remote absolute paths. The heartbeat keeps running during the upload. A failure reports `delivery-failed`, and the host clears the draining gate.
- On `delivered`, the host writes `launch.json` with `next` set, records the result `ok` for the request, replies to pending status calls, closes with `host.close()`, and exits with code 75.

### Session wrapper (`scripts/agentui-launch-session.mjs`)

The wrapper stays one self-contained file with no local imports, because the SSH release ships it alone. New behaviour:

- Secrets line: the launcher adds `extensionVariables: { NAME: value }` holding every launcher environment variable whose name matches `^AGENTUI_EXTENSION_[A-Za-z0-9_]+$`. The wrapper validates the names with that pattern, rejects non-string values, and adds them to `environment`. The same `environment` object is reused for every restart.
- Choosing arguments before each start:
  1. Read `<data-dir>/customization/launch.json`. Take `next` when set, otherwise `current`.
  2. Read `artifact.json` beside the host's `main.js`. If the target's `hostArtifactId` differs, use no target and record `stale`.
  3. For a target: replace the `--assets` value in the argument list with the target's `assets` (do not append a second `--assets`). If the target has a server artifact, write `extensions.generated.json` (version 2, `ownership: "transient"`, one `kind: "artifact"` entry with the absolute `directory`, the `artifactId`, and the target's grants) and append `--extensions <that file>`. Leave out each grant whose variable is unset or blank in `environment`, and list those variable names in `omittedGrants`.
  4. With no target: the original arguments, and outcome `defaults`.
- Starting and confirming:
  - Spawn the host with standard output piped. Forward every byte to the wrapper's standard output unchanged. A line that parses as JSON with `origin` and `hostId` is the ready line.
  - Ready timeout per target: 20 seconds. If the host exits, or 20 seconds pass, before the ready line while a target was used: kill the process group, record `start-failed` for that build key, and start again with the other target (`current` after a failed `next`; no target after a failed `current`). A start with no target that fails ends the session with the existing error.
  - The launcher's `waitForHost` has its own 60-second deadline and ends the whole session when it expires. Raise that deadline to 120 seconds so it covers two failed targets plus a default start (20 + 20 + the existing host start time). A target that failed is cleared from `launch.json` by the host on its next start, so the next session does not pay for it again.
  - After the ready line, write `launch-result.json` with `started` and `outcome`.
- Exit code 75 from a host that was ready: start again, recomputing arguments. The existing exit handler closes the input reader and destroys standard input on any host exit; on code 75 it must not. The wrapper keeps standard input open (it is the session lease), resets its host handle and process group ID, and respawns. Any other exit ends the session as today.
- SSH: the wrapper and the `ssh -L` forward stay up across the restart, because the ssh session runs the wrapper, not the host. Only the host process restarts.
- The host reads `launch-result.json` at startup. When `started` equals `next.buildKey`, it rewrites `launch.json` to `{ current: next, next: null }`. When the outcome is `start-failed` for `next`, it clears `next`. It reports `running` in `CustomizationStatus` from `launch-result.json`: the started build key or `null`, `omittedGrants`, and `stale`.

### Launcher (`scripts/agentui-launch.mjs`)

- Remove `extensionArguments`, the setup-root `extensions.json` handling and `tests/desktop/launcher-extensions.test.mjs`. Keep the one-line notice from WP5.
- Send `extensionVariables` on the secrets line for local and SSH sessions.
- `waitForHost` keeps its logic (the wrapper still forwards the ready line, and the host artifact ID does not change across these restarts); only its deadline changes, as above.
- `deploymentHash` already covers `session.mjs`; no new file enters the release.

### Client (`apps/desktop/src/application/application-controller.ts`, `use-application.ts`, `ArtifactIdentity.tsx`)

- After an accepted `customization-apply`, the controller enters a `restarting` state (new). It polls `customization-status` for the request's result. On a refusal it leaves the state and reports the cause.
- When the connection drops in that state, it retries `metadata` every second for up to 120 seconds without user action.
- When the host answers, the client fetches `/artifact.json`. If its `artifactId` differs from the one read at page load, the client reloads once with `location.replace(<the exact URL the page was loaded from>)`; the Mac app blocks any other URL. If it is the same, the client resumes.
- If the host does not answer in time, the client shows the existing unavailable state with `Reconnect`.
- The same artifact check runs after a manual `Reconnect`, so a restart started from another client also leads to a reload.
- The Mac app's native mode (started without `--host-url`, rendering `NativeApplication` from the embedded bundle) has no `/artifact.json` and no launcher. There the client skips the artifact check, never reloads for it, and shows the customization sections as `worker-offline`.
- Drafts survive the reload through the existing draft storage.

### Workspace setup text

- `extensions/crew/src/desktop/CrewWorkspace.tsx` and `extensions/coworkers/src/desktop/CoworkersWorkspace.tsx` define `CONFIGURATION = '~/.local/share/agentui/extensions.json'` for their setup guidance. Replace the guidance: add the installation grant to the connected repository's `installations`, set the token variable in the launcher's shell, and restart AgentUI. Update the browser tests that assert the old text.

### Behaviour and invariants

- An apply never proceeds while a turn or a provider operation is running, and no new work is admitted between the check and the exit.
- A build made by a different host build is never started.
- A failed start falls back, on every start, so the user keeps a host whenever a previous target or the defaults can start.
- One missing token omits only its own grant. The other extensions and the desktop assets still load, and the affected extension shows `Not configured`.
- `launch.json` has one writer and `launch-result.json` has one writer.
- No token value is written to any file under `customization/`, to a log, or to a reply. `extensions.generated.json` holds variable names only.

### Tests and acceptance (WP7)

- New `tests/desktop/session-restart.test.mjs`, driving the real wrapper with a stub host executable:
  - exit code 75 restarts with `--assets` replaced (exactly one `--assets` in the final arguments) and `--extensions` pointing at the generated file;
  - the ready line is forwarded unchanged, and the real `waitForHost` from the launcher succeeds through the wrapper;
  - a host that exits before ready, and one that never reports ready, both fall back to `current`, then to no target; `launch-result.json` records each outcome;
  - launcher level: with a `current` target whose stub host hangs, the real launcher's `waitForHost` still gets a ready session on defaults within its deadline, and the following start does not try the failed target again;
  - after a restart on code 75, closing the wrapper's standard input still stops the host (the lease works);
  - a target whose `hostArtifactId` differs is not started and is recorded `stale`;
  - a grant whose variable is missing is left out, the other grant stays, and `omittedGrants` names the variable only;
  - `extensionVariables` with a bad name or a non-string value is rejected;
  - every restart receives the same environment, including `AGENTUI_SETUP_CAPABILITY`;
  - the wrapper file, copied alone into an empty directory with a bare `{"type":"module"}` `package.json`, runs: it has no local imports.
- New `tests/host/customization-apply.test.mjs`: `not-ready`; `missing-token`; `active-work` while a stub driver's turn is still running after its dispatch call returned; a turn submitted after the draining gate is refused; a worker that goes silent after `deliver` was queued releases the gate at its deadline; `delivery-failed` clears the gate; on `delivered` the host writes `launch.json` and exits 75; at startup the host promotes `next` from `launch-result.json`.
- New `tests/application/customization-apply.browser.test.mjs`, using the dependency-free fixture and real builds: toggle one fixture extension off, wait for `ready`, apply; the host restarts through the wrapper, the page reconnects without a click and reloads once; the disabled extension's agent is absent from `metadata.agents` and from the agent picker; a draft typed before the apply is still present.
- SSH path, automated. The existing fake `ssh` in `tests/desktop/launcher-session.test.mjs` only simulates setup hanging or exiting, and the real bootstrap downloads Node into a fixed root, so this test does not go through the launcher's bootstrap. Instead:
  - the worker's delivery function takes an injectable command runner; the test passes a runner that executes the remote script locally with `sh -c` against a temporary directory acting as the remote setup root, and asserts the upload, the skip rule (same artifact IDs) and the replace rule (different IDs);
  - the wrapper, copied alone into a temporary release directory, is started with a stub host and a `launch.json` that points into that remote root, and uses the delivered build.
- Manual checks, each reported or stated as not run:
  - local: connect `examples/customization` on a dedicated branch of a scratch clone with a bare remote, toggle Coworkers off, apply, and confirm Coworkers is gone and Crew remains;
  - a real `--ssh` host: the same flow;
  - the Mac app: the reload after apply returns to the app, not a blocked navigation;
  - rebuild AgentUI with a changed SDK file, relaunch, and confirm the host starts with defaults, the page shows the rebuilt customization, and applying it works.
- `npm run verify` passes.

### Exclusions

- No live swap without restart.
- No automatic apply after a build.
- No apply for a host the launcher did not start.
