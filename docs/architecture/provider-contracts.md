# Public provider contracts

`@agentui/sdk` exports the version 1 backend provider contract.
The declarations describe provider integrations without Node or DOM types.
There is no provider registry, transport, credential resolver, or lifecycle runtime in this unit.
The host's recorded Switchboard driver remains a separate integration.

## API reference

| Export | Shape and purpose |
| --- | --- |
| `backendProviderContractVersion` | Literal `1`, required as `apiVersion` on providers and connection requests. |
| `ProviderModel` | JSON-compatible semantic `request`, opaque `cursor`, projected `state`, and `event` types. Declare object payloads as type aliases. Interfaces without an index signature do not satisfy the `Json` constraint. |
| `Json` | Canonical JSON-compatible value type re-exported from `@agentui/contracts`. |
| `BackendProvider<M, I>` | Connects one model and installation identity. Returns a `ConnectedProvider` or an explicit failure. |
| `ProviderInstance<I>` | Namespace, literal installation identity, generation, and provider protocol version. |
| `CredentialHandle<I>` | Host-scoped opaque handle tied to an instance. Contains no secret bytes. `null` permits credential-free connections. |
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

## Runtime obligations

These are requirements for future provider implementations and host integration. SDK declarations do not enforce them.

The host authorizes the scope and persists creation intent before creation.
It persists the confirmed binding and the exact command before dispatch.
Before persisting a confirmed command effect, the host correlates it with the original admitted operation by ID and rejects a mismatched effect kind.
Operation IDs and bodies remain fixed across restart and reconciliation.
Any native request mapping needed for recovery must also survive dispatch.

Reconciliation reads evidence for the original operation and never redispatches.
Missing, failed, or rejected reconciliation lookup preserves the prior admitted, pending, or uncertain outcome.
Unsupported lookup does not settle an earlier uncertain operation.
The host quarantines pending or uncertain operations when reconciliation lookup is unsupported, preserving the original intent and unresolved status without replay.
A later refusal cannot disprove an earlier ambiguous dispatch.
`not-dispatched` describes this invocation and cannot erase prior uncertainty.
A thrown error or rejected promise from `create` or `submit` leaves the persisted operation uncertain, never proving no dispatch.
Providers return known outcomes as resolved values. They use `not-dispatched` or operational failures from these calls only when effectful nonacceptance is known.
Otherwise they return `uncertain`. A failure label alone cannot prove nonacceptance or free an operation ID.
Authentication, authorization, version, and availability failures also leave earlier uncertain dispatch unresolved.
No automatic replay or universal exactly-once execution guarantee is supplied.

The host verifies saved creation provenance, scope, actual instance, generation, protocol, authority binding, and local authority host.
The host determines the expected authority kind for each installation and rejects a provider-reported authority of a different kind.
It checks nested run, decision, and choice association with the admitted conversation.
A `decide` choice must belong to the addressed decision in the latest applied snapshot or decision event.
The execution authority validates current decision validity and rejects invalid or stale pairings before applying them.
Snapshot bindings, snapshot cursors, observation request cursors, and feed item bindings and cursors must match the requested conversation.
The host rejects mismatches without applying them.
Optional private variance markers reject accidental instance and model widening while permitting ordinary object construction.
Installation isolation relies on retaining literal identities. Widening `I` to `string` is not implicitly assignable.
Registries that erase identity through casts or wrappers must re-establish it at runtime.
Unmarked structural intermediates can discard the optional variance markers.
Types cannot prove authorization, runtime identity equality, or whether creation intent was persisted.
Full-trust extensions can fabricate structurally valid records.

Observation callbacks resolve only after durable application. Delivery is serialized and may repeat event IDs within a conversation.
A rejected callback is not an acknowledgement. The provider stops delivery and ends the feed with `disconnected` and the last acknowledged cursor, or `null` if none exists.
The end cursor includes only acknowledged items. The snapshot cursor describes exactly its projected state.
Expired cursors, incompatible projections, or an unbridgeable snapshot-to-feed gap require `resync` and a fresh snapshot.
Observation support requires fresh snapshot recovery. If a snapshot call reports `unsupported`, the host keeps observation stopped and reports that limitation.
Opaque cursors have no numeric or lexical ordering requirement.
Feed termination resolves `ended` with its reason and last acknowledged cursor, or `null`, and never rejects.
`close()` is idempotent and prevents new `receive` calls. It resolves `ended` with `closed` without waiting for an in-flight callback.
An already-started callback may finish, but cannot advance the terminated feed's cursor. An already-ended feed retains its original end reason and cursor.
Closing a connection closes each open feed. Closing a feed or connection releases local resources and never cancels execution.

Credential resolution, credential storage, disable and replacement admission rules, persisted decoding, and version migration remain host work.
Credentials stay outside client projections. The authority determines who owns execution and approvals.
Local receipts and provider observations do not transfer remote execution authority to AgentUI.

The two public SDK fixtures compile unrelated request and cursor models with colliding remote IDs and both authority variants.
Compiler cases reject crossed references, incompatible requests, unsafe widening, missing versions, raw history references, and ambient globals.
They also consume confirmed reconciliation values, route saved operations by kind, and reject crossed reconciliation families and result types.
An isolated consumer checks the packed SDK declarations, public runtime export, and private import restrictions.
These checks qualify the contract shape. They do not qualify a live provider, durable host enforcement, or reconnect behavior.
