# WP4 and WP5: Host relay, and the worker's connection, git writes and settings commits

## Repository evidence

- No code in `apps`, `packages` or `scripts` writes to git. `packages/host/src/customization/repository.ts` reads commits with `git init --bare`, `fetch`, `rev-parse`, `ls-tree`, `cat-file`, sets `GIT_TERMINAL_PROMPT=0`, and uses ambient SSH agents and credential helpers. `docs/customization/sources.md` forbids credentials in repository URLs.
- `packages/host/src/customization/contract.ts`: `repositoryLocation` and `repositoryAddress` validate a local path, a file URL, an SSH or an HTTPS location with no credentials. A relative path resolves against the process working directory.
- `packages/contracts/src/service.ts`: `ServiceRequest`, `parseServiceRequest`, `ServiceValueMap`, `createServiceConnection`. `apps/host/src/api.ts`: `requestScope` and the `createApi` dispatch. `apps/desktop/src-tauri/src/wire.rs`: `enum Request` and the scope match, with tests in `wire.rs` and `wire_extension_tests.rs`. `tests/client/fixtures/extension-requests.json` is shared by the TypeScript and Rust wire tests.
- `packages/contracts/src/compatibility.ts`: `SERVICE_WIRE_VERSION = 16`.
- `apps/host/src/service-endpoint.ts`: the `browser-development` endpoint accepts a POST with `Origin` and `Host` equal to `http://127.0.0.1:<port>` and JSON content. The launcher already calls it in `waitForHost` (`scripts/agentui-launch.mjs`).
- The launcher keeps running for the session. For SSH it holds an `ssh -L <port>:127.0.0.1:<port>` forward with the same port on both sides.
- Setup root: `~/.local/share/agentui` on each machine, with `tools`, `data`, `releases` (`scripts/agentui-runtime.mjs`). The data directory is per profile.
- The host data directory holds `host.sqlite`, `owner.sqlite`, `control.sock`, `refresh-artifacts/` and `recorded.jsonl`.
- `tests/desktop/launcher-session.test.mjs` tests launcher and session behaviour with fake binaries on `PATH`, including a fake `ssh`.

## WP4: Relay operations and host state

Prerequisite state: WP3 merged.

### Service operations (`packages/contracts/src/service.ts`, wire 17)

One wire bump reserves every operation this plan needs. None has a conversation scope.

Client operations:

| Operation | Request | Reply |
|---|---|---|
| `customization-status` | `{}` | `CustomizationStatus` |
| `customization-connect` | `{ requestId, location, branch, subdirectory }` | accepted or refused |
| `customization-disconnect` | `{ requestId }` | accepted or refused |
| `customization-sync` | `{ requestId }` | accepted or refused |
| `customization-toggle` | `{ requestId, key, enabled, expectedHead }` | accepted or refused |
| `customization-settings` | `{ requestId, settings, expectedHead }` | accepted or refused |
| `customization-rebuild` | `{ requestId }` | accepted or refused |
| `customization-apply` | `{ requestId, buildKey }` | accepted or refused |

Worker operations:

| Operation | Request | Reply |
|---|---|---|
| `customization-worker-pull` | `{ workerId, waitSeconds }` | `{ requests: readonly WorkerRequest[] }` |
| `customization-worker-push` | `{ workerId, status: WorkerStatus, results: readonly WorkerResult[] }` | `{ ok: true }` |

- `requestId` is a client-chosen UUID. The host keeps the last 32 results by `requestId`.
- A mutating client operation is refused at once with one of: `unsupported` (no worker), `busy` (a mutation is queued or running), `draining` (an apply is in progress), `invalid-request`. Otherwise the host queues it and replies `{ kind: 'accepted' }`. The outcome arrives later in `CustomizationStatus.results`.
- A mutation is pending from acceptance until the worker reports its git and state step. A build that the mutation triggers runs afterwards in the background and does not keep the mutation pending.
- A pending mutation that gets no result within 180 seconds is ended by the host with the result `worker-timeout`. The host also accepts and stores a result for a `requestId` it no longer has queued.
- `customization-worker-pull` waits up to `waitSeconds` (at most 10) for a queued request, so each call stays well under the 20-second transport deadline.
- `CustomizationStatus` (new):

```ts
// proposed shape
interface CustomizationStatus {
  support: 'supported' | 'worker-offline';
  connection: { location: string; branch: string; subdirectory: string } | null;
  head: string | null;
  extensions: readonly { key: string; enabled: boolean; namespace: string | null }[];
  settings: CustomizationSettings | null;      // from WP2; null with no connection or no file
  build: BuildStatus | null;                   // defined in WP6
  running: { buildKey: string | null; omittedGrants: readonly string[]; stale: boolean };
  pending: { requestId: string; op: string } | null;
  results: readonly { requestId: string; outcome: 'ok' | WorkerFailure }[];
  missingTokens: readonly string[];            // variable names only
}
```

- `WorkerFailure` is a closed set: `worker-timeout`, `toolchain-missing`, `invalid-location`, `clone-failed`, `invalid-package`, `invalid-settings`, `conflict`, `unknown-extension`, `unchanged`, `unsupported-format`, `identity-missing`, `push-rejected`, `push-unauthorized`, `git-timeout`, `git-failed`, `not-ready`, `active-work`, `missing-token`, `delivery-failed`, `state-invalid`.
- Field bounds, enforced in TypeScript and Rust: `location` 2,048 bytes, `branch` 200, `subdirectory` 1,024, `key` 3,200 (a remote key is a location plus a subdirectory), `settings` 16,384 serialized, at most 256 extensions (the source model's cap), `WorkerStatus` 1,000,000 serialized. The worker operations use `/api/v1` over HTTP only, so the native transport's smaller limits do not apply to them.
- `SERVICE_WIRE_VERSION` becomes `17`. Update the pinned literals with `git grep -n "SERVICE_WIRE_VERSION\|wire.*16" tests packages docs`.
- `packages/client`: connection methods for the client operations. No retry.
- `apps/desktop/src-tauri/src/wire.rs`: variants for the eight client operations with the same bounds. The two worker operations are not added to the Tauri allowlist; only the launcher uses them, over HTTP. Add cases to the shared fixture `tests/client/fixtures/extension-requests.json` for the client operations.

### Host state (`apps/host/src/customization-relay.ts`, new, beside `refresh-jobs.ts`)

- In memory: the request queue (at most one mutation), the last `WorkerStatus`, the time of the last worker call, and the results ring. A host restart loses them; the worker pushes its full status again on its next call, and clients treat a `requestId` the host does not know as ended (WP8).
- `support` is `worker-offline` when no worker call arrived in the last 30 seconds. The host then refuses mutations with `unsupported`.
- On disk, directory `<data-dir>/customization/` (new, mode 0700). The host is the only writer of `launch.json`; the session wrapper is the only writer of `launch-result.json` (both defined in WP7).
- `apps/host/src/api.ts`: `requestScope` returns `null` for the ten operations; dispatch to the relay.
- The relay never interprets `location`, never runs git and never spawns a build.

### Trust statement

- `docs/customization/connected-repository.md` (new): any client on the overlay network can queue a request that makes the launcher machine commit, push and build, and any caller can act as the worker. This is the trust boundary `AGENTS.md` defines; clients already run agents with shell access on the host.

### Tests and acceptance (WP4)

- New `tests/host/customization-relay.test.mjs` (directory already in the `npm test` globs), with a test worker that calls the two worker operations:
  - with no worker, status is `worker-offline` and a mutation is refused with `unsupported`;
  - a queued toggle is delivered by `worker-pull`, and the result pushed by the worker appears in `results` under its `requestId`;
  - a second mutation while one is pending is refused with `busy`;
  - `worker-pull` returns empty after its wait when nothing is queued;
  - an over-size `WorkerStatus` is rejected;
  - 31 seconds without a worker call turns status to `worker-offline` (use an injectable clock);
  - a pending mutation with no result for 180 seconds ends with `worker-timeout`, and a later mutation is accepted;
  - a result for an unknown `requestId` is stored and returned in `results`;
  - a status with 256 extensions and a 3,000-byte remote key is accepted.
- `tests/client/wire-validation.test.mjs` and the Rust wire tests: the client operations round-trip from the shared fixture; over-long fields are rejected on both sides.
- `cargo test` in `apps/desktop/src-tauri` passes. `npm run verify` passes.

## WP5: The customization worker — connection, git writes, settings commits

Prerequisite state: WP4 merged.

### Change surface

- `scripts/agentui-customization-worker.mjs` (new): exports `startCustomizationWorker({ origin, localSetupRoot, repositoryRoot, signal, target, registerChild })`.
  - `localSetupRoot` is the launcher machine's setup root (`join(homedir(), '.local/share/agentui')`), never the remote one. In an SSH session the launcher's `setup.root` is the remote root; pass it only inside `target`.
  - `target` is `{ kind: 'local' }` or `{ kind: 'ssh', destination, remoteSetupRoot }`.
  - `registerChild` adds a spawned child to the launcher's `children` set, so the launcher's `stop()` terminates it.
  - The launcher starts the worker in-process for both local and SSH sessions after `waitForHost` succeeds, and aborts `signal` at session end. On abort the worker kills any child it started, marks a running build `interrupted`, and releases its lock before the launcher exits.
- `scripts/agentui-launch.mjs`: export the tar-over-ssh upload helper that `deploy` uses, with its `sshOptions`, so the worker can reuse it in WP7.
- `scripts/lib/customization-git.mjs` (new): the git writer.
- `scripts/lib/customization-store.mjs` (new): the worker's store.
- The worker must not contain service names. It imports `@agentui/host/customization` for parsing, as `scripts/local-customization.mjs` does.

### Worker store (launcher machine)

- Directory `<setup root>/customization/` (new, mode 0700), shared by every profile on the machine:
  - `connection.json`: `{ version: 1, location, branch, subdirectory } | null`.
  - `clone/`: the worker's clone.
  - `builds/` and `npm-cache/` (WP6).
  - `scratch/`: build scratch directories (WP6).
  - `lock/`: the store lock. It is a directory created with `mkdir`, holding `owner.json`: `{ pid, processStartTime, hostname, sessionId, heartbeatAt }`. The owner rewrites `heartbeatAt` every 5 seconds while it holds the lock.
    - The lock is held only for a git or state mutation, and for the short steps that start, cancel or finish a build record. It is not held while a build runs.
    - A worker that finds the lock held waits up to 30 seconds, then reports `busy`.
    - Takeover: only when the owner is provably dead. That means the same hostname and no process with that PID and start time, or a heartbeat older than 60 seconds. Read the process start time with `ps -o lstart= -p <pid>`.
  - `profiles/<profile id>.json`: the build keys this profile's host currently uses (`current` and `next`), written by that session's worker under the lock (WP6 pruning reads all of them).
- Files are written atomically (temporary file plus rename). A malformed `connection.json` makes every mutation fail with `state-invalid`; the worker does not repair it.

### Worker loop

Two concurrent activities run for the whole session:

- Heartbeat: `customization-worker-push` with the full status at least every 10 seconds, independent of any request that is running. A long git command or upload therefore never makes the host report `worker-offline`.
- Requests: `customization-worker-pull` with `waitSeconds: 10`; run each returned request, one at a time; push its result as soon as its git and state step ends. Builds run in the background (WP6) and report through the heartbeat and on every phase change.

On a network error, wait 1 second and retry. The worker never exits on its own while the session runs.

### Git writer rules

Every git command runs with a fixed argument list (no shell), these settings, and a 120-second timeout:

- environment `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`;
- `-c core.hooksPath=/dev/null` (hooks never run in the worker's clone);
- `-c user.useConfigOnly=true` (no auto-detected identity);
- commit signing follows the user's git configuration; a signing prompt that blocks ends in `git-timeout`.

Captured git output is never sent to the host. The worker writes the last 16 KiB of a failed command's output to `<setup root>/customization/git.log` for the user.

### Requests

- `connect({ location, branch, subdirectory })`:
  1. Validate `location` with the existing `repositoryLocation` rules, and reject a relative local path. Validate `branch` with `git check-ref-format --branch`. Validate `subdirectory` with the existing contained-path rule.
  2. Remove any existing `clone/`. Run `git clone --branch <branch> --single-branch -- <location> clone`.
  3. Read `<subdirectory>/package.json` at HEAD and parse it with `parseCustomizationPackage`. Read and parse `agentui-settings.json` when present. A failure removes the clone and returns `invalid-package` or `invalid-settings`.
  4. Reject two references with the same key (`invalid-package`).
  5. Write `connection.json`. Start a build (WP6).
- `disconnect`: remove `connection.json` and `clone/`. Keep `builds/`. The host keeps running its applied build until the next apply.
- `sync`: `git fetch origin <branch>`, then `git merge --ff-only origin/<branch>`. If the clone has diverged (possible only after a failed push), `git reset --hard origin/<branch>`; the clone belongs to the worker. Re-read the package and settings. Start a build when the build inputs changed.
- `toggle({ key, enabled, expectedHead })`:
  1. `sync`. If the head differs from `expectedHead`, return `conflict`.
  2. Edit `<subdirectory>/package.json` in place (see "In-place edit"). If the value is already set, return `unchanged`.
  3. `git add -- <path>`, then `git commit -m "<Enable|Disable> <key> extension" -m "Changed by AgentUI."`. A missing identity returns `identity-missing`.
  4. `git push origin HEAD:<branch>`. Never pass a force flag.
  5. On a rejected push or an authentication failure: fetch, `git reset --hard origin/<branch>`, and return `push-rejected` or `push-unauthorized`.
  6. On success, start a build.
- `settings({ settings, expectedHead })`: `sync` and the same `conflict` rule; write `agentui-settings.json` with `serializeCustomizationSettings`; `unchanged` when the bytes are equal; commit with the message `Update AgentUI settings`; push with the same failure rules. No build starts, because settings are not a build input (WP6 build key).
- The reference `key` is the reference's `subdirectory` for a same-repository reference and `<repository>#<subdirectory or .>` for a remote one.

### In-place edit of `enabled`

- Do not re-serialize the file. Tokenize the JSON text, find the object at `agentui.extensions[i]`, and:
  - when it has an `enabled` member, replace only that value's bytes with `true` or `false`;
  - when it has none, insert `, "enabled": false` immediately before the object's closing brace. Enabling a reference that has no member is `unchanged`.
- Parse the result and compare it with the original: every value other than that one flag must be equal. Otherwise return `unsupported-format` and write nothing.
- Implement the tokenizer in `scripts/lib/customization-git.mjs` or a sibling file; no new dependency.

### Status

- After every request and every sync, the worker pushes: the connection, the head commit, the references with `key`, `enabled` and `namespace` (from the referenced package's manifest in the clone for a same-repository reference; `null` for a remote reference until a build resolved it), the parsed settings, and the list of `AGENTUI_EXTENSION_*` variable names that are set and non-blank in the launcher's environment (names only).

### Launcher

- `scripts/agentui-launch.mjs`: start the worker for local and SSH sessions. Print one line when `<setup root>/extensions.json` exists: the file is no longer read, and extensions are now enabled in Settings. (The removal of `extensionArguments` itself is in WP7.)

### Tests and acceptance (WP5)

- New `tests/desktop/customization-worker.test.mjs` (directory already in the `npm test` globs), with a real host started in process, local bare repositories as remotes, and builds stubbed out (WP6 adds them):
  - connect clones, parses and reports the example's two references with namespaces and the settings;
  - a package that fails to parse returns `invalid-package` and leaves no clone; a relative path and a location with embedded credentials return `invalid-location`;
  - a toggle produces exactly one new commit on the remote branch with the expected message, whose diff touches only the `enabled` value;
  - the in-place edit works on the example's layout, on a four-space file, on a tab-indented file, on a single-line minified file, and on a reference with no `enabled` member; a file the editor cannot change safely returns `unsupported-format` and creates no commit;
  - a stale `expectedHead` returns `conflict` and pushes nothing; a toggle to the current value returns `unchanged`;
  - a remote that rejects the push (a `pre-receive` hook that exits 1) returns `push-rejected`, and the clone equals the remote afterwards;
  - with `user.useConfigOnly=true` and no configured identity, the commit returns `identity-missing`; the test uses an empty `HOME`, sets `GIT_CONFIG_NOSYSTEM=1`, and unsets `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL` and `EMAIL`, so it is the same on every machine;
  - a global `core.hooksPath` with a failing `pre-commit` hook does not affect the worker's commit;
  - a settings request writes the file byte-stably, commits `Update AgentUI settings`, pushes, and starts no build;
  - two live workers on one store: the second waits, then reports `busy`, while the first holds the lock, and does not disturb the first;
  - a lock left by a worker killed with SIGKILL is taken over once its owner is gone; a lock whose owner is alive is never taken over;
  - a git command slowed to 40 seconds does not make the host report `worker-offline`;
  - aborting the worker's `signal` mid-request leaves no child process and no held lock;
  - no status or result contains git output or a path other than `connection.location`.
- `tests/desktop/launcher-session.test.mjs`: the launcher starts the worker for a local session and for a session through the fake `ssh`; the old `extensions.json` notice prints once.
- `npm run verify` passes.

## Exclusions

- No builds and no apply in these two packages.
- No editing of `installations` or of references other than `enabled`.
- No worker for a host that the launcher did not start.
