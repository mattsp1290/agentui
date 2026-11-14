# Public provider contracts

`@agentui/sdk` exports the version 1 backend provider contract.
The declarations describe provider integrations without Node or DOM types.
There is no provider registry, transport, credential resolver, or lifecycle runtime in this unit.
The host's recorded Switchboard driver remains a separate integration.

## API reference

| Export | Shape and purpose |
| --- | --- |
| `backendProviderContractVersion` | Literal `1`, required as `apiVersion` on providers and connection requests. |
| `ProviderModel` | JSON-compatible semantic `request`, opaque `cursor`, projected `state`, and `event` types. |
| `BackendProvider<M, I>` | Connects one model and installation identity. Returns a `ConnectedProvider` or an explicit failure. |
| `ProviderInstance<I>` | Namespace, literal installation identity, generation, and provider protocol version. |
| `CredentialHandle<I>` | Host-scoped opaque handle tied to an instance. Contains no secret bytes. `null` permits credential-free connections. |
| `ProviderRef<I, K>` | Instance-scoped opaque ID with a semantic role. Discovery returns agents, never native conversation history. |
| `CreationIntent<I>` | Immutable host operation ID, allocated `ConversationScope`, and selected agent. |
| `ProviderConversation<I>` | AgentUI-created provenance with captured creation intent and canonical `RunAuthority`. Its authority owns the session binding. |
| `ConversationRef<I, K>` | Run, decision, or choice reference retaining its originating conversation. |
| `ProviderCommand<M, I>` | Captured operation ID and conversation, plus send request, cancel run, or decision and choice. |
| `ProviderOperation<M, I>` | Creation intent or command, retained as the original reconciliation input. |
| `ProviderCursor<M, I>` | Opaque model cursor bound to a conversation and its instance context. Distinct from host journal numbers. |
| `ProviderSnapshot<M, I>` | Projection version, state, exact cursor, and decisions with explicit run and choice references. |
| `ProviderItem<M, I>` | Snapshot or event with a conversation-scoped event ID and provider cursor. |
| `ProviderFeed<M, I>` | Local `close` and an `ended` promise carrying a reason and last acknowledged cursor, or `null`. |

`ConnectedProvider` exposes discovery, creation, command submission, overloaded reconciliation, snapshot, observation, and local resource closure.
Its create, send, cancel, decide, reconcile, and observe capabilities are supported or explicitly unsupported with a reason.
The methods remain present when unsupported. Actual results describe the invocation even when a capability was previously supported.
Read and connection failures distinguish unavailability, authentication failure, authorization denial, incompatible version, and unsupported operation.

`ProviderOutcome<T>` distinguishes confirmed evidence with a value, pending admission without a required binding, authoritative rejection, no dispatch, uncertainty, and explicit failures.
A confirmed command effect records acceptance or completion. Acceptance does not mean terminal execution.
A pending creation can be admitted before a session binding is known.

## Runtime obligations

These are requirements for future provider implementations and host integration. SDK declarations do not enforce them.

The host authorizes the scope and persists creation intent before creation.
It persists the confirmed binding and the exact command before dispatch.
Operation IDs and bodies remain fixed across restart and reconciliation.
Any native request mapping needed for recovery must also survive dispatch.

Reconciliation reads evidence for the original operation and never redispatches.
Missing or failed lookup preserves uncertainty. Unsupported lookup does not settle an earlier uncertain operation.
A later refusal cannot disprove an earlier ambiguous dispatch.
`not-dispatched` describes this invocation and cannot erase prior uncertainty.
Authentication, authorization, version, and availability failures also leave earlier uncertain dispatch unresolved.
No automatic replay or universal exactly-once execution guarantee is supplied.

The host verifies saved creation provenance, scope, actual instance, generation, protocol, authority binding, and local authority host.
It checks nested run, decision, and choice association with the admitted conversation.
Optional private variance markers reject accidental instance and model widening while permitting ordinary object construction.
Types cannot prove authorization, runtime identity equality, or whether creation intent was persisted.
Full-trust extensions can fabricate structurally valid records.

Observation callbacks resolve only after durable application. Delivery is serialized and may repeat event IDs within a conversation.
The end cursor includes only acknowledged items. The snapshot cursor describes exactly its projected state.
Expired cursors, incompatible projections, or an unbridgeable snapshot-to-feed gap require `resync` and a fresh snapshot.
Opaque cursors have no numeric or lexical ordering requirement.
Closing a feed or connection releases local resources and never cancels execution.

Credential resolution, credential storage, disable and replacement admission rules, persisted decoding, and version migration remain host work.
Credentials stay outside client projections. The authority determines who owns execution and approvals.
Local receipts and provider observations do not transfer remote execution authority to AgentUI.

The two public SDK fixtures compile unrelated request and cursor models with colliding remote IDs and both authority variants.
Compiler cases reject crossed references, incompatible requests, unsafe widening, missing versions, raw history references, and ambient globals.
An isolated consumer checks the packed SDK declarations, public runtime export, and private import restrictions.
These checks qualify the contract shape. They do not qualify a live provider, durable host enforcement, or reconnect behavior.
