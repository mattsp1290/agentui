# Customization-repository extensions and settings, with agent delete and coworker create

Status: Ready for WP1–WP9, WP11 and WP13. WP10 waits for upstream work package WP9 (U-Crew). WP12 waits for upstream work package WP11 (U-Coworkers). See [External requests](#external-requests).

No implementation has occurred. This directory is a plan only.

## Application context

```json
{
  "application_context": {
    "has_active_users": false,
    "backward_compatibility_required": false,
    "feature_flags": "not-applicable",
    "confirmation_digest": "fc119d9d009397438338e649b9b5f8c119e22a3973f74ba80c7cbed5b3cf0ade",
    "confirmed_at": "2026-11-18T14:58:39Z"
  }
}
```

The user confirmed these answers in the planning session. Consequences applied in every work file:

- The plan removes the always-bundled extension behaviour and the setup-root `extensions.json` launcher file that pull request 138 adds. It adds no alias or migration for them. The launcher prints one line when it finds the old file.
- The plan bumps `EXTENSION_SDK_VERSION` and `SERVICE_WIRE_VERSION` without a compatibility path.
- No work package adds a feature flag.
- The plan adds new files under the launcher machine's setup root and under the host data directory. It does not change the stored format of existing artifacts or databases.

The user also decided in the same session:

- When the user toggles an extension, AgentUI commits the change and pushes it to the connected repository.
- The feature must also work when the host runs on a remote machine started with `--ssh`.
- The connected repository also stores appearance settings (light or dark, and the switch that shows extension views) and agent defaults in this change.

## Change type and affected areas

Change type: a redesign of how extensions are enabled, a first settings store, and new agent-management features that span three repositories.

Affected areas:

- `packages/host/src/customization` (source model, settings file), `packages/sdk`, `packages/contracts`, `packages/client`.
- `apps/host` (relay state, service operations, apply), `apps/desktop` (Settings, Extensions view, appearance, default agent, reconnect and reload, Tauri wire allowlist).
- `scripts` (launcher, session wrapper, a new customization worker, build scripts), `extensions/crew`, `extensions/coworkers`.
- A new example customization package under `examples/`.
- `tests`, `docs`, root `package.json`.
- Upstream: Crew and crabber-coworkers.

## Prerequisite

Pull request 138 (`feat/extensions-nav-crew-coworkers`) is merged, or this work branches from its head. Every path in this plan refers to the tree at that head (`ddd473f` or later).

## Requested outcome

1. Delete support for the agents of both services. This needs changes in AgentUI, Crew and crabber-coworkers.
2. Create support for coworkers.
3. Extension enabling works closer to how it worked before pull request 138: extensions come from a customization repository, not from the default build.
4. A page lists extensions. Toggling one updates the connected customization repository.
5. This repository ships an example customization in a subfolder, with both extensions enabled.
6. The Settings page has a place to connect a git repository that holds customization, extensions and settings.

## Success criteria

- With no repository connected, the Extensions page lists no extensions and points to Settings. The product bundle `apps/desktop/web-dist-browser` contains neither extension's code; a test inspects the bundle.
- In Settings, the user connects a repository by location, branch and subdirectory. The connection is the same in every launcher profile on that machine.
- With the example customization connected and applied, the Extensions page lists Crew and Coworkers, both enabled.
- Turning one extension off creates one commit in the connected repository that changes only that reference's `enabled` value, and pushes it. A test repository shows the commit on its remote branch.
- After the build finishes and the user applies it, the host restarts with the new build, the client reconnects and reloads by itself, and the disabled extension's agents are absent from the agent list.
- The same flow works against a host started through the launcher's SSH path. An automated test drives it with the existing fake `ssh` on `PATH`; a manual run against a real remote host is recorded or stated as not run.
- Changing Appearance or the default agent in Settings creates one commit in the connected repository and takes effect in the client without a restart. A second client that loads later uses the same values.
- After the AgentUI checkout is rebuilt with a different SDK or host build, the launcher still starts the host, and the page offers a rebuilt customization to apply.
- In the Crew workspace, Delete retires a member. In the Coworkers workspace, New coworker creates one and Delete removes one, when the connected crabber-coworkers runs with `api.manage_coworkers: true` on the local backend. A `config.json` coworker cannot be deleted.
- `npm run verify` passes. `cargo test` passes in `apps/desktop/src-tauri`.

## Scope

In scope:

- Source-model additions: a same-repository reference, an `enabled` flag on references, installation grants, and a settings file.
- Making `extensions/crew` and `extensions/coworkers` buildable as referenced customization packages.
- An example customization package in this repository.
- Removing default bundling.
- A customization worker on the launcher machine: clone, commit, push, builds, upload to a remote host.
- Host relay operations, apply by host restart, and client reconnect and reload.
- Settings and Extensions UI, appearance and default-agent settings.
- Crew retire, Coworkers create and delete, in all three repositories.

Non-goals:

- Live application of a new build without a host restart.
- A host that was not started by the launcher (`serve` run by hand). It reports the feature as unavailable.
- iOS.
- Editing references (add, remove), service addresses, token variables or installation grants from the UI.
- Settings other than appearance, the extension-views switch and the default agent.
- Update of a Crew member or a coworker.
- Pairing, invites, device credentials or attestation. `AGENTS.md` forbids them.
- Force pushes or history rewrites.

Constraints:

- `tests/extensions/providers/conformance/boundaries.test.mjs` fails on `crew`, `coworker` or `crabber` in tracked files under `apps`, `packages`, `scripts` or `templates`.
- Customization builds read committed snapshots only (`packages/host/src/customization/repository.ts`).
- Server artifacts may import only `@agentui/sdk` from the host. The host loads one only when its SDK version, Node version, Node module ABI and SDK ABI identity match the running host (`packages/host/src/customization/server-artifact.ts`, `apps/host/src/server-artifact-runtime.ts`).
- The host reads `--assets` once at startup (`apps/host/src/server.ts`).
- The SSH release contains only the host bundle, the browser assets and `session.mjs` (`scripts/agentui-launch.mjs`, `deploy`). The session wrapper must stay one self-contained file.
- Tokens never go into a repository, a wire reply, a state file or a log. Git credentials stay ambient on the launcher machine (SSH agent, credential helper).
- No new environment variable may use the `AGENTUI_EXTENSION_` prefix; the host treats that namespace as tokens.

## Findings that drive the design

Verified in this repository at `ddd473f`:

- `parseCustomizationPackage` (`packages/host/src/customization/contract.ts`) allows exactly the keys `extension`, `sources`, `shared`, `extensions`. A reference is `{ repository, commit, subdirectory? }` with a full commit ID. `sources` must map every manifest module. `parseGitExtensionReference` is also used by refresh requests (`apps/host/src/refresh-jobs.ts`) and the builder's IPC source.
- `resolveCustomizationSources` (`packages/host/src/customization/sources.ts`) shares one snapshot per repository address and commit. A committed file cannot name its own commit.
- Both extension manifests declare a `server` entry but map only the desktop source. Their server code imports values from `@agentui/contracts`, which the server-artifact builder rejects.
- `scripts/bundled-extensions.mjs` puts every `extensions/*` package into the default desktop build.
- `scripts/prepare-customization-sources.mjs` copies the whole repository and runs `npm ci` per owning npm directory from a private empty cache, with 120 seconds per install and a 600-second overall deadline. Source resolution has its own 600-second budget (`packages/host/src/customization/budget.ts`). The desktop build and the server build each run a full preparation.
- `scripts/build-local-customization.mjs` builds the whole desktop application from the builder checkout plus the customization, and qualifies it in Chromium. The builders never replace an existing output directory.
- The launcher runs `npm ci && npm run build` on every start by default, so the host build and the SDK ABI identity can change between sessions.
- `ownership: "transient"` accepts `kind: "artifact"` entries with installations (`apps/host/src/server-extension-config.ts`). Its `authentication()` reads the token value while validating. The `desktop` command accepts `--extensions`.
- No code in `apps`, `packages` or `scripts` writes to a git repository.
- The service wire has no operation for settings, customization, selection or refresh.
- `scripts/agentui-launch-session.mjs` starts the host with inherited standard output and exits when the host exits. `waitForHost` in `scripts/agentui-launch.mjs` parses the host's ready line from the session output and checks the host artifact ID. The launcher sends one JSON line of secrets on the session's standard input.
- The launcher keeps running for the whole session and can call service operations on the host, locally or through the SSH port forward (`apps/host/src/service-endpoint.ts` accepts a caller with the right `Origin` and `Host`).
- Local and remote hosts run the same pinned Node version. The server-artifact check has no platform or architecture part.
- The data directory is `join(setup.root, 'data', profile.id)`, and `profileFor` hashes target, workspace and agent. State kept there is per profile.
- The client cannot choose appearance today: `Shell.tsx` passes no `appearance` to `ThemeScope`, which follows the system. `Enable customizations` is an in-memory boolean. No settings are persisted.
- `ApplicationController.create` uses `agentId ?? host.defaultAgentId`. Models are separate agent descriptors. The host's default agent is fixed at startup.
- On `ServiceConnectionLost` the desktop controller pauses and offers a manual `Reconnect`. The client never detects new assets. The Mac app allows navigation only to the exact launch URL.
- Native turn activity is a private counter in `packages/host/src/local-host.ts`.

Verified upstream: Crew has no retire route. crabber-coworkers has no create or delete route and loads coworkers from `config.json` at startup.

## Key decisions

| # | Decision | Reason | Rejected alternative |
|---|---|---|---|
| D1 | The connected package's `agentui.extensions` list is the source of truth for which extensions are enabled. Each reference gains `enabled`. | The list exists and supports subdirectories. A flag keeps a disabled extension visible on the page. | A separate enablement file; removing the reference. |
| D2 | A same-repository reference, `{ "subdirectory": "…" }`, resolves in the parent's snapshot. It is a new committed-reference type; `GitExtensionReference` stays remote-only. | A committed file cannot name its own commit. Refresh requests must keep requiring a remote reference. | Pinning an earlier commit of the same repository. |
| D3 | Installation grants live in the root package under a new `installations` key. Settings live in a separate file, `agentui-settings.json`, beside the package's `package.json`. | Grants and settings have no secret in them. A separate settings file is rewritten whole, so no in-place JSON edit is needed for it, and a settings commit does not change the build inputs of a package without a local extension. | The setup-root `extensions.json`; settings inside `package.json`. |
| D4 | A customization worker on the launcher machine owns the clone, every git write and every build. It keeps its state under the launcher machine's setup root, shared by all profiles. | The checkout, the build toolchain and the user's git credentials are on the launcher machine, for local and SSH sessions alike. | Building on the host machine: remote releases carry no checkout or toolchain. Per-profile state: the user would connect once per workspace and agent. |
| D5 | The host relays. Client operations queue requests for the worker and return at once. The worker pulls requests and pushes status. | A commit, push or build outlasts the 20-second native transport deadline. The host is the only thing every client can reach. | Clients calling the launcher directly. |
| D6 | A toggle commits and pushes to the connected branch, never with force. | The user chose commit and push. | Commit only. |
| D7 | Builds are keyed by a build key that covers the customization inputs and the builder's identity (host artifact ID, SDK ABI identity, SDK version, wire version). A build whose builder identity differs from the running host build is never started. | An AgentUI update changes what the host accepts. Without this, an old applied build stops the host from starting. | Keying builds by commit. |
| D8 | Applying a build restarts the host under the session wrapper with new `--assets` and `--extensions`. For an SSH host the worker uploads the build first. | Assets are read once at startup; a restart reuses existing flags. The release upload path already exists. | Live swap. |
| D9 | Default builds contain no extensions. `scripts/bundled-extensions.mjs` survives only as test support. | This is the "closer to previous" behaviour the user asked for. | Keeping bundling as a fallback. |
| D10 | Appearance and the default agent apply in the client, from the settings the worker reads at the connected head. | Both can change without a host restart: `ThemeScope` takes `appearance`, and `create` takes an agent ID. | Changing the host's startup default agent: needs a restart and changes the profile. |
| D11 | Delete means retire for both services, with the same semantics: the agent is hidden from the default list and can start no new conversation, its conversations and history are kept and stay readable, and the action cannot be undone. | Crew's design forbids deleting a member. The owner asked on 2026-11-18 that coworker delete be similar to Crew delete. | Hard delete in either service. |
| D12 | `@agentui/sdk` re-exports `canonicalJson` and `parseScope`. | Server artifacts may import only `@agentui/sdk` from the host. | Copying the helpers; widening the import policy. |
| D13 | The worker runs git with hooks disabled, `user.useConfigOnly=true` and `LC_ALL=C`, and honours the user's commit-signing configuration. | Hooks from a global configuration must not run in the worker's clone. An auto-detected identity must not be used. Failure causes are read from git output, so the locale is fixed. A protected branch may require signed commits. | Disabling signing. |

## Target flow

```text
Launcher machine                                   Host machine (same, or remote over SSH)
┌──────────────────────────────┐   service ops over the local or forwarded port
│ launcher                      │──────────────────────────────────────────────┐
│  └ customization worker       │  worker-pull (long poll)  ◄── queued requests │
│     clone, commit, push       │  worker-push (status, results) ──► host relay │
│     builds/<build key>/       │                                               │
│     upload build (SSH only) ──┼──► <setup root>/customization/builds/<key>/   │
└──────────────────────────────┘                                    host ◄─────┘
                                                     writes launch.json, exits 75
Clients (browser, Mac app)                          session wrapper restarts the host
  status / connect / toggle / settings / apply ──►  with --assets and --extensions
  reconnect, then reload when the artifact changed
```

## Risks and assumptions

- R1. The server-artifact bundler may not bundle `@birbcrew/client/agui` and `@ag-ui/client` without `require` calls. WP1 proves it first and stops if it fails.
- R2. A cold `npm ci` of the AgentUI workspace may exceed the preparation deadlines. WP6 makes both deadlines parameters, gives the worker a persistent npm cache, prepares once for both builds, and measures one real build.
- R3. A build takes minutes and needs the npm registry. The page shows progress, and a build survives or is cleanly restarted after a launcher restart.
- R4. Pushing can fail. The plan defines one fixed cause per failure and never forces.
- R5. Any client on the overlay network can make the launcher machine commit, push and build, and can impersonate the worker. This matches the trust boundary in `AGENTS.md`, where clients already run agents with shell access. WP4 documents it.
- R6. A build that cannot start must not leave the user without a host. The wrapper falls back on every start.
- R9. The worker's builds use the AgentUI checkout while a second launcher start may rebuild it. The launcher skips its rebuild while a build runs, and a build whose builder identity changed is discarded (WP6).
- R10. A stale lock or a reused process ID must never block the store or kill an unrelated process. The lock records its owner, and cleanup checks process start times (WP5, WP6).
- R7. The example lives in the AgentUI repository, so connecting it makes the worker push to an AgentUI branch. The documentation names a dedicated branch or a fork as the supported use, and the UI asks for confirmation before it uses `main` or `master`.
- R8. Extension source at the connected commit must target the running host's SDK version. After an SDK bump the connected branch must be updated. The build reports a fixed cause for the mismatch.
- Assumption A1. The connected branch accepts pushes from the launcher user's ambient git credentials.
- Assumption A2. One customization repository is connected per launcher machine.
- Assumption A3. Several launcher sessions may run on one machine. Their workers share one store through an owned lock and one build slot.

## Unresolved decisions

- U1 (blocking for WP12 only). The two proposed owner decisions in the crabber-coworkers request (management switch, local backend only). Owner: Matt, in the crabber-coworkers response. WP12 builds against the answers.
- U2 (resolved on 2026-11-18). The owner confirmed that Crew Delete as retire is acceptable: the member is hidden and can start no new conversation, its history is kept, and the action cannot be undone.

## Stop/go gates

- G1. Before WP3: WP1's bundling proof passed (risk R1), and WP2 is merged.
- G2. Before WP7: one real worker-run build of the example customization completed within the limits (risk R2), with the duration of each phase recorded in the pull request.
- G3. Before WP10: WP9 delivered, and the Crew response file names an exact commit and a packed client tarball at that commit.
- G4. Before WP12: WP11 delivered, the crabber-coworkers response file names an exact commit and answers both proposed decisions, and WP12 advances `extensions/coworkers/openapi/REVISION` to that commit.

## External requests

| Request | Owner | Consumers | Blocks | Unblock evidence |
|---|---|---|---|---|
| `$HOME/.agents/projects/crew/requests/2026-11-18-member-retire.md` | Matt, Crew | Planned: AgentUI WP10. None demonstrated. | WP10 only | Response at `$HOME/.agents/projects/crew/responses/2026-11-18-member-retire.md` with accepted items, a 40-character commit and a packed tarball at that commit. |
| `$HOME/.agents/projects/crabber-coworkers/requests/2026-11-18-coworker-create-and-delete.md` | Matt, crabber-coworkers | Planned: AgentUI WP12. None demonstrated. | WP12 only | Response at `$HOME/.agents/projects/crabber-coworkers/responses/2026-11-18-coworker-create-and-delete.md` with accepted items, answers to both proposed decisions and a 40-character commit. |

Both requests are proposals. Neither is accepted or implemented. The owner of this repository owns both upstream repositories and asked for the changes, so the upstream work is part of this plan as WP9 and WP11. No new repository is proposed.

## Document map

| File | Purpose |
|---|---|
| [00-overview.md](00-overview.md) | Status, context, decisions, gates. |
| [01-referencable-extensions.md](01-referencable-extensions.md) | WP1: make the two extension packages buildable as referenced customization packages. |
| [02-source-model.md](02-source-model.md) | WP2: same-repository references, the `enabled` flag, `installations`, and the settings file. |
| [03-example-and-unbundling.md](03-example-and-unbundling.md) | WP3: the example customization and removal of default bundling. |
| [04-host-relay-and-worker.md](04-host-relay-and-worker.md) | WP4 and WP5: relay operations and host state; the worker's connection, git writes and settings commits. |
| [05-builds-and-apply.md](05-builds-and-apply.md) | WP6 and WP7: worker builds, delivery to the host, apply by restart, client reconnect and reload. |
| [06-settings-and-extensions-ui.md](06-settings-and-extensions-ui.md) | WP8: Settings sections, Extensions page, appearance and default agent. |
| [07-agent-delete-and-create.md](07-agent-delete-and-create.md) | WP9–WP12: upstream retire, create and delete, and their adoption. |
| [08-execution-handoff.md](08-execution-handoff.md) | Order, verification, definition of done, WP13 documentation. |
