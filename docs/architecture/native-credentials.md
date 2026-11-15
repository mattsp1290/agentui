# Native protected credentials

Status is specified, not implemented. This reference defines future private Rust and Swift contracts.
It adds no public API, native adapter, or installed-application qualification.
The [native protocol prerequisite](../development/recorded-host.md#native-protocol-prerequisite) remains the supported development boundary.

## Credential record and states

All shapes and signatures below are language-neutral specifications, not TypeScript exports.
The native owner alone holds the complete credential record and controls request admission.

```text
SlotKey = { applicationNamespace, profileId, credentialClass = native, endpoint, hostId }
ProtectedCredential = { formatVersion = 1, key: SlotKey, principalId, secret, generation }
ExpectedRevision = opaque native-owner mutation-check token bound to the observed slot state and owner epoch
Session = opaque non-secret handle bound to one credential generation and owner lifetime
RecordFault = Invalid | UnsupportedVersion
StorageBlock = Locked | Unavailable | PermissionDenied
StorageFault = RecordFault | StorageBlock
FaultHandle = opaque non-secret native-owner handle for one exact record observation
StoreState = Absent(expectedRevision) | Present(expectedRevision, ProtectedCredential)
           | Unreadable(expectedRevision, RecordFault) | Blocked(StorageBlock)
```

`generation` is fresh for every committed replacement and never reused.
The exact approved endpoint belongs to the binding. A changed port or destination cannot silently reuse a credential.
The current protocol permits only literal `http://127.0.0.1:<port>`.
The host ID checks enrollment intent and does not authenticate the server cryptographically.

The stored credential contains the wire `hostId`, `principalId`, and `secret` defined by [native-wire.ts](../../apps/host/src/native-wire.ts).
The closed wire reply has no expiry field. The [host access policy](../../apps/host/src/access.ts) enforces its one-hour lifetime and revocation.
Local presence does not establish that the host still accepts the credential.

## Private protected store

Only the native owner calls these operations. `read` may return a secret inside native memory.

```text
read(key) -> StoreState
replace(key, expectedRevision, nativeCredential) -> Committed(newGeneration) | MutationFailure
remove(key, expectedRevision) -> Removed | MutationFailure
MutationFailure = Conflict | NoWrite(StorageFault) | CommitUnknown
```

`replace` validates the native pairing credential and its exact binding before mutation.
The adapter constructs the complete versioned record and allocates its fresh generation.
The committed result returns that same durable generation.
The adapter replaces the complete record atomically. A partial record must never become usable.
`replace` and `remove` check the expected revision under the same ownership as the mutation.
A conflict changes nothing. Neither `Unreadable` nor `Blocked` becomes absence.
`replace` accepts only an observed `Absent` or `Present`. Enrollment never overwrites a fault.
`remove` accepts an unreadable record only through the guarded owner `discard` operation below.
Unreadable records are not silently overwritten, deleted, or migrated.

`NoWrite` means the adapter can prove that the mutation did not commit and the previous durable record remains unchanged.
`CommitUnknown` means the adapter cannot establish whether the mutation committed.
The owner blocks the slot until authoritative durable readback establishes the result. A cached value is insufficient.
A failed readback leaves the slot unavailable. Replacement, forgetting, and discard cannot report success while the result is unknown.
Durable success means that a subsequent process can observe the committed record or confirmed removal.

One native owner serializes credential mutations and request admission for all participating windows and bridges.
These semantics do not assume an operating-system compare-and-swap operation.
Multiple native processes or extensions require shared arbitration before qualification. A process-local lock does not suffice.
`ExpectedRevision` is the sole token used to check mutations.
Every committed mutation, accepted forget including absence, accepted discard, and restart invalidates earlier pending enrollment revisions.
Absence does not require a durable tombstone. Restart invalidates every old expected revision, session, and fault handle.

## Native owner and application boundary

The application-facing operations return redacted outcomes. Store records and expected revisions remain private.

```text
enroll(selection, invitation) -> Ready(session, hostId, principalId) | EnrollmentFailure
status(selection) -> Ready(session, hostId, principalId) | Absent
                  | Unreadable(faultHandle, RecordFault) | Blocked(StorageBlock)
execute(session, serviceRequest) -> BoundedServiceResponse | ExecutionFailure
forget(selection, expectedSession) -> Forgotten | ForgetFailure
discard(selection, faultHandle) -> Discarded | DiscardFailure
```

`selection` refers to native-validated application, profile, host, and endpoint configuration.
`expectedSession` identifies the current session, or explicit absence when no session exists.
Forgetting also invalidates pending enrollment when the slot is absent. A stale session cannot remove a replacement credential.
Status restores access from a validated stored record and reuses a still-valid session for its generation within the owner lifetime.
Status never revives a retired handle. Recovery after retirement creates a new session.
`Ready` reports local admission readiness, not host authorization.
Repeating a completed forget with its retired handle returns a fixed stale-handle failure. Forgetting explicit absence returns `Forgotten` and invalidates pending enrollment.
Stale-handle failures do not affect newer sessions.
After a stale-handle failure, the caller rereads status. `Absent` confirms no local credential.
`Ready` means a replacement exists or prior removal failed. The caller must not blindly discard it.
Failures distinguish storage state, stale handles, pairing failure, network failure, and unauthorized responses using fixed, secret-free categories.

Only `Unreadable` observations permit discard. `Blocked(StorageBlock)` returns no fault handle and requires unlock, restored service, or restored access, never deletion.
The native owner binds each usable fault handle to the exact raw observed record, its expected revision, and the owner lifetime.
If the raw record identity cannot be established, read and status return `Blocked(Unavailable)` without a revision or discard handle.
The owner obtains explicit user confirmation before discard, including the downgrade risk of deleting an unsupported version.
Declined confirmation changes no durable record and publishes no session.
After delayed confirmation, the owner rechecks the handle, expected revision, and exact raw record under the same ownership as removal.
A stale fault returns a fixed failure without deleting a concurrently written valid record or affecting a newer session.

The native IPC boundary validates every input independently of JavaScript validation and rejects unknown fields.
Enrollment accepts a bounded invitation and uses the existing native pairing route.
Execution accepts a closed service request other than `pair` and verifies its host scope against the session.
JavaScript cannot supply request URLs, authentication headers, cookies, or a replacement host identity.
The owner chooses the fixed destination and headers according to the [native wire rules](../development/recorded-host.md#native-protocol-prerequisite).
It must not follow a cross-origin redirect or move a credential outside its bound endpoint.
Native code enforces invitation, request, response, and deadline bounds before crossing IPC or sending requests.
Pairing replies remain native. Service replies contain only the bounded service response and safe transport metadata.

Enrollment captures the expected revision before contacting the host and validates the exact pairing reply and selected host ID.
The owner publishes a new session and reports pairing success only after durable replacement succeeds.
If remote pairing succeeds but persistence fails, the invitation may be consumed and an unused host credential may remain until expiry or revocation.
Pairing does not retry automatically. A definite failed write preserves the prior record, while an unknown commit blocks the slot.

## Replacement, forgetting, and uncertain effects

Each `ServiceConnection` binds one immutable native session. Replacement creates a new connection and retires the old binding for admission.
The owner checks the captured session at request admission and retains that identity through response handling.
Concurrent enrollments cannot commit with an invalidated expected revision. Forgetting invalidates earlier enrollment before its late pairing reply can publish access.
Retired observations close, and their callbacks cannot update a replacement connection.
Late successes and unauthorized responses remain attached to their original connection.
An unauthorized callback may disable or conditionally remove only its captured credential generation, never a newer credential.

The current [service engine](../../packages/client/src/service-engine.ts) owns service decoding and observation resynchronization.
Its `ServiceExecutor` is an internal seam returning a fetch `Response`, not a [public package export](../../packages/client/package.json).
Its `credentialGeneration` advances after browser `pair()` and does not establish native replacement coordination.
A future adapter must coordinate native sessions and callbacks while retaining the engine's service checks.

Forgetting disables local admission immediately and reports completion only after confirmed durable removal.
Failed removal does not re-enable the retired session. Future status recovery must reconcile the durable state before granting a new session.
Forgetting is local. The existing host device-revocation command remains authoritative for server access.
Forgetting, replacement, and discard preserve drafts, saved commands, receipts, and unresolved effects.
Aborting a request, closing an observation, losing a process, or removing a credential does not prove that an admitted command failed.
Recovery preserves the original host, conversation, command ID, and body. No credential transition automatically replays or replaces a command.

## Platform protection and redaction

The future macOS adapter must own credentials in Rust and use application-restricted OS protected credential storage.
The future iOS adapter must own credentials in Swift and use app-restricted, device-local, nonsynchronizing Keychain items.
Each adapter must specify and qualify its access policy, lock behavior, backup behavior, and migration policy.
There is no plaintext fallback or browser-cookie fallback when protected storage fails.

Bearer secrets must never enter JavaScript, bridge replies, ordinary preferences, browser storage, logs, URLs, crash diagnostics, telemetry, or customization Git.
Invitation codes may exist transiently in user input and enrollment IPC, then must be cleared. They must never be persisted, logged, or put in URLs.
The existing [pairing form](../../apps/desktop/src/shell/PairForm.tsx) already holds invitation input in React state.
Native diagnostics must redact authorization and pairing bodies, and bridge errors must not expose platform diagnostic text containing secrets.
Native code limits transient secret copies. Protected storage does not promise isolation from a compromised native process.

## Evidence and future qualification

The [Rust entrypoint](../../apps/desktop/src-tauri/src/main.rs) configures the desktop shell and optional browser navigation.
The [Swift entrypoint](../../apps/ios/native/ios/AgentUI/AppDelegate.swift) starts React Native. Neither implements this owner or protected store.
[Native HTTP tests](../../tests/application/native-http.test.mjs) cover route separation, credential classes, expiry, revocation, and original-command recovery.
Their [private client fixture](../../tests/application/support/native-client.mjs) holds one immutable in-memory credential.
Those tests establish protocol behavior, not protected persistence, native IPC, replacement safety, or installed macOS and iOS operation.
TLS, LAN access, and remote phone access remain unqualified.

| Future qualification | Required evidence |
| --- | --- |
| Restart and isolation | Durable records survive restart. New sessions replace old handles. Application, profile, class, endpoint, host, and principal bindings cannot cross. |
| Store states | Record faults and storage blocks remain distinct from absence. Blocked reads grant no mutation or discard authority. |
| Explicit discard | Confirmed discard removes only the observed invalid or unsupported record. Delayed confirmation, changed raw records, unusable identities, stale handles, and transient faults cannot delete a replacement or grant access. |
| Atomic failures | Replacement and removal preserve the prior record on definite failure. Unknown commits block until authoritative readback. |
| Stale work | Concurrent enrollment, forgetting an absent slot, replacement, and delayed success or unauthorized replies cannot restore or clear newer access. |
| Redaction and native scope | IPC, diagnostics, persistence, redirects, bounds, OS access policies, and device-lock behavior satisfy this contract. |
| Uncertain effects | Interruption, replacement, forgetting, and restart preserve original commands and unresolved receipts without automatic replay. |
