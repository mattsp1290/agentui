# Public provider contracts

`@agentui/sdk` exports the version 1 backend provider contract.
The declarations describe provider integrations without Node or DOM types.
The host now activates imported server extensions, authorizes connections, discovers a private catalog, and drains them on shutdown.
Imported providers support conversation creation, sends, approvals, cancellation, observation and chooser integration.
Filesystem loading and generation replacement remain outside this integration.
The host's recorded Switchboard driver remains a separate integration.

## API reference

| Export | Shape and purpose |
| --- | --- |
| `backendProviderContractVersion` | Literal `1`, required as `apiVersion` on providers and connection requests. |
| `ProviderModel` | JSON-compatible semantic `request`, opaque `cursor`, projected `state`, and `event` types. Declare object payloads as type aliases. Interfaces without an index signature do not satisfy the `Json` constraint. |
| `Json` | Canonical JSON-compatible value type re-exported from `@agentui/contracts`. |
| `BackendProvider<M, I>` | Connects one model and installation identity. Returns a `ConnectedProvider` or an explicit failure. |
| `ProviderInstance<I>` | Namespace, literal installation identity, generation, and provider protocol version. |
| `CredentialHandle<I>` | Host-scoped opaque handle tied to an instance. Contains no secret bytes. `null` requires an explicit operator-configured unauthenticated installation. |
| `ProviderRef<I, K>` | Instance-scoped opaque ID with a semantic role. Discovery returns agents, never native conversation history. |
| `CreationIntent<I>` | Immutable host operation ID, allocated `ConversationScope`, and selected agent. |
| `ProviderConversation<I>` | AgentUI-created provenance with captured creation intent and canonical `RunAuthority` whose binding has installation identity `I`. Its authority owns the session binding. |
| `ConversationRef<I, K>` | Run, decision, or choice reference retaining its originating conversation. |
| `ProviderCommand<M, I>` | Captured operation ID and conversation, plus send request, cancel run, or decision and choice. |
| `ProviderOperation<M, I>` | Saved creation intent or command. Narrow by `kind` to route to `reconcileCreation` or `reconcileCommand`. |
| `ProviderCursor<M, I>` | Opaque model cursor bound to a conversation and its instance context. Distinct from host journal numbers. |
| `ProviderSnapshot<M, I>` | Projection version, state, exact cursor, and decisions with explicit run and choice references. |
| `ProviderItem<M, I>` | Snapshot or event with a conversation-scoped event ID and provider cursor. |
| `ProviderFeed<M, I>` | Local `close` and an `ended` promise carrying a reason and last acknowledged cursor, or `null`. |

`ConnectedProvider` exposes discovery, creation, command submission, `reconcileCreation`, `reconcileCommand`, snapshot, observation, and local resource closure.
Its create, send, cancel, decide, reconcile, and observe capabilities are supported or explicitly unsupported with a reason.
The single reconcile capability covers both reconciliation methods.
The methods remain present when unsupported. Actual results describe the invocation even when a capability was previously supported.
Discovery and snapshot support are determined per call by their results.
Read and connection failures distinguish unavailability, authentication failure, authorization denial, incompatible version, and unsupported operation.
Derive request and result types with `Parameters` and `ReturnType`, such as `Parameters<BackendProvider<M, I>['connect']>[0]` and `Awaited<ReturnType<ConnectedProvider<M, I>['discover']>>`.

`ProviderOutcome<T>` distinguishes confirmed evidence with a value, pending processing, authoritative rejection, no dispatch, uncertainty, and explicit failures.
`pending` means the provider accepted the operation for processing but has not confirmed a result value, run, or session binding.
`uncertain` lacks conclusive evidence of acceptance or outcome. Both remain unresolved and cannot authorize replay.
A confirmed command effect records acceptance for execution or completion. Acceptance does not mean terminal execution.

## Authorized connection and discovery

`ProviderPresentation<M,I>` supplies the typed instance, four decoders (`decodeRequest`, `decodeCursor`, `decodeState`, `decodeEvent`), request conversion, transcript snapshots, and `apply(previous, event, refs)` returning the next state and transcript events.
`PresentationRefs<I>.run` translates a conversation-bound provider run to a public `RunIdentity`.
Creation validates the callbacks and opens a saved conversation. The host then persists the provider snapshot and observes subsequent presentation events.
The generic binding retains each concrete model and installation inside a closure; the heterogeneous registry stores normalized discovery, captured creation, reconciliation and close operations.

```ts
activate(context: ServerExtensionContext) {
  context.providers.add('service', makeBackend(context.credentials), presentation);
  return { dispose: releaseResources };
}
const running = await startBrowserHost({
  directory, assetsDirectory,
  providerExtensions: [{ manifest, entry, installations: [{
    id: 'service', instance: presentation.instance, service: 'https://service.example',
    expectedAuthority: 'remote-provider',
    authentication: { kind: 'secret', revision: 'operator-revision-1', resolve: readOperatorSecret },
  }] }],
});
const catalog = await running.discoverProviders(); // Private server catalog; metadata exposes safe agent descriptors.
await running.close();
```

Startup configuration explicitly supplies each contribution's full instance, expected authority kind (`remote-provider` or `agentui-host`), canonical HTTP(S) service origin and secret revision/resolver, or `authentication: { kind: 'unauthenticated' }`.
Origins contain no path, query, fragment, username or password; adapters own routes within that origin.
`service_provider_credentials` stores only opaque grant metadata in the existing access database: host, namespace, contribution, installation, generation, protocol, service, revision and revocation.
The authority borrows that connection and never closes it. Device pairing and native credentials remain independent.
Restart requires matching operator provisioning; handles from missing or revised provisioning are refused, and revoked handles are never reassigned or revived.
The app-side authority supports explicit grant revocation; there is no provisioning or revocation UI in this slice.

`credentials.use({ credential, service }, action)` checks the current activation and complete grant binding before resolving the secret, before invoking the callback, and after it settles.
Connect and discovery likewise check authority around awaited calls.
Provider failures use fixed safe messages rather than provider exception text. Model values and presentation output must be bounded, secret-free JSON.
Discovery validates full instance and reference identity, capabilities, bounded JSON, nonblank names/IDs and duplicates before returning a copied private catalog.
IDs may collide across installations; catalog identity includes the full instance and contribution.
Repeated discovery reuses one connection; overlapping discovery shares its pending call.
Configured extensions are required in this slice: any activation, connection or discovery failure retires the entire collection. Startup then fails; a later failure makes subsequent provider discovery unavailable.
Unsupported, offline, authentication and version failures all become the same sanitized discovery failure here. Per-provider operational status remains downstream work. Discovered agents appear in the existing chooser. Send is advertised only when the provider supports both send and reconciliation. Cancel and approval remain unavailable.

Closing or failure freezes admission and credential use, drains admitted calls, closes acquired or late-arriving connections once, then disposes extension lifetimes before access storage closes.
There is no hard timeout guarantee for uncooperative full-trust code. Full-trust extensions can leak secrets or perform their own effects; this capability is an authorization boundary for cooperating adapters, not a secret sandbox.

## Durable creation

Service wire version 3 adds a tagged provider agent descriptor and the `create-rejected` failure.
Native descriptor bytes and identity hashes remain unchanged; SDK compatibility stays 0.1, package versions stay 0.0 and transcript projection stays 2.
Matching host and client artifacts are required. This change does not deploy or upgrade an existing Mac installation.

The authenticated `create(scope, agentId)` route checks saved creation provenance before local rows or the current catalog.
`LocalHost.createProviderConversation` reserves the immutable selected installation, UUID intent, original credential handle and expected authority in `SqliteStore` before an effect.
It commits attempted status and verifies the original intent before entering `BackendProvider.create`.
Concurrent callers share a local lease; existing intents, including reserved intents after restart, use only `reconcileCreation`.
The registry reconstructs concrete generic references from the validated presentation instance and checks authorization before and after awaited calls.
Confirmation validates the complete original operation, instance, scope and operator-selected authority; host authority additionally requires the local host ID.
The confirmed binding and public conversation commit atomically in the same database.
A failed confirmation commit leaves the original intent recoverable through lookup.

Pending and uncertain creation returns a safe unavailable response and retains the client's saved scope and draft.
Authoritative rejection or fresh known nonacceptance returns `create-rejected` with HTTP 409.
Only the matching create response and current view may release that pending client record; the host retains the original terminal record.
Lookup refusal or failure never establishes nonacceptance of the original creation and never erases admitted processing evidence.
`conversation-agent` resolves the original selected agent even before a public conversation exists.
Confirmed history and existing receipts remain readable when their provider is unconfigured.

## Durable send

The authenticated submit route captures provider sends in the existing command ledger after exact-ID retry detection.
The stored target contains the original installation, configured authority, credential handle, confirmed binding and translated request.
Translation runs once for a new admitted command. Admission bounds the translated target and commits it with the pending receipt before submission.
Retries return the saved receipt. Explicit reconciliation decodes the original request without translation and calls only `reconcileCommand`.
A changed decoder, credential or generation cannot replace the original operation.

Pending and accepted evidence survives weaker lookup outcomes. A changed run reference conflicts with the original acceptance.
Accepted and completed send effects persist their scoped provider run reference atomically with the receipt in the same database.
These effects contain no transcript output and do not establish a terminal run outcome.
Provider observation supplies transcript output independently of command acceptance. Approval and cancellation capture the scoped references retained by observation.
The current integration uses wire version 4, SDK compatibility 0.1, package versions 0.0 and transcript projection 2.
It does not qualify a complete provider conversation or upgrade an existing Mac installation.

## Durable response streams

Each confirmed provider conversation has one upstream feed, independent of browser watches.
Creation starts observation after confirmation commits and before its first send. Startup resumes saved conversations with their original installation, generation, binding and credential.
An unavailable original generation or credential leaves history readable without rebinding it.

The concrete typed provider closure decodes the baseline, cursor, state and events through its presentation.
SQLite commits the model, opaque cursor, provider projection version, event identity, scoped references and transcript together before acknowledging a callback.
Callbacks serialize locally and check the persisted checkpoint revision inside the transaction.
Identical event replay is acknowledged without moving the cursor; a changed duplicate is refused.
Presentation failures, foreign references and capacity failures roll back the complete update.
Provider model values and items are limited to one million encoded bytes, with the saved checkpoint also subject to the configured snapshot budget.

A provider snapshot replaces the transcript and visible decisions through a host checkpoint.
The existing journal sends a replacement snapshot to readers behind that checkpoint before resuming events.
Receipts, command records, accepted run mappings, and reserved or closed decisions remain intact.
Open decisions can update their prompt and choices while retaining their scoped decision and run identity. Reserved and closed records cannot change.
Decision records preserve full scoped choice references and labels. Public decisions expose complete labels keyed by exact choice IDs and a reservation marker while their approval is unresolved.
Only provider presentation events or snapshots establish assistant output and terminal run outcomes.

Shutdown closes upstream feeds and drains admitted callbacks and feed endings before closing the backend, extension lifetime and database.
A stopped feed keeps its last committed checkpoint. Restart resumes that checkpoint.
When a feed ends with `resync`, the host rejects further callbacks from that feed, drains callbacks already admitted, then requests and commits a fresh snapshot before observing from its cursor.
Each observation acquisition permits one automatic snapshot and replacement feed without distinct committed feed event progress. A second `resync` without that progress stops observation before another snapshot request.
A distinct feed event that advances the checkpoint revision renews this allowance. Duplicate events and snapshots do not.
A later send, host restart or provider replacement acquires observation again with a fresh allowance.
Snapshot refusal, unavailable results, validation errors and authorization failures stop observation while preserving saved history and receipts. They do not count as cleanup failures.
A recovery snapshot that changes a reserved or closed decision is a validation error. Observation stops after each acquisition until the provider returns that record unchanged.
Shutdown or provider retirement during recovery waits for the pending snapshot and prevents its late result from committing or opening a replacement feed.
The SDK has no snapshot cancellation operation, so a provider that does not settle its snapshot can delay shutdown or retirement.
Automatic reconnect after `disconnected`, projection migration and generation replacement remain open work.
The current integration uses wire version 4, transcript projection 2, SDK compatibility 0.1 and package versions 0.0. It does not upgrade the installed Mac app or qualify the full provider lifecycle.

## Durable approval and Stop

Approval captures an OPEN decision, its exact selected choice and its scoped run in the same transaction as the command target, pending receipt and reservation owner.
Stop captures the persisted reference for the observed run. Both preserve the original installation, credential, binding and operation UUID.
Exact-ID retries return the saved receipt. Recovery only reconciles that saved operation, even if the current choice map or translator has changed.
Capabilities advertised by the host intersect implemented send, cancel and decide support with backend support and reconciliation. Fresh dispatch rechecks the current backend capability.

An accepted approval retains its reservation. Other browser views and reopened conversations disable its labelled choices.
Completion closes only the decision owned by that operation. Rejection or fresh known nonacceptance releases it only when the latest authoritative document still contains the decision; otherwise it closes.
Snapshot omission hides a reserved decision without releasing its owner. A later snapshot cannot reopen a closed decision.
Cancel and decide effects contain no run output. Only observed events or snapshots establish the actual run outcome.

Wire version 4 adds optional provider-only `choiceLabels` and `reserved: true` fields. Old strict decoders require matching host and client artifacts.
Native decisions omit both fields and preserve their encoded shape. Command version 1, transcript projection 2, SDK contract 1, SDK compatibility 0.1 and npm package versions 0.0 are unchanged.
Controlled HTTP, SQLite and browser fixtures exercise this path. They do not qualify an external production provider, the full provider lifecycle, or a Mac deployment.

## Command and observation obligations

Creation, send, cancellation, approval and observation follow the rules below. SDK declarations alone do not enforce these rules.

The host authorizes the scope and persists creation intent before creation.
It persists the confirmed binding and the exact command before dispatch.
Before persisting a confirmed command effect, the host correlates it with the original admitted operation by ID and rejects a mismatched effect kind.
Operation IDs and bodies remain fixed across restart and reconciliation.
Any native request mapping needed for recovery must also survive dispatch.

Reconciliation reads evidence for the original operation and never redispatches.
A resolved `rejected` result reports authoritative rejection of the original operation, with evidence correlated to its captured identity and body.
It settles that operation negatively. Refusal or failure of the lookup instead returns `unsupported` or an operational failure.
An inconclusive lookup returns `uncertain`. A missing record alone does not prove the original operation was never admitted.
A thrown error or rejected JavaScript promise during reconciliation is a failed lookup, not a resolved `rejected` outcome.

| Result | First `create` or `submit` | `reconcileCreation` or `reconcileCommand` |
| --- | --- | --- |
| `confirmed` | Record the correlated result. | Settle the original operation with its correlated result. |
| `pending` | Record admitted processing without a confirmed result. | Record continued processing of the original operation. |
| `rejected` | Record authoritative rejection with correlated evidence. | Settle the original operation as rejected with correlated evidence. |
| `not-dispatched` | Record known nonacceptance of this invocation. | Preserve prior status and evidence. This says nothing about dispatch of the original operation. |
| `uncertain` | Record unresolved acceptance or outcome. | Preserve prior unresolved status and evidence. |
| `unsupported` | Record known nonacceptance of this invocation. | Preserve prior status and evidence. |
| `unavailable`, `authentication-failed`, `unauthorized`, `version-unsupported` | Record known nonacceptance of this invocation with its failure label. | Preserve prior status and evidence. |
| Thrown error or rejected promise | Record uncertainty. | Preserve prior status and evidence. |

Providers return known outcomes as resolved values.
From `create` or `submit`, `not-dispatched`, `unsupported`, and operational failures require known effectful nonacceptance of that invocation.
If nonacceptance is not known, the provider returns `uncertain` instead.
These labels never erase earlier uncertainty or free an operation ID for reuse.
Lookup failures, refusal, and inconclusive results preserve positive prior evidence of admission or a confirmed result.
The host quarantines unresolved operations when reconciliation is unsupported, preserving the original intent without replay.
No result in the table authorizes replay or replacement of the captured operation identity or body.
No automatic replay or universal exactly-once execution guarantee is supplied.

The host verifies saved creation provenance, scope, actual instance, generation, protocol, authority binding, and local authority host.
The host determines the expected authority kind for each installation and rejects a provider-reported authority of a different kind.
It checks nested run, decision, and choice association with the admitted conversation.
Conversation-scoped references retain their originating conversation so the host can detect accidental cross-conversation use within one installation.
A `decide` choice must belong to the addressed decision in the latest applied snapshot or decision event.
The execution authority validates current decision validity and rejects invalid or stale pairings before applying them.
Snapshot bindings, snapshot cursors, observation request cursors, and feed item bindings and cursors must match the requested conversation.
The host rejects mismatches without applying them.
With `strictFunctionTypes` enabled, optional private variance markers reject accidental instance and model widening while permitting ordinary object construction.
Consumers must enable `strictFunctionTypes`, which `strict` includes, for this compile-time isolation. Without it, widening can compile.
Installation isolation relies on retaining literal identities. Widening `I` to `string` is not implicitly assignable.
Registries that erase identity through casts or wrappers must re-establish it at runtime.
Unmarked structural intermediates can discard the optional variance markers.
Types cannot prove authorization, runtime identity equality, or whether creation intent was persisted.
Full-trust extensions can fabricate structurally valid records.

Observation callbacks resolve only after durable application. Delivery is serialized and may repeat event IDs within a conversation.
A rejected callback is not an acknowledgement. The provider stops delivery and ends the feed with `disconnected` and the last acknowledged cursor, or `null` if none exists.
The end cursor includes only acknowledged items. The snapshot cursor describes exactly its projected state.
Expired cursors, incompatible projections, or an unbridgeable snapshot-to-feed gap require `resync` and a fresh snapshot.
Observation support requires fresh snapshot recovery, subject to the host's bounded recovery policy above.
If a snapshot call reports `unsupported`, the host keeps observation stopped. Reporting this limitation to the user remains open work because the current observation API has no diagnostic channel.
Opaque cursors have no numeric or lexical ordering requirement.
Feed termination resolves `ended` with its reason and last acknowledged cursor, or `null`, and never rejects.
`close()` is idempotent and prevents new `receive` calls. It resolves `ended` with `closed` without waiting for an in-flight callback.
An already-started callback may finish, but cannot advance the terminated feed's cursor. An already-ended feed retains its original end reason and cursor.
Closing a connection closes each open feed. Closing a feed or connection releases local resources and never cancels execution.

Replacement admission rules, persisted model decoding, and provider conversation migration remain host work.
Credentials stay outside client projections. The authority determines who owns execution and approvals.
Local receipts and provider observations do not transfer remote execution authority to AgentUI.

Providers may be constructed generically in `I` from a host-assigned `ProviderInstance<I>`.
Module export and loading conventions remain downstream host work. No particular factory API is required.
Runtime installation strings can use `I = string`, which does not distinguish two runtime strings at compile time. Runtime identity checks still apply.

The two public SDK fixtures compile unrelated request and cursor models with colliding remote IDs and both authority variants.
Compiler cases reject crossed references, incompatible requests, unsafe widening, missing versions, raw history references, and ambient globals.
They also consume confirmed reconciliation values, route saved operations by kind, and reject crossed reconciliation families and result types.
The Crew fixture constructs confirmed creation and reconciliation results without casts inside a generic per-installation factory.
An isolated consumer compiles that same fixture and checks the packed SDK declarations, public runtime export, and private import restrictions.
The connection tests additionally exercise real host startup, SQLite grants, controlled read-only HTTP discovery, revocation and drain. They do not qualify durable provider commands, a production service, or reconnect behavior.
