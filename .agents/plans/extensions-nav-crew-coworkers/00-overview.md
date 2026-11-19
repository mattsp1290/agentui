# Extensions navigation with Crew and Coworkers extensions

Status: Ready for WP1–WP8 and WP11. Upstream work packages U-Crew and U-Coworkers wait for owner decisions U3 and U2. WP9 and WP10 wait for those deliveries (see [External requests](#external-requests)).

No implementation has occurred. This directory is a plan only.

## Application context

```json
{
  "application_context": {
    "has_active_users": false,
    "backward_compatibility_required": false,
    "feature_flags": "not-applicable",
    "confirmation_digest": "34b9a519ecefc94d75efe4ffa2fc7671cf5c90bb1936dde430a6049a2beb93b4",
    "confirmed_at": "2026-11-18T04:10:00Z"
  }
}
```

The user confirmed these answers in the planning session. Consequences applied in every work file:

- The plan bumps `EXTENSION_SDK_VERSION` and `SERVICE_WIRE_VERSION` without a migration path. Older extensions rebuild.
- The plan moves `examples/crew` without a compatibility alias.
- No work package adds a feature flag.
- The plan changes no stored data format. The catalog filter reads the existing stored installation JSON (WP2). No data migration exists and no downgrade path is promised.

## Change type and affected areas

Change type: new feature that extends two public contracts (extension SDK, service wire) and adds two in-repo extensions.

Affected areas:

- `packages/sdk`, `packages/contracts`, `packages/client` (contracts and client connection).
- `packages/host`, `apps/host` (extension operations, metadata, catalog filter, CLI flag).
- `apps/desktop` (navigation rail, Extensions view, Tauri wire allowlist).
- `scripts` (launcher, bundled-extension build step).
- `examples/crew` (moves to a new top-level `extensions/` directory).
- `tests`, `docs`, root `package.json`.
- Upstream: Crew and crabber-coworkers, through request documents only.

## Requested outcome

1. The vertical navigation rail shows three items: Chats, Extensions, Settings.
2. The Extensions view lists every installed extension. It lists at least Crew and Coworkers.
3. Crew and Coworkers are two separate extensions that live in this repository and use the existing extension platform.
4. The Crew extension has a Slack-style layout. The Coworkers extension has a Teams-style layout.
5. Each extension lets the user create, read, update and delete that service's durable agents and chat with them.
6. A change to Crew or crabber-coworkers is requested only after subagents argued whether it belongs there.

## Success criteria

Local milestone (WP1–WP8 merged):

- A Playwright test finds `Chats`, `Extensions` and `Settings` buttons inside `navigation[name="Workspace views"]`, in that order, and `Extensions` toggles `aria-pressed`.
- With the default desktop bundle and no host extension configuration, the Extensions view lists `Crew` and `Coworkers`, each with the state `Not configured`.
- A browser test asserts the Crew workspace's Slack-style structure (member sidebar, flat message rows) and the Coworkers workspace's Teams-style structure (inner app bar, `Chat` and `About` pills, message bubbles).
- With a fake Crew service configured, the user creates a member, sees it in the Crew sidebar, opens a conversation with it, sends a message and sees the reply, all inside the Extensions view.
- With a fake crabber-coworkers service configured, the user sees the configured coworkers, opens a conversation, sends a message and sees the polled reply.
- `npm run verify` passes. `cargo test` passes in `apps/desktop/src-tauri`.
- The local milestone does not meet the user's CRUD outcome. It delivers create, list and chat for Crew, and list and chat for Coworkers. Update and delete for both, and create for Coworkers, arrive only with the full outcome.

Full outcome (U-Crew, U-Coworkers, WP9 and WP10 merged):

- Crew: the user names a member at creation, reads its instructions, replaces it (edit), and retires it (delete). Replace-then-retire counts as "update" only if the owner accepts it (unresolved decision U3).
- Coworkers: the user creates, reads with instruction text, edits and deletes an API-managed coworker. A `config.json` coworker shows as read-only.

## Scope

In scope:

- A generic extension operation channel from the desktop client through the host to a server extension.
- A workspace-view contribution in the UI extension SDK.
- The Extensions navigation item and view on desktop and in the host-served browser build.
- Bundling in-repo extensions into the default desktop build, and launcher support for a host extension configuration.
- The Crew extension (existing provider plus member operations plus Slack-style view).
- The Coworkers extension (new provider plus coworker operations plus Teams-style view).
- Two upstream request documents.

Non-goals:

- iOS. `apps/ios/src/shell/App.tsx` is a placeholder with no navigation. This plan does not add one.
- Pairing, invites, device credentials or attestation. `AGENTS.md` forbids them.
- Reply streaming for Coworkers. The provider polls.
- Frontend-tool delivery.
- Changing Crew's member immutability or hard-deleting a member.
- Slack or Teams trademarks, logos, product names or copied assets. "Styled after" means layout and colour idiom only.
- Group conversations, channels with several agents, presence, mentions.
- Installing or removing extensions from the UI. The view lists what the build and the host configuration provide.

Constraints:

- `tests/extensions/providers/conformance/boundaries.test.mjs` fails on any case-insensitive `crew` in tracked files under `apps`, `packages`, `scripts` or `templates`. Core code must stay generic. Crew-specific code lives under the new `extensions/` directory.
- The browser CSP is `connect-src 'self'` (`apps/host/src/static-assets.ts`). UI code cannot call Crew or crabber-coworkers directly. Every call goes through the host.
- Service tokens stay server-only. UI code never receives them.
- `npm test` uses an explicit glob list in the root `package.json`. Each new test directory must be added to it.

## Findings that drive the design

Facts verified in this repository at `e5db45f`:

- The platform already covers more than theming. `packages/sdk/src/extensions.ts` defines `ExtensionManifest` with entry kinds `server`, `desktop` and `ios`. A server entry contributes providers through `ProviderContributions.add` and `addAgui`. A UI entry (`packages/sdk/src/react.ts`, `UiExtensionEntry`) contributes `modules`, `contentLayout`, `overrides.transcript` and `overrides.activity`.
- Every UI contribution is scoped to an open conversation. No navigation, view or route contribution exists.
- A theme is not an extension kind. Extensions import `@agentui/theme/react` and `@agentui/ui-primitives/desktop` and nest `ThemeScope` with `colors` overrides. Only `colors` and `appearance` can be overridden.
- The rail is hard-coded in `apps/desktop/src/shell/BrowserApplication.tsx` with `useState<'chats' | 'settings'>`. `DesktopShell` in `apps/desktop/src/shell/Shell.tsx` takes `activeView?: 'chats' | 'settings'`. There is no router.
- The client talks to the host with JSON `POST` operations in the closed union `ServiceRequest` (`packages/contracts/src/service.ts`). No operation reaches a server extension except through provider conversations.
- The Tauri path re-validates every operation in `apps/desktop/src-tauri/src/wire.rs` (`enum Request`, `deny_unknown_fields`, and a scope match). The native transport has a 20-second deadline.
- A server entry cannot read its installation's service origin today. `ServerExtensionContext` has only `namespace`, `providers` and `credentials`. A provider contribution ID must equal a grant `id` (`apps/host/src/provider-credentials.ts`).
- `customizationPlugin` in `scripts/local-customization.mjs` rejects contained sources owned by a package whose name starts with `@agentui/`.
- Desktop UI extensions are compiled in. `apps/desktop/src/application/customization-selection.ts` exports an empty array. `scripts/local-customization.mjs` replaces it for external builds.
- `examples/crew` is a Crew provider, not a UI extension. Its `discover` returns only the one configured member (`examples/crew/src/provider.ts`, `CrewProviderOptions.memberId`). It builds its manifest in code and has no `package.json.agentui.extension`.
- `AgentDescriptor` (`packages/contracts/src/service.ts`) has no installation ID and no provider agent ID. `ConversationCatalogEntry` has only `scope` and `preview`. The `conversations` table stores the installation as JSON, has no time column, and is listed in conversation-ID order.
- `DesktopShell` keeps every view mounted and toggles `hidden`. `ConversationView` holds per-instance draft and guard state and renders an element with a fixed `id`.
- The launcher (`scripts/agentui-launch.mjs`) starts `node apps/host/dist/main.js desktop …`. `COMMANDS.desktop` in `apps/host/src/main.ts` does not list `extensions`.
- `tests/extensions/providers/conformance/ledger.mjs` is a non-AG-UI HTTP provider that runs its own loop inside `observe`. It is the template for a polling provider.
- `SERVICE_WIRE_VERSION = 14` and `EXTENSION_SDK_VERSION = '0.11.0'` live in `packages/contracts/src/compatibility.ts`. About 20 test files and `templates/customization/package.json` pin the SDK version literal.

Facts verified upstream:

- Crew (`origin/main` at `775fd7299d186c2c75d9c59e9285ad66b2631c05`): the durable agent is the member. Members are immutable by trigger. Create and list exist. Single read, name, retire and profile listing do not exist. The gateway binds to loopback.
- crabber-coworkers (`44ed2ad8326a4822a67a3eeca4087cfc98f03df8`): coworkers come from `config.json` at startup. Only `GET /v1/coworkers` exists for them. Chat is submit-then-poll. The API binds to loopback unless `api.allow_remote` is true.

## Key decisions

| # | Decision | Reason | Rejected alternative |
|---|---|---|---|
| D0 | Expose each namespace's configured installations to its server entry (`ServerExtensionContext.installations`). | Without it a server entry cannot learn its service origin, so no entry can be configured from the host configuration file alone. | Hard-coded origins in extension source. |
| D1 | Add a server contribution `operations` and a service operation `extension-call`, with a 15-second host deadline. | Member and coworker management needs host-held credentials and cannot go through conversation commands. | A Crew-specific host route: breaks the boundary test and helps no other extension. Direct browser calls: blocked by CSP and would expose tokens. |
| D2 | Chat inside an extension uses the existing provider and conversation machinery. The host renders the conversation and passes it to the workspace view as an opaque node. | Durable sends, receipts, recovery, approvals and continuation already work for provider conversations. `contentLayout` already uses the opaque-node pattern. | A second chat stack inside each extension: duplicates the outbox and loses recovery. |
| D3 | Add a UI contribution `workspace` with its own optional `transcript` component. | Two extensions cannot both claim the global `overrides.transcript`; the host then keeps the default. A workspace-scoped transcript avoids that conflict. | Global transcript overrides. |
| D4 | One active conversation for the whole application, mounted in exactly one view at a time. Opening a conversation in an extension view changes the same `active` conversation the Chats view shows. | `ApplicationController` owns one `active`. The SDK states that layouts do not create independently active conversations. | Per-view active conversations: a controller redesign outside this request. |
| D5 | Put in-repo extensions in a new top-level `extensions/` directory. Move `examples/crew` to `extensions/crew`. | The user asked for extensions contained in this repository. `extensions/` is outside the boundary test's `crew` scan. | Keep the provider in `examples/crew` and add a second Crew package: two packages for one namespace. |
| D6 | The Crew provider discovers every member, not one configured member. | The view needs one agent per member. | One installation per member in the host configuration: creation from the UI could not add an installation. |
| D7 | Coworkers reply delivery polls inside `observe`, through one scheduler per installation with a request budget. | The upstream AG-UI route is deferred. The host observes every saved conversation, so unbudgeted polling would grow without bound. | Waiting for upstream streaming. |
| D8 | Crew "update" is replace-then-retire. Crew "delete" is retire. | Crew's recorded design fixes instructions at spawn and forbids deletion. See [07-upstream-requests.md](07-upstream-requests.md). | Requesting mutable instructions or hard delete. |
| D9 | Styling uses a nested `ThemeScope` plus an extension-owned stylesheet file. | Spacing, radius and typography tokens are fixed, so layout idiom needs CSS. The Tauri CSP forbids inline styles. | Adding new theme token roles: wider change with no second consumer. |
| D10–D13 | Bundling rule, working-tree server entries, package names outside `@agentui/`, local-host-only bundled server extensions. | See [04-bundled-extensions-and-launch.md](04-bundled-extensions-and-launch.md). | See that file. |
| D14 | The conversation filter reads the installation stored with each conversation, with no schema change. | Retired, deleted and replaced agents keep their conversations in the workspace. No migration is needed. | Filtering by current agent descriptors: drops those conversations. A new indexed column: a schema change for a single-user data set. |

## Target architecture

```text
Desktop / browser client                        Host process                     Service
┌──────────────────────────────┐   POST /api/v1 or /native/v1
│ rail: Chats│Extensions│Settings│
│ Extensions view               │
│  ├ list of namespaces         │   op: metadata  ─────────► extensions[] + agents[]
│  └ workspace(component)       │   op: extension-call ────► operations registry ──► server entry
│      props.call()             │                              (namespace, installation)   │ credentials.use
│      props.agents             │                                                          ▼
│      props.conversations      │   op: catalog(agent filter)                       Crew / crabber-coworkers
│      props.conversation ◄─────┼── host-rendered ConversationView
│      (opaque node)            │   op: create / submit / watch … ─► provider (existing path)
└──────────────────────────────┘
```

Before: a UI extension can only decorate an open conversation. After: a UI extension can also own a full view, call its own server entry, and place the host's conversation inside its layout.

## Risks and assumptions

- R1. `startBrowserHost` with `agentStartup.kind = 'desktop'` plus `extensions` has not been exercised together. WP4 starts with a test that proves it or reports the conflict.
- R2. Closed by decision D14. WP2 confirms the JSON paths in a stored row before it writes the query.
- R3. Closed. The vendored `@birbcrew/client` tarball already contains `createMember`.
- R4. Crew and crabber-coworkers bind to loopback by default. A host on another machine needs the operator to expose them on the overlay network. crabber-coworkers also requires a TLS-terminating proxy when `api.allow_remote` is true. That setup is documentation in WP11, not code.
- R5a. A `credentials.use` action that never settles holds generation close. Operations must honour `signal`; WP5 and WP7 test it.
- R6. The host catalog has no activity time. Workspace conversation lists are in conversation-ID order and make no recency claim.
- R7. Local-milestone tests run against fake services. WP5 and WP7 each include a live qualification run, or an explicit statement that it did not happen.
- R5. A full-trust extension's operation handler can run arbitrary host code. This matches the existing trust statement in `docs/architecture/extension-sdk.md`.
- Assumption A1. A `config.json` coworker list is small enough to return in one `GET /v1/coworkers` response, as the upstream route has no pagination.
- Assumption A2. Slack-style and Teams-style mean layout and colour idiom. The owner can correct the visual direction during review of WP6 and WP8.

## Unresolved decisions

- U1 (non-blocking). Whether Crew adds a mutable member label for rename. Owner: Matt. The plan does not depend on it.
- U2 (blocking for U-Coworkers and WP10 only). How API-managed coworkers reach a borb worker, and whether the single operator token may manage coworkers. Owner: Matt, in the crabber-coworkers response.
- U3 (blocking for U-Crew and WP9 only). Whether replace-then-retire satisfies "update" for Crew members. The user asked for update. Crew's recorded design fixes a member's instructions, engine and profile. The plan's edit creates a new member with a new ID and leaves grants, memory, routines and budgets with the retired one. Owner: Matt. Unblock action: answer yes, or choose another option, in the Crew response file or in the session that starts WP9.

## Stop/go gates

- G1. Before WP3: WP1 and WP2 are merged and `npm run verify` passes.
- G2. Before WP9: U-Crew is delivered, the Crew response file names an accepted contract and an exact commit, the packed client tarball is vendored, and U3 is answered.
- G3. Before WP10: U-Coworkers is delivered, the crabber-coworkers response file names an accepted contract, an exact commit, and the owner's answers to both parts of U2.

## External requests

| Request | Owner | Consumers | Blocks | Unblock evidence |
|---|---|---|---|---|
| `$HOME/.agents/projects/crew/requests/2026-11-17-member-management-for-agentui.md` | Matt, Crew | Planned: AgentUI WP9. AgentUI is a demonstrated consumer of Crew's existing routes only. Prospective: Birbforge interface. | WP9 only | Response at `$HOME/.agents/projects/crew/responses/2026-11-17-member-management-for-agentui.md` with accepted items and a 40-character commit; tarball under `vendor/crew-client/<commit>/`. |
| `$HOME/.agents/projects/crabber-coworkers/requests/2026-11-17-coworker-management-api.md` | Matt, crabber-coworkers | Planned: AgentUI WP10. None demonstrated. | WP10 only | Response at `$HOME/.agents/projects/crabber-coworkers/responses/2026-11-17-coworker-management-api.md` with accepted items, both owner decisions and a 40-character commit. |

Both requests are proposals. Neither is accepted or implemented. No new repository is proposed. The owner of this repository owns both upstream repositories, so the plan includes the upstream work as packages U-Crew and U-Coworkers ([07-upstream-requests.md](07-upstream-requests.md)).

## Document map

| File | Purpose |
|---|---|
| [00-overview.md](00-overview.md) | Status, context, decisions, gates. |
| [01-extension-operations.md](01-extension-operations.md) | WP1: `installations` and `operations` on the server context, and the `extension-call` wire operation. |
| [02-agent-identity-and-catalog.md](02-agent-identity-and-catalog.md) | WP2: provider identity on `AgentDescriptor` and catalog entries, and a provider filter on `catalog`. |
| [03-workspace-views-and-navigation.md](03-workspace-views-and-navigation.md) | WP3: `workspace` UI contribution, rail item, Extensions view. |
| [04-bundled-extensions-and-launch.md](04-bundled-extensions-and-launch.md) | WP4: `extensions/` directory, move of the Crew provider, desktop bundling, launcher flag. |
| [05-crew-extension.md](05-crew-extension.md) | WP5, WP6, WP9: Crew server operations, Slack-style view, upstream adoption. |
| [06-coworkers-extension.md](06-coworkers-extension.md) | WP7, WP8, WP10: Coworkers provider, Teams-style view, upstream adoption. |
| [07-upstream-requests.md](07-upstream-requests.md) | Debate verdicts, the request map, and upstream work packages U-Crew and U-Coworkers. |
| [08-execution-handoff.md](08-execution-handoff.md) | Ordered work packages, verification, definition of done, WP11 documentation. |
