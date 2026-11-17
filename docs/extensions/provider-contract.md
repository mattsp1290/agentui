# Provider contract as implemented

This page states what a provider extension can rely on and what it must do.
It describes the code on `main`, not a plan.
The executable specification is the conformance suite in [`tests/extensions/providers/conformance/`](../../tests/extensions/providers/conformance/).
The type reference and the design history live in [provider-contracts.md](../architecture/provider-contracts.md) and [extension-sdk.md](../architecture/extension-sdk.md).

## Sources

| Concern | Source |
| --- | --- |
| Provider types | `packages/sdk/src/providers.ts` |
| Presentation types and credential use | `packages/sdk/src/provider-presentation.ts` |
| Registry, status causes and fixed reasons | `packages/host/src/providers.ts` |
| Command capture and outcome recording | `packages/host/src/provider-commands.ts` |
| Observation, checkpoints and decisions | `packages/host/src/provider-stream.ts` |
| Generation replacement | `packages/host/src/extensions/index.ts` |
| Host startup, `discoverProviders()` and `replaceProviderExtensions()` | `apps/host/src/server.ts` |
| Advertised agent commands | `apps/host/src/api.ts` |

## Lifecycle

1. The host imports a server entry and calls `activate(context)` once per generation.
2. The entry registers each provider with `context.providers.add(id, provider, presentation)` during activation. Registration after activation throws.
3. `activate` returns a lifetime with `dispose()`. Any other value fails activation.
4. The host calls `provider.connect({ apiVersion, instance, credential })`. The provider returns `connected` with a backend, or a failure.
5. The host calls `backend.discover()` and lists each discovered agent in metadata.
6. Creating a conversation calls `backend.create`. Confirmation starts one observation feed for that conversation.
7. Commands call `backend.submit`. Recovery calls `backend.reconcileCreation` or `backend.reconcileCommand`.
8. Shutdown, disable and reload close every feed, call `backend.close()` once, then call `dispose()` once.

A restart resumes each saved conversation with `observe({ binding, after })`, where `after` is the last committed cursor.
The host takes a fresh snapshot only when no checkpoint exists or the feed ends with `resync`.

`replaceProviderExtensions(entries)` swaps the whole generation.
An empty selection disables every provider. It sends no remote command.
A replacement returns `replaced`, `deferred` (`active-work` or `changing`), `failed` or `unavailable`.
An open observation feed is not active work. Admitted creation, command, lookup and discovery calls are.
After `replaced`, saved conversations of a matching installation resume from their checkpoints.
A conversation whose provider is gone stays readable and reports `This conversation’s provider is no longer configured.`

## Operations

| Operation | Backend call | Host command | Advertised when |
| --- | --- | --- | --- |
| Create | `create`, then `reconcileCreation` | `create(scope, agentId)` | `create` is supported. Otherwise the agent is listed unavailable. |
| Send | `submit({ kind: 'send' })` | `send` | `send` and `reconcile` are supported. |
| Cancel | `submit({ kind: 'cancel' })` | `cancel` | `cancel` and `reconcile` are supported. |
| Decide | `submit({ kind: 'decide' })` | `approve` with a choice | `decide` and `reconcile` are supported. |
| Observe | `snapshot`, `observe` | watch | `observe` is supported. |

A provider without `reconcile` advertises no commands.
An unadvertised cancel or approval is refused at admission with `provider-command-unavailable`. It never reaches the backend.
Fresh dispatch rechecks the current capability.
A provider owns its own identifiers. The host never interprets `opaqueId`, `opaqueSessionId` or cursor contents.
Decisions reach the host only through `snapshot.decisions`. Each choice reference must belong to its decision.
Transcript output and run outcomes come only from snapshots and `apply` events. Command effects carry no output.

## Status and outage

`discoverProviders()` reports each installation as `available` or `unavailable` with one cause.

| Backend result | Cause | Fixed reason |
| --- | --- | --- |
| `unavailable` | `offline` | The provider service is offline or unreachable. AgentUI checks again automatically. |
| `authentication-failed` | `authentication-failed` | The provider rejected the configured credential. Fix it on the provider and AgentUI checks again automatically, or change the extension secret and restart the host. |
| `unauthorized` | `unauthorized` | The configured credential is not authorized for this provider. Grant it access; AgentUI checks again automatically. |
| `version-unsupported`, `unsupported` | `version-unsupported` | The provider service version is unsupported. Install a compatible version; AgentUI checks again automatically. |
| Thrown error, malformed result, identity mismatch | `invalid-installation` | The provider installation is invalid. Fix the extension configuration, then restart the host. |

The provider's own reason text is never shown.
An unavailable provider stays listed with its reason. Its existing conversations show the same reason.
Other providers and native agents keep serving.
Every cause except `invalid-installation` is retried on the next discovery.
Metadata and conversation reads start a background discovery when the last one is at least 30 seconds old.

## Reconciliation and uncertainty

The host persists the creation intent and the exact command before calling the backend.
The operation ID and body never change across retries, restarts or replacements.
`reconcile*` reads evidence for the original operation. It never dispatches again.
A missing record is not proof of nonacceptance. Return `uncertain` instead.
A thrown error is recorded as uncertainty, never as rejection.
`not-dispatched`, `unsupported` and failures from a fresh call mean the provider knows the invocation was not accepted.
An uncertain send stays uncertain until a client `reconcile` request settles it through `reconcileCommand`.
Before admitting a new send, the host looks up a previous send whose receipt is `pending` or `accepted`. It refuses with `send-awaiting-confirmation` while that receipt stays `pending` or `accepted`.
An `uncertain` send does not block a new send. The provider must refuse a send it cannot accept alongside unresolved work.

## Observation

A feed delivers `snapshot` and `event` items through `receive`.
`receive` resolves only after the host commits the item. The provider waits for it before delivering the next item.
Every cursor and snapshot binding must equal the observed conversation's binding.
Decoders must return the value they were given. The host refuses a decoder that changes a saved value.
Items and saved state are limited to one million encoded bytes.
`close()` is idempotent and ends the feed with `closed`. `ended` never rejects.
An expired or unbridgeable cursor ends the feed with `resync`.

## What providers must never do

- Read or send a secret outside `context.credentials.use({ credential, service }, action)`.
- Put a secret, credential or exception text in a model value, reason, evidence or presentation output.
- Register a provider after activation, or reuse a backend after `close()`.
- Redispatch an operation from `reconcile*`, or turn a missing record into `rejected`.
- Reuse another conversation's or installation's references, cursors or bindings.
- Cancel remote work because a feed or backend was closed.
- Forward host trace context or collector headers to the provider service.

## Conformance suite

The suite drives each row only through its public extension entry, the real host from `apps/host/build/tsc/server.js` and the desktop client.

| Row | Request ids | Cursor | Event encoding | Controls |
| --- | --- | --- | --- | --- |
| Crew example (`examples/crew`, shared controlled Crew service) | AgentUI operation UUIDs | `{ epoch, sequence, requests }` | SSE AG-UI, folded into authoritative snapshots | cancel, decide |
| Ledger fake (`ledger.mjs`) | Service-assigned `room-n` and `ticket-n` | `[epoch, offset]` | NDJSON log entries folded by `apply` | cancel, decide |
| Ledger fake without controls | Same as ledger | Same as ledger | Same as ledger | none |

Each row runs create, send and stream, restart with resume, lost-reply reconciliation, cancel, approve and deny, disable and reload, and outage.
Every case runs beside the other provider. Every case except outage asserts the peer has no effects; outage asserts the peer still creates a conversation.
`instrument.mjs` counts host calls through the public contract: activations, connects, closes, disposes and open feeds per conversation.
Service counters assert one backend effect per operation and one subscription per conversation.
`boundaries.test.mjs` asserts that provider traffic carries no trace context or collector headers, that telemetry carries no prompt, reply or provider secret, and that no AgentUI agent span is synthesized for a remote run.
It also asserts that `apps` and `packages` source contains no Crew reference and that the repository contains no OpenBot code or dependency.

## Generic consumers and clients

The MCP read example (`examples/mcp-control/read`) inspects both providers' conversations through `/native/v1`. It has no provider-specific code. `boundaries.test.mjs` runs it against the conformance host.
The suite uses `createBrowserConnection` and `createConversationStore` from `@agentui/client`. The desktop application builds the same pair in `apps/desktop/src/application/use-application.ts` and `application-controller.ts`. The Tauri shell reaches the same service through `/native/v1`.
No pet example exists yet. Bean `agentui-xnk5` tracks it.
The iOS app cannot reach a host until bean `agentui-3xme` lands. The suite does not cover iOS.
