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
  agentStartup: { kind: 'extensions' },
  extensions: { kind: 'transient', entries: [{ manifest, entry, installations: [{
    id: 'service', instance: presentation.instance, service: 'https://service.example',
    expectedAuthority: 'remote-provider',
    authentication: { kind: 'secret', revision: 'operator-revision-1', resolve: readOperatorSecret },
  }] }] },
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
The command and complete target have separate size limits.
A wire-valid offer can still be refused when its translated target, including saved history, exceeds its limit.
Retries return the saved receipt. Explicit reconciliation decodes the original request without translation and calls only `reconcileCommand`.
A changed decoder, credential or generation cannot replace the original operation.

Pending and accepted evidence survives weaker lookup outcomes. A changed run reference conflicts with the original acceptance.
Accepted and completed send effects persist their scoped provider run reference atomically with the receipt in the same database.
These effects contain no transcript output and do not establish a terminal run outcome.
Provider observation supplies transcript output independently of command acceptance. Approval and cancellation capture the scoped references retained by observation.
The current integration uses wire version 10, SDK compatibility 0.8.0, package versions 0.0 and transcript projection 4.
It does not qualify a complete provider conversation or upgrade an existing Mac installation.

## Captured frontend offers

An `addAgui` provider advertises `frontendOffers: 'ag-ui-capture-and-bind'` only when send and reconciliation are supported.
Generic and native providers advertise `unsupported`. This does not change AG-UI executable-tool capabilities.
The paired service accepts a version-2 text send containing a desktop offer of definitions and original activation IDs.
Version-1 text and image sends keep their exact shapes. Version 2 rejects `imageId`; no provider currently supports an offered image send.
Version-1 commands retain their existing shape and canonical identity.
The offer definition type follows its parsed wire shape, with optional object-valued parameters and metadata.
The SDK tool type remains derived from the pinned AG-UI package; the host still validates definitions with its schemas.
Packed contracts and client consumers need no AG-UI package or checkout-specific dependency override.

Admission binds the authenticated principal, command, original provider installation and credentials in one durable transaction.
The host validates the actual AG-UI input, appends noncolliding captured definitions, and saves the complete raw request.
Schema defaults and state transforms do not rewrite that request. Retry and reconciliation use only its saved bytes.
New AG-UI send targets carry a private `protocol: 'ag-ui'` tag, including version-1 sends.
The target parser validates the raw request and derives the expected run ID without adding schema defaults.
Both fresh and restored confirmation evidence for tagged targets must name that saved run ID.
The tag never enters the public provider operation. A generic live provider cannot execute a tagged target.
Historical untagged targets and their evidence correlations stay byte-identical.
Version-2 commands require the tag and the exact authored offer suffix.
Untagged version-1 requests remain generic, including after registration through `addAgui`.
Admission permanently reserves each offered host, conversation, thread and run for its original command.
For each independent offered send, an `addAgui` provider must allocate a fresh run ID in its actual input.
An exact retry retains the original run ID and saved command.
Another tagged send using that identity is rejected with `frontend-run-reused` before dispatch, including after release or terminal settlement.
A new offered command also rejects a key captured by any earlier tagged send.
Tagged version-1 sends can reuse a key when no offered command reserved it. Untagged generic run-key reuse is unchanged.

Provider dispatch, including generic sends, rechecks the authenticated actor before the effect. These actor fences do not change native driver dispatch. A follow-up send does not reconcile a provider blocker while its original dispatch is still running locally.
An exact command retry returns its existing receipt without translating or dispatching again.
Native driver capability, dispatch and lookup accept only version-1 commands. Native version-2 sends still pass through durable admission so exact retry and conflict checks keep their precedence.
Before a provider effect, the host checks current authority, conversation access and the saved intent after request decoding.
If decoding starts registry shutdown, offered effects stop. In-flight generic and tagged version-1 effects retain their existing credential-based policy.
Binding recovery rechecks the owner after reconciliation, provider input decoding and producer registration.
This reservation does not qualify frontend handler execution ownership.

`connection.frontendBinding({ scope, id, action: 'recover' })` reconciles the original command and returns pending, bound, or unavailable.
Pending does not prove host admission. Retain the original closures and exact saved command ID and body for submission retry.
A bound reply includes the full original offered command, host operation ID, provider-confirmed run identity and actual input thread ID.
Command receipts remain visible to devices that can read the conversation.
The owner checks protect direct receipt lookup and the captured offer association.
Current actor and provider authority are required for lookup and live binding. Another principal cannot submit, reconcile, recover or release that association through its public APIs.
The host can privately settle a pending or accepted offered-send blocker for a new authorized sender using the original provider evidence.
It never looks up an initial dispatch still running locally, resubmits the old operation, or gives its binding to the new sender.
Released closures or a revoked original actor do not prevent this host settlement. Revoked provider credentials and inconclusive lookup evidence keep the blocker.
The blocker can remain indefinitely until conclusive authoritative evidence arrives. Restoring credentials alone does not clear it.
There is no manual abandon action for an unresolved offered send.
Public reconciliation and binding recovery also retain the latest persisted offered receipt and observation on an inconclusive lookup, including pending admission with no observation.
An authorized original owner can still reconcile its receipt after releasing closures.
A terminal rejection without a retained run returns `unavailable` with `provider-rejected`; not-dispatched returns `not-dispatched`.
Both final no-run results work offline and need no coordinator. Explicit closure release takes precedence as `closures-unavailable`.
A prior confirmed run retained through later rejection remains a binding. Command settlement does not finish the run.
`action: 'unavailable'` irreversibly releases host availability. Before admission it records an owner-specific tombstone that cannot reserve another principal's command ID.
After confirmation, recovery registers the exact binding outside command transactions. Repeated recovery repairs a crash between evidence and registration.
Unavailable acknowledgement follows the owner or tombstone commit and does not acquire a producer or call the provider.
The coordinator reads committed ownership with each run. Unavailable ownership blocks fresh permits even through retained clients and after reopen.
Inspection and result reads expose effective blocking without rewriting coordinator rows. Existing faulted diagnostics remain faulted.
A permit committed before withdrawal remains uncertain. Its original actor can record the original receipt, but another call cannot gain a fresh permit.
With a valid cursor, unavailable observation accepts only an exact stored replay as a duplicate. Other payloads return faulted without changing stored evidence.
Invalid cursors retain their existing rejection.
`frontendToolsFor` requires the exact handle returned by `openLocalHost` or `openRecordedHost`. A copy or wrapper has a different identity and is not registered.

Database format 5 adds frontend ownership and the new optional target tag without rewriting existing commands, targets, observations or receipts.
The format-5 release preserves released format-4 images.
Format 6 enforces committed ownership for coordinator access without rewriting existing rows or changing ownership tables.
It requires the existing image tables, validates the ownership schema, and advances the version last in the migration transaction.
Format-5 core openers refuse format 6 before returning a core writer. Already-open mixed-version writers are unsupported.
Image and owner schema changes from formats 2 and 3 commit in one transaction. Format 4 must contain the released image tables; the private capture-only format 4 is unsupported.
Format 5 stores keyed admitted owners in `frontend_send_owners` and keyless actor-specific tombstones in `frontend_send_tombstones`.
Each owner has one command and a unique host, conversation, thread and run key. Both available and unavailable owners retain that key.
The command foreign key is deferred until commit so admission authorization callbacks keep their existing position before command insertion.
An admitted owner stores the original run key as a permanent reservation. The saved target retains the provider request used for evidence and retry.
The host requires these records to agree when it reads an offered command. A missing owner, unreadable capture or disagreement is corruption and fails closed.
The host does not reconstruct the reservation from whichever record still parses. Releasing closures changes availability and retains the original reservation.
An admitted owner takes precedence over foreign actor tombstones for the same command. Tombstones never reserve a run key.
The tagged history index derives its keys from immutable saved targets. Admission checks that those raw JSON keys agree with the parsed capture.
Formats 5 and 6 require both ownership tables, their command keys, owner run uniqueness, conversation and deferred command foreign keys, and a usable tagged history index. Opening does not repair missing objects.
Private mixed-owner format-5 databases are unsupported. The host does not migrate unmerged capture schemas.
Transcript migration precedes this schema transaction. A later schema failure can leave a successful transcript migration committed.
Wire 10 and SDK 0.8.0 require matching host/client releases and rebuilt extensions. Transcript projection remains 4.
Desktop sends retain the original frontend tools before saving the exact offered command and its principal in the conversation's local journal.
The composer and extension send actions share this admission path. Retrying never captures a replacement generation.
There are at most 32 live or provisional captures. Released tools free their slot even when their original principal cannot acknowledge the unavailable notification.
The application shows at most 32 recent unavailable rows in addition to live captures.
Recent rows record an in-session release, a local repair of lost retained closures, or acknowledgment of a pending unavailable notification.
Rediscovering unchanged pending or confirmed history does not republish or reorder these rows.
After reload, an already-pending offline reference remains only in durable history until acknowledgment.

On reload, the desktop scans draft keys for the physical view whose exclusive lock it owns, independently of the selected conversation or agent catalog.
Each page contains at most 100 keys. One worker borrows the conversation's canonical store and examines at most 32 journal references per slice.
Lost closures become unavailable locally. Only the original matching principal can send their unavailable notifications.
The worker never submits a saved command, binds replacement tools, or opens another tab's view.
It advances past foreign owners and failed requests, then retries passes with actionable pending work every two seconds and wakes after durable capture release.

Live captures retain their original store and view lock through navigation.
Bound captures keep that lock until explicit release, a change of principal, storage failure, or reload.
Release keeps that writer until the admitted unavailable save finishes.
After leaving a physical view, pending notifications alone do not retain its lock. Remaining retries resume when that physical view is reopened.
Conversation navigation within the selected physical view continues background recovery.
Inactive stores close new writes synchronously and drain admitted saves before eviction. Delayed transport replies cannot overwrite a successor store.

Released local v1 text and v2 image records remain readable and upgrade to v3 when saved. Local v3 requires image metadata and the frontend journal in one record. Private frontend-only v2 records are refused without rewriting. Images with captured frontend tools are refused before local admission. Explicit text sends keep the selected composer image. Full journal commands and original owner IDs remain durable, including confirmed history needed to reject reused command IDs.
The bounds above apply to live resources and recovery work, not to one whole record's byte size or total disk history.
This integration executes no frontend handlers.
Consent, claiming, durable execution receipts and continuation remain separate work.

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
The current integration uses wire version 10, transcript projection 4, SDK compatibility 0.8.0 and package versions 0.0. It does not upgrade the installed Mac app or qualify the full provider lifecycle.

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


## Provider observation status and retry

Service wire 5 adds the authenticated `provider-observation` operation. Its exact
request contains only `op`, `scope`, and `action`, where action is `read` or
`retry`. The host selects the saved provider binding, installation generation,
and credential. The browser cannot supply replacements. SDK compatibility stays
at 0.1.0, the backend provider contract stays at 1, and transcript projection and
the database schema are unchanged. Wire 4 clients and hosts must update together
with the native request whitelist.

The local host retains ephemeral observation status alongside each scope's
starting or live observer. A drained observer retains a typed stopped reason.
These states are separate from the durable journal, transcript, command receipts,
and run authority. A stopped provider observer leaves journal subscriptions open,
so later local receipts still arrive. It neither ends a running run nor removes
known terminal facts. Stop and Approve retain their existing admission rules.

Reads never connect to a provider or replenish automatic recovery. Explicit retry
joins a pending acquisition, leaves a live observer alone, or starts one fresh
snapshot and observer after the old writer drains. It validates the saved
checkpoint before requesting the fresh snapshot, uses the original binding and
credential, and never submits or reconciles a command. The existing bounded
resync policy still applies. A failed cleanup forbids another writer. Missing
original configuration or credentials requires restoration through the existing
host configuration path; retry cannot retarget a conversation.

The application polls only the selected conversation, serially at two-second
intervals after each completed read. A native conversation's first `not-applicable`
response ends that poll. Selection, session changes and disposal suppress stale
results. The notice and retry progress live outside the canonical document and
`OpenConversation` identity. A transport error reports unknown observation status;
only an authenticated stopped status produces the paused notice. Unauthorized
responses still use the existing access-revoked path. Retry remains local so
navigation and saved drafts stay available.


## Permission management

A connected provider can implement the optional `permissions` manager with `read`, `revoke`, and `reconcileRevoke`.
Reads report every effective permission in the supported domain for the original conversation binding.
A successful empty result describes that domain. Unsupported or incomplete reads remain explicit failures.
The authenticated `conversation-permissions` service operation returns display data and a host observation time.

The durable `revoke-permission` command captures the permission ID and owner-confirmed `conversation` or `agent` scope.
The provider validates both against a fresh authenticated listing before dispatch.
The existing outbox and command store retain the original creation, provider generation, credential handle, and operation ID independently of any run or approval card.
`reconcileRevoke` resolves the original acknowledgement only when the provider has matching evidence.
A later empty permission listing leaves an uncertain receipt unresolved. Retry of the same command ID preserves the saved intent without dispatching again.

SDK compatibility 0.8.0 and wire 10 require rebuilt extensions and matching host and client releases.
The host advances SQLite format 2 to 3 transactionally while preserving existing rows. Earlier hosts refuse format 3.
Conversation modules receive a bound `permissions.read()` service and `commands.revokePermission(permissionId, scope)`.

### Original frontend observation journal

An explicit fourth `addAgui` argument maps provider events and complete snapshots into original AG-UI run history. Database format 7 stores the captured opt-in and a bounded retained positional journal separately from the coordinator. Provider commits atomically persist that journal, canonical transcript, checkpoint and source event ID. Command settlement materializes confirmed originals inside its existing transaction through the same coordinator reducer.

The journal retains faulting events and their suffix even when the coordinator cannot accept them. Duplicate positions require identical canonical JSON. Gaps, conflicting bytes and exceeded per-run limits permanently block eligibility. Missing, shorter or unavailable snapshot history also blocks eligibility; omitted terminal runs retain their disposition. Explicit contradictory terminal history can reduce eligibility.

For fourth-argument mapper registrations, incoming snapshot-state or event decoding runs during read-only preparation before the provider transaction. The mapper receives detached values. Preparation precedes canonical snapshot binding, projection and missing-baseline checks. Canonical `presentation.snapshot` and `presentation.apply` run inside the transaction. `decodeState` also runs for rendering inputs, canonical output/checkpoint validation, and restore. Restore runs outside the commit transaction. Incoming event decoding is reused from preparation. Three-argument registrations retain their existing callback timing.

Snapshot selection hashes every eligible original, including originals excluded from the callback by count or bytes. Commit compares the complete selection after rendering and rechecks ownership, creation association, feed liveness and checkpoint revision. A changed selection rejects preparation for retry. ID-ordered pages close before omission writes. An excluded original cannot regain eligibility by returning an unsolicited complete history.

Snapshot preparation reserves every unavailable marker before admitting complete histories. The 1,000,000-byte preparation limit includes membership, identities, metadata and encoded frame strings. A valid history can become unavailable even when its raw events total less than that limit. Capacity loss is sticky frontend unavailability and permits canonical snapshot progress. All frames remain subject to JSON and schema validation, including suffixes after capacity loss. Invalid data and SQLite failures still abort the whole item.

The coordinator checks candidate state capacity before persistence. Capacity faults preserve the pre-event cursor, calls, permits and receipts while the provider journal and canonical checkpoint advance. SQL failures, including fault persistence, still roll back the entire transaction.

Genuine released formats 5 and 6 migrate through the public host opener to format 7 without rewriting old command, image, transcript, permit or receipt rows. Their frozen old openers refuse the migrated file before changing WAL state. Core contract 1, projection 4, wire 10 and backend provider contract 1 remain unchanged.
