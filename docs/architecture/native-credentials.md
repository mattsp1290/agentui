# Native protected credentials

This reference specifies future private Rust and Swift interfaces. No native owner or protected store is implemented.
It adds no public package API or installed-application qualification.
The [native protocol prerequisite](../development/recorded-host.md#native-protocol-prerequisite) remains the supported development boundary.

## Record, revision, and observation

These language-neutral shapes describe native contracts, not TypeScript exports.
The native owner holds the complete credential and controls request admission.

```text
SlotKey = { applicationNamespace, profileId, credentialClass = native, endpoint, hostId }
ProtectedCredential = { formatVersion = 1, key: SlotKey, principalId, secret, generation }
Revision = { key: SlotKey, ownerLifetime, mutationCounter, rawIdentity: ExactRecord | Absent }
Observation<K> = opaque redacted reference to one native Revision and observed kind K
RecordFault = Invalid | UnsupportedVersion
StorageBlock = Locked | Unavailable | PermissionDenied
RawState = Present(ExactRecord, ProtectedCredential) | Absent
         | Unreadable(ExactRecord, RecordFault) | Blocked(StorageBlock)
Status = Ready(Observation<Ready>, hostId, principalId) | Absent(Observation<Absent>)
       | Unreadable(Observation<Unreadable>, RecordFault) | Blocked(StorageBlock)
```

`credentialClass` keeps native slots in a separate namespace from browser credential storage. Native enrollment is the only credential source for this store.
`principalId` belongs to the credential record, not the slot key. Replacement may enroll a different principal for the same slot.
The exact approved endpoint is part of the key. A changed destination or port requires a distinct selection.
The current protocol permits only literal `http://127.0.0.1:<port>`. The host ID checks enrollment intent, not cryptographic server identity.
The [wire credential](../../apps/host/src/native-wire.ts) contains `hostId`, `principalId`, and `secret`, with no expiry field.
The [host policy](../../apps/host/src/access.ts) enforces the one-hour lifetime and revocation. `Ready` establishes local admission only.

The owner alone composes and holds revisions, issues observations, and advances mutation counters, including on a current 401.
Its full revision guard includes the exact stored record, even if unreadable, or absence.
The revision and raw identity remain native. JavaScript receives only a native-issued opaque observation reference, never record bytes or a fingerprint.
An identity that cannot be established produces `Blocked(Unavailable)`, not an unreadable or absent observation.
Before replacement, the owner constructs the complete intended record with a fresh `generation` from at least 128 CSPRNG bits.
Generation allocation is independent of deleted counters and app reinstalls. Readback compares the complete record, never generation alone.
The owner reuses a current observation for repeated status reads. Retirement never revives an old reference.

## Ownership and private store

One native owner arbitrates all windows, bridges, processes, and extensions that use a slot.
Exclusive ownership covers the authoritative reread, full revision comparison, mutation, and publication of its outcome.
Every store mutation follows the single accepted-mutation rule below. A changed raw record fails the guard even if the owner counter is unchanged.
This contract assumes no operating-system compare-and-swap operation.
Platform restore, migration, manual edits, and other external writers must participate in arbitration or be excluded during that interval.
If the adapter cannot establish that exclusion, the selection is `Blocked(Unavailable)` and cannot qualify for mutation.
A process-local lock or an uncoordinated read-then-write sequence does not establish this guarantee.

```text
read(key) -> RawState
replace(key, expectedRaw: ExactRecord | Absent, intended: ProtectedCredential) -> Committed | MutationFailure
remove(key, expectedRaw: ExactRecord | Absent) -> Removed | MutationFailure
MutationFailure = ExclusionLost | NoWrite(StorageBlock) | CommitUnknown
```

The private backend reads raw state and compares only `expectedRaw`. It neither issues revisions nor holds owner lifetimes or counters.
The owner validates the native pairing reply and selected binding before constructing the complete replacement record.
Backend replacement atomically writes that record. Removal accepts any exact raw identity, including unreadable records and absence.
The backend has no knowledge of caller operations, observations, admission policy, or user confirmation.
`Committed` and `Removed` require durable evidence that a subsequent process can observe the replacement or absence.
`NoWrite` proves the previous durable record is unchanged. `CommitUnknown` cannot establish whether the mutation committed.
`ExclusionLost` means the raw precondition failed after owner acceptance. The backend performs no write, but another writer may have changed the record.
This is an arbitration failure, not pre-acceptance staleness. The table defines retirement and recovery for each outcome.

## Owner interface and transitions

```text
status(selection) -> Status
enroll(observation: Observation<Ready | Absent>, code) -> Ready | Failure
forget(observation: Observation<Ready | Absent>) -> Absent | Failure
discard(observation: Observation<Unreadable>) -> Absent | Failure
execute(observation: Observation<Ready>, request) -> BoundedServiceResponse | Failure
Failure = InvalidInput | Stale | WrongState | Cancelled | Blocked(StorageBlock)
        | PairingFailed | NetworkFailed | Unauthorized
```

`status(selection)` is the sole selection entry point. It validates application, profile, host, and endpoint configuration.
Other operations obtain their slot key from the observation. Mutation success returns a `Ready` or `Absent` status with a fresh observation.
Every observation-taking operation resolves the reference and checks its declared kind at the native boundary.
Unknown, retired, wrong-lifetime, or mismatched references return `Stale`. A valid reference supplied to an unsupported operation returns `WrongState`.
Before request admission or starting pairing or confirmation, and again after an asynchronous reply or confirmation, the owner rereads under exclusive ownership and compares the full revision.
Raw changes retire observations of the old revision before the owner exposes a new status. A stale caller cannot mutate the new state or invoke its callbacks.

The accepted-mutation rule is one transaction under arbitration. Reread the authoritative raw state and compare the entire incoming revision before acceptance.
On a match, advance the mutation counter and retire all prior observations and pending enrollment work, then attempt replacement or removal without releasing ownership.
The backend receives only the compared raw identity, never the revision or advanced counter. Its raw precondition cannot decide owner admission.
A failed owner guard precedes acceptance and cannot retire newer observations.
This rule applies to every accepted attempt, including matching absence and every backend failure. Failed writes never revive retired observations.
Call rows apply in order. Completion and restart rows govern their named events. Effects and invalidations belong only to the named slot.

| Operation and current state | Outcome and durable effect | Invalidation |
| --- | --- | --- |
| Any call with malformed application IPC input | `InvalidInput`. No request, write, or callback. | None. |
| Any observation call with an unknown or retired reference | `Stale`. No request, write, or callback. | None. |
| Any application operation while durability or exclusion is unresolved | `Blocked(Unavailable)`. Only the recovery below is permitted. | No new observations. |
| Any operation whose required read is `Blocked(reason)` | `Blocked(reason)`. No admission, confirmation, or write. | No new observations. |
| Any observation call whose revision differs from the authoritative current revision | `Stale`. No request, write, or callback. | Old observations retire if the raw state changed. New observations are unaffected. |
| `status` with `Ready`, `Absent`, or `Unreadable` | Return the corresponding `Status` and current observation. No write. | None unless raw state changed. |
| `enroll` with matching `Ready` or `Absent` | Start pairing with the captured revision. A validated reply must pass the guard again. Durable replacement returns a new `Ready`. | Retire on accepted mutation. |
| `enroll` with `Unreadable` | `WrongState`. No pairing or overwrite. | None. |
| `forget` with matching `Ready` or `Absent` | Accept removal. Return fresh `Absent` only after durable absence, including already absent slots. | Retire on acceptance, including absence. |
| `forget` with `Unreadable` | `WrongState`. No removal. | None. |
| `discard` with matching `Unreadable` | Obtain native user confirmation, including unsupported-version downgrade risk. Recheck the guard after confirmation, then accept removal. Durable absence returns fresh `Absent`. | Retire on acceptance. |
| `discard` with `Ready` or `Absent`, or declined confirmation | `WrongState`, or `Cancelled` for declined confirmation. No write. | None. |
| `execute` with matching `Ready` | Admit the bounded request with its captured observation and credential. No store write. | None. |
| `execute` with `Absent` or `Unreadable` | `WrongState`. No request. | None. |
| Pairing or transport fails before a store mutation | `PairingFailed` or `NetworkFailed`. No local credential-store write. Remote enrollment or command effects may already exist. No automatic pairing retry. | None. |
| Backend returns `ExclusionLost` | `Blocked(Unavailable)`. No backend write. The current record may belong to another writer. Require the restart recovery below. | Keep accepted retirement. No new observations or writes. |
| Backend returns `NoWrite(reason)` | `Blocked(reason)`. Previous durable record remains. Later status requires an authoritative read. | Keep retirement from any accepted attempt. |
| Backend returns `CommitUnknown` | `Blocked(Unavailable)`. No success, new observations, or admission. The uncertain write must finish or be fenced against any later write before authoritative durable readback can resolve it. A timeout does not prove this. | Keep retirement. |
| Quiescent or fenced mutation has authoritative readback | The complete intended record including its fresh generation, or intended absence, establishes success. The exact prior record establishes no write. Either permits fresh status. An unexplained third identity requires the restart recovery below and stays `Blocked(Unavailable)` until then. | Old references stay retired. |
| Readback fails or cannot establish durable identity | Remain `Blocked(Unavailable)`. Cached data cannot resolve the outcome. | No new observations. |
| A response or callback arrives for a retired observation | Deliver the bounded response or failure only to the original caller. No authority change, retirement, status publication, or replacement-connection callback. | None. |
| A 401 arrives for an admitted observation whose full revision still matches | Under arbitration, return `Unauthorized`, advance the counter, and retire that captured current revision. No store write. | Later status may issue a fresh observation, even for the same durable record. An older 401 cannot retire it. |
| Owner restart, including exclusion-loss or third-identity recovery | Restore arbitration and establish quiescence or fencing of all pending and predecessor writes, then restart and read authoritative status before issuing observations. Restart alone does not stop late writes. | Every reference from the previous owner lifetime is invalid. |

## Native transport and application recovery

The native boundary independently validates closed IPC inputs and rejects unknown fields.
Enrollment accepts a bounded invitation and the exact native pairing reply. The reply and bearer secret remain native.
Execution accepts the existing closed service requests except `pair`, and verifies host scope against the observed credential.
JavaScript cannot supply a destination URL, authentication header, cookie, or replacement host identity.
Native code chooses routes and headers from the [native wire rules](../development/recorded-host.md#native-protocol-prerequisite), rejects redirects, and enforces invitation, request, response, and deadline bounds.
Service replies contain only bounded service data and safe transport metadata. Errors use fixed secret-free categories.
Any local failure after remote pairing success, including `Stale` or `Blocked`, may leave a consumed invitation and an unused host credential until expiry or revocation.

Each `ServiceConnection` binds one immutable ready observation. Replacement creates a new connection, and retirement closes the old connection's feeds.
The [service engine](../../packages/client/src/service-engine.ts) retains service decoding and resynchronization duties.
Its `ServiceExecutor` returns a fetch `Response` through an internal seam, not a [public package export](../../packages/client/package.json).
Its browser `pair()` generation counter does not coordinate native ownership. A future adapter must enforce the table's admission and callback rules.
Forgetting is local. The existing host device-revocation command remains authoritative for server access.
Credential transitions preserve drafts, saved commands, receipts, and unresolved effects.
Aborting a request, closing a feed, removing a credential, or losing a process does not prove that an admitted command failed.
Recovery preserves the original host, conversation, command ID, and body. No credential transition automatically replays or replaces a command.

## Platform requirements and qualification

The macOS adapter must own credentials in Rust and use application-restricted OS protected storage.
The iOS adapter must own credentials in Swift and use app-restricted, device-local, nonsynchronizing Keychain items.
Each adapter must document and qualify access policy, lock behavior, backup, migration, and signing-identity or access-group changes.
`PermissionDenied` requires a documented user recovery path, including permanent identity-change failures and any necessary OS-level item removal.
Blocked access never authorizes automatic deletion. There is no plaintext or browser-cookie fallback.
Bearer secrets never enter JavaScript, bridge replies, preferences, browser storage, logs, URLs, crash diagnostics, telemetry, or customization Git.
Invitation codes may exist transiently in user input and enrollment IPC, then must be cleared. They must not be persisted, logged, or placed in URLs.
The existing [pairing form](../../apps/desktop/src/shell/PairForm.tsx) holds invitation input in React state and clears it on submit, which is the permitted transient copy.
Native diagnostics redact authorization and pairing bodies, including platform error text. Native code limits transient secret copies.
Protected storage does not isolate credentials from a compromised native process.

The [Rust entrypoint](../../apps/desktop/src-tauri/src/main.rs) configures the shell and optional browser navigation.
The [Swift entrypoint](../../apps/ios/native/ios/AgentUI/AppDelegate.swift) starts React Native. Neither implements these interfaces.
[Native HTTP tests](../../tests/application/native-http.test.mjs) cover route and class separation, expiry, revocation, and original-command recovery.
Their [private fixture](../../tests/application/support/native-client.mjs) holds one immutable in-memory credential.
Those tests do not qualify protected persistence, native IPC, replacement safety, installed applications, TLS, LAN access, or remote phone access.

| Future qualification | Required evidence |
| --- | --- |
| Revision and transition table | Exercise every row, all nonmatching observation kinds, absent-forget races, delayed confirmation, parallel pairing, late callbacks, and restart. Stale work cannot publish access or affect replacements. |
| Ownership and durable outcomes | Qualify all participants and external writers, exact raw changes, atomic mutations, every failure outcome, and readback after pending and predecessor writes are quiescent or fenced. Unarbitrated mutation remains unavailable. |
| Binding and platform protection | Prove application, profile, class, endpoint, and host isolation, plus the record's principal binding. Qualify locks, backup, identity changes, migration, denied-access recovery, bounds, redirects, and redaction. |
| Application recovery | Preserve original command identity and unresolved effects through every credential transition without automatic replay. |
