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
2. The entry registers each provider during activation with `context.providers.add(id, provider, presentation)`, or with `context.providers.addAgui(id, provider, presentation, observations)` for an AG-UI provider. Registration after activation throws.
3. `activate` returns a lifetime with `dispose()`. Any other value fails activation.
4. The host calls `provider.connect({ apiVersion, instance, credential })`. The provider returns `connected` with a backend, or a failure.
5. The host calls `backend.discover()` and lists each discovered agent in metadata.
6. Creating a conversation calls `backend.create`. Confirmation starts one observation feed for that conversation.
7. Commands call `backend.submit`. Recovery calls `backend.reconcileCreation` or `backend.reconcileCommand`.
8. Shutdown, disable and reload close every feed, call `backend.close()` once, then call `dispose()` once.

A restart resumes each saved conversation with `observe({ binding, after })`, where `after` is the last committed cursor.
The host takes a fresh snapshot only when no checkpoint exists or the feed ends with `resync`.
One exception: an explicit retry of a stopped observation (`provider-observation` with `action: 'retry'`) always takes one fresh snapshot before it observes again, even when a checkpoint exists.
A feed that ends with `closed`, `disconnected` or `unavailable` leaves the conversation `stopped` with `provider-disconnected`. The host does not resubscribe by itself; a client retry does.

`replaceProviderExtensions(entries)` swaps the whole generation.
It exists only on the in-process handle of a host started with transient extensions. A host with durable extension artifacts refuses it, and production disable and reload go through the extension selection commands instead. Both paths end in the same generation swap.
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
An agent `opaqueId` is visible to clients: provider agent descriptors carry it as `providerAgentId`, and catalog and search entries carry it in `provider`. It must not carry a secret.
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
Before admitting a new send to a provider conversation, the host looks for the oldest previous send whose receipt is `pending`, `accepted` or `uncertain`.
An `uncertain` send whose saved observation is conclusive does not block: the provider reported it finished and only the host's projection of the result failed (`output-rejected`). An `uncertain` send quarantined for `capacity-exhausted` still blocks, because the provider may still be running it.
The host first tries to settle an `accepted` or `uncertain` blocker once through `reconcileCommand`. If no send blocks after that, under the same rule, the new send is admitted.
Otherwise it refuses with `send-awaiting-confirmation` and the new send reaches no provider. While the provider is offline the blocker cannot be settled, so the refusal is `send-awaiting-confirmation`, not `provider-command-unavailable`.
A lost send reply therefore blocks the conversation until reconciliation settles the earlier send. A conversation with a built-in agent driver (Codex, Claude SDK, Pi) records an unknown outcome without blocking later sends.

Reconciliation alone can leave the block in place for good. When a send never reached the provider, its lookup finds no record and stays `uncertain`, so Reconcile cannot settle it, and cancel is refused with `unknown-run` because no run exists.
A blocker can also stay put while `pending` or `accepted`: an offered send whose lookup keeps returning an unknown outcome stays `pending`, and an `accepted` send whose run is lost never reports an end.
The user can then choose **Stop waiting** (the service `abandon` request). It applies only to a provider send that still blocks and that the host would look up before a follow-up: an `uncertain` send without conclusive evidence, an `accepted` send, or a `pending` offered send. It never applies while the host is still dispatching that send. Every other command, including a non-offered `pending` send, is returned unchanged. The host records the receipt as `abandoned` and appends that receipt to the conversation journal as the audit record. The saved observation is kept.
`abandoned` says nothing about whether the send took effect. It is terminal: it never blocks a later send, and no later evidence moves it to another state. The host never calls `reconcileCommand` for an abandoned send, from a client Reconcile, a blocked follow-up or an observed run end. If the provider would have reported it completed, or observation later shows its run and messages, the receipt stays `abandoned` while the observed transcript content is still shown: stopping waiting retracts nothing. For an abandoned offered send, frontend tool calls from its run can still arrive through observation.
The remote may still execute an abandoned send, so keep idempotency on the original request identity; the host never replays it, and the user's next send has a new identity. An in-flight run stays cancellable by its `runId` only while the host has stored that run, from the send's `accepted` evidence before it was abandoned or from observation; a send that never produced a run has nothing to cancel and cancel is refused with `unknown-run`. The host and client never abandon a send on their own.
After upgrading to a host with this rule, a provider conversation that already holds a non-conclusive `uncertain` send starts refusing new sends the same way, until Reconcile settles that send or the user stops waiting on it.

The host also reads status on its own, for every provider. When observation commits a transcript whose current run has ended, and an `accepted` send's evidence names that run, the host calls `reconcileCommand` once for that send. The run end is not settlement evidence; only the returned status settles the receipt. The read counts once the provider admits it, so each send gets at most one automatic read per host process, and a run end committed while the provider is being replaced is read again after the replacement observes. A pending, unknown or failed result leaves the send `accepted` with no further automatic read; a client `reconcile`, a blocked follow-up send or a host restart can settle it later. Report a terminal status before ending the run in observation, or the send stays `accepted` until one of those happens. The automatic read is admitted work, so a replacement requested while it runs returns `deferred` with `active-work`.

## Observation

A feed delivers `snapshot` and `event` items through `receive`.
`receive` resolves only after the host commits the item. The provider waits for it before delivering the next item.
Every cursor and snapshot binding must equal the observed conversation's binding.
Decoders must return the value they were given. The host refuses a decoder that changes a saved value.
Items and saved state are limited to one million encoded bytes.
`close()` is idempotent and ends the feed with `closed`. `ended` never rejects.
An expired or unbridgeable cursor ends the feed with `resync`.

### Polling providers

A service without an event stream can still implement `observe` by polling, as the [Coworkers provider](../../extensions/coworkers/src/provider.ts) does:

- Run one scheduler per installation ([`poller.ts`](../../extensions/coworkers/src/poller.ts)) with an in-flight request limit, a short interval for conversations with unfinished work, a growing interval for idle ones, and a doubling backoff after failed polls. Wake a conversation's feed when the provider submits to it.
- Deliver whole `snapshot` items and make the cursor a digest of the state, so `after` equal to the current cursor delivers nothing until something changes.
- Do not end the feed on a failed poll: the host leaves a `disconnected` feed stopped until an explicit retry. End it only on `close()` or with `resync` when the service reports that the conversation is gone.
- Keep terminal statuses in state so they are never fetched again, and bound the state well under the one-million-byte limit above. A first snapshot has no stored statuses, so it fetches one receipt for each request without a reply (up to 100 for Coworkers, one at a time behind the in-flight limit).
- Present the newest request as `currentRun`. When it ends, the host's automatic run-end read settles the blocking send.

## What providers must never do

- Read or send a secret outside `context.credentials.use({ credential, service }, action)`.
- Put a secret, credential or exception text in a model value, reason, evidence or presentation output.
- Register a provider after activation, or reuse a backend after `close()`.
- Redispatch an operation from `reconcile*`, or turn a missing record into `rejected`.
- Reuse another conversation's or installation's references, cursors or bindings.
- Cancel remote work because a feed or backend was closed.
- Forward host trace context or collector headers to the provider service.

## Conformance suite

The suite runs the real host in process through `startBrowserHost`, the same entry `extensions/crew/run.mjs` uses, with transient extension entries. Each row is driven only through its public extension entry, and clients reach the host through the desktop client store.
Transient entries skip module import and manifest resolution. `extensions/crew/tests/installed-example.test.mjs` covers loading an installed extension.

| Row | Request ids | Cursor | Event encoding | Supports |
| --- | --- | --- | --- | --- |
| Crew example (`extensions/crew`, shared controlled Crew service) | AgentUI operation UUIDs | `{ epoch, sequence, requests }` | SSE AG-UI, folded into authoritative snapshots | cancel, decide |
| Ledger fake (`ledger.mjs`) | Service-assigned `room-n` and `ticket-n` | `[epoch, offset]` | NDJSON log entries folded by `apply` | cancel, decide |
| Ledger fake without controls | Same as ledger | Same as ledger | Same as ledger | none |

`providers.mjs` defines the row type. A row's `supports` set is its only capability source. For each control the suite generates either the supported test or the capability-gated test, never both.
Each row runs create, send and stream, restart with resume, a dropped stream recovered by an observation retry, lost-reply reconciliation, a send blocked behind an uncertain send, cancel, approve and deny, disable and reload, and outage.
Every case runs beside the other provider. Every case except outage asserts the peer has no effects; outage asserts the peer still creates a conversation.

What the suite proves:

- Effects are counted on the wire at each service: every request to an effect route, duplicates and refusals included. A redispatched operation, such as a `reconcileCommand` that submits again, fails the effect assertions on every row. The suite proves one effect for each operation it drives, not for every possible sequence.
- `instrument.mjs` counts host calls through the public contract: activations, connects, snapshots, command lookups, closes, disposes and open feeds per conversation. It wraps both `add` and `addAgui`.
- A restart with a saved checkpoint resumes from that cursor and calls `snapshot` zero times. An observation retry after a dropped stream calls `snapshot` exactly once and leaves one subscription.
- A send to a disabled provider, and a send in a fresh conversation during an outage, are refused with `{ kind: 'rejected', reason: 'provider-command-unavailable' }`. A send behind an unsettled earlier send during an outage is refused with `send-awaiting-confirmation`.
- An outage is reported by discovery, metadata and the conversation. It does not close streams that were already open: they keep delivering. The suite's outage refuses new requests at a proxy, so it does not model a stream that the network cuts.
- A send behind an uncertain earlier send is refused with `send-awaiting-confirmation` after exactly one `reconcileCommand` lookup and reaches no provider. Once reconciliation settles the earlier send, the next send is admitted.
- A send cut at the proxy before it reaches the service stays `uncertain` after an explicit Reconcile, keeps refusing later sends in its conversation, and leaves a new conversation free to send.

`boundaries.test.mjs` asserts that provider traffic carries no trace context or collector headers, that telemetry carries no prompt, reply or provider secret, and that no AgentUI agent span is synthesized for a remote run. A positive control proves the telemetry search finds a value that is exported.
It also asserts that `apps`, `packages`, `scripts` and `templates` contain no case-insensitive `crew` substring, so camelCase or underscore names such as `isCrewProvider` are caught, excluding the one adapter-tests fixture that names `example.crew`, and that the repository contains no OpenBot code or dependency.
The check is lexical. Crew-specific logic that never names Crew would pass. Vendored `.tgz` archives are out of scope; their declared dependencies appear in `package-lock.json`, which is searched.

## Generic consumers and clients

The MCP read example (`examples/mcp-control/read`) inspects both providers' conversations through `/native/v1`. It has no provider-specific code. `boundaries.test.mjs` runs it against the conformance host.
The suite uses `createBrowserConnection` and `createConversationStore` from `@agentui/client`. The desktop application builds the same pair in `apps/desktop/src/application/use-application.ts` and `application-controller.ts`. The Tauri shell reaches the same service through `/native/v1`.
No pet example exists yet. Bean `agentui-xnk5` tracks it.
The iOS app cannot reach a host until bean `agentui-3xme` lands. The suite does not cover iOS.
