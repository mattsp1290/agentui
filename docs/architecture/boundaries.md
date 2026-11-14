# Architecture boundaries

AgentUI owns conversation coordination and customization deployment. It consumes native harness interfaces from Switchboard and keeps its extension SDK separate.

## Package ownership

| Package | Responsibility | Type environment |
| --- | --- | --- |
| `@agentui/contracts` | Conversation scope, provider identity, run authority | ES2023 only |
| `@agentui/protocol` | Published AG-UI SDK types and availability declarations | ES2023 only |
| `@agentui/sdk` | Full-trust extension entry manifests | ES2023 only |
| `@agentui/sdk/react` | Conversation-scoped React module contracts | React, without DOM |
| `@agentui/theme` | Semantic tokens and inherited theme resolution | ES2023 only |
| `@agentui/theme/react` | Shared theme context | React, without DOM |
| `@agentui/ui-primitives/desktop` | DOM controls and system theme scope | React and DOM |
| `@agentui/ui-primitives/native` | React Native controls | React Native, without DOM |
| `@agentui/host` | Public Switchboard consumption boundary | Node |
| `@agentui/host/agui` | Installed Switchboard AG-UI projection consumer | Node |
| `@agentui/adapter-tests` | Downstream package and boundary checks | Node |
| `@agentui/desktop` | Tauri client entry contracts | React and DOM |
| `@agentui/ios` | React Native client entry contracts | React Native, without DOM |

The app files are compilation probes. No application is mounted.
Modules import the platform primitive package directly; the app entries do not re-export it.
The root owns the browser workbench and its tooling because it checks integration across the theme and primitive packages.
The adapter-test workspace separately owns package and ambient-boundary checks.
Tauri Rust setup and native application lifecycle belong to later tasks.
Each package compiles independently with strict TypeScript.
There are no source aliases. Imports resolve built package exports.
SDK core and React contracts compile separately to keep platform ambient types out of core.

The host is the only application workspace with a Switchboard dependency.
Clients and customization declare no dependency on Node host APIs.
The adapter-test workspace consumes the host public API.
Packaged native adapters remain upstream work. The pinned library provides a
limited AG-UI projection, consumed through the explicit host AG-UI entry.
The [versioned conformance matrix](../protocol/README.md) names installed fixtures
and pending consumers. Transport, replay and product UI consumption remain separate work.
No adapter implementation or agent loop is copied here.

`@agentui/protocol` exports SDK types only. Workspaces constructing SDK events
declare the pinned `@ag-ui/core` dependency and import its `EventType` enum.
Runtime wire validation remains separate from TypeScript assignment checks.

## Run ownership

A conversation scope names its authoritative host and conversation.
Every view receives that scope explicitly.
There is no shared global active conversation.

Each run records one authority.
The authority carries the run's single provider binding, so it cannot disagree with a second session identity.
An AgentUI-hosted run names the executing host, including hosts reached over SSH.
That host persists intent, receipts, ordered events, pending decisions, and uncertain outcomes independently of client connections.
The connecting Mac stores routing references and does not become a second run authority.
The Mac owns its local conversations and desired customization commit.
Its Node host must outlive the Tauri client process.

For a remote provider run, the remote service owns execution and approvals.
AgentUI persists local command intent and observations.
A local receipt does not establish exactly-once execution.
Lost acknowledgement must preserve uncertainty and block automatic retry until reconciliation.
This foundation models ownership without implementing storage or dispatch.

Provider bindings name a namespace, existing installation, and opaque session.
Only AgentUI-created conversations are exposed in v1.
Native discovery does not expand history scope.

## Extension ownership

The SDK declares full-trust server, desktop, and iOS entries.
React module props carry conversation scope.
The shell retains recovery and compatibility controls.

Pets, MCP control, and Crew are the three planned example extensions.
Crew transport, authentication, and cursors belong in `examples/crew` when implemented.
Core host code uses generic provider identities.
Provider lifecycle and frontend-tool APIs remain downstream tasks.
Switchboard and Crew frontend-tool requests are prerequisites, not evidence of delivery.

Committed customization references will include an immutable Git revision and optional contained subdirectory.
The selected commit includes dependency inputs.
All connected clients share the host-selected desired revision.
Actual applied versions can differ while devices are offline or rebuilding.
Rollback cannot undo full-trust extension side effects.

## Build and storage choices

npm workspaces provide linking and one lockfile without an additional build scheduler.
Node 24.22.3 and npm 11.19.1 match the pinned Switchboard requirements.
Independent TypeScript builds keep each package environment explicit.
Project references were considered, but the small dependency graph does not yet need incremental scheduling.
Node's test runner checks public package imports and real Switchboard event delivery.
Ambient-global compiler tests use unsuppressed invalid fixtures and first prove a valid control compiles.

Switchboard is private version `0.0.0`, with no claimed registry release.
The host consumes a [verified tarball from an immutable commit](../../vendor/README.md).
Neither sibling checkout changes nor upstream main changes affect installation.
The [host integration](switchboard-integration.md) qualifies package and controlled
continuation consumption. Native adapters and live providers remain unqualified.
Available library mappings do not qualify AgentUI transport, replay or UI behavior.

SQLite through Node's builtin module is the first storage candidate.
It offers local transactions for host coordination.
No database schema or persistence API is implemented here.
Crash recovery, dispatch admission, and migration checks must qualify it before adoption.

Vite is the desktop build candidate behind Tauri.
Metro is the React Native bundling candidate.
React Native is pinned to 0.86.0 because its public declarations pass strict compilation with this toolchain.
Version 0.88.1 produced three errors inside its generated declarations with library checking enabled.
This pin is package type compatibility evidence, not an Apple runtime qualification.
The v1 iOS update strategy is [rebuild-only](../qualification/ios-updates.md).
The standalone probe qualifies simulator Release rebuild and reinstall, without a Metro server.
Compatible live updates, physical-device signing, and integrated Mac-delivered customization remain unqualified.
No layout or state library is selected.

## Verification limits

`npm run verify` builds emitted exports, checks strict types, lints, and exercises package imports.
It tests platform ambient isolation and real Switchboard observation through the host package.
It does not qualify native execution, proxies, full AG-UI support, authorization, durable dispatch, or reconnect.

All future GitHub Actions jobs use Linux runners.
The Linux workflow installs the pinned toolchain and browser, then runs `npm run verify`.
Browser fixtures qualify the desktop primitives, not a mounted Tauri client.
Local macOS package checks are macOS evidence.
Apple applications need [separate qualification](apple-qualification.md).
