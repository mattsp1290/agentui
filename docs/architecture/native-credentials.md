# Native protected credentials

The standard `./agentui` launcher uses a trusted host over loopback or an SSH tunnel. It does not use this pairing or Keychain path. See [launcher setup](../development/launcher.md). This document describes the separate protected native entry.

The stock Mac app implements the bounded single-profile subset below. The detailed multi-platform interfaces and qualification table in this reference remain future work.

## Current stock Mac delivery

Normal installed launch uses bundled app assets and Rust-owned native transport to `http://127.0.0.1:7140`. Start the local host first. Request an invitation with `invite-native --data-dir /absolute/private/host-directory`, then paste the returned `value` object, including `hostId` and `code`, into **Native pairing invitation**. Select **Pair this Mac**. The invitation clears on submit.

The existing chat UI provides saved-history search, registered-agent selection, conversation bindings, streaming, approvals, Stop, drafts, and original-command recovery. **Reconnect** explicitly reads protected access and opens a new connection session after local storage drains. It never resubmits an effectful command. A stable `native-mac-default` view retains the saved route, drafts, outbox, and pending creation across same-build process restarts.

Rust stores one complete versioned record in the default macOS Keychain under service `homes.birb.agentui.native.v1`, account `mac-default`. Each admitted request rereads and compares the exact protected record. Secrets never enter JavaScript, browser storage, URLs, preferences, or bridge replies. Native HTTP rejects redirects and caller-supplied destinations, headers, cookies, or bearer secrets. It has response caps, fixed safe errors, and a 20-second deadline. Only the bundled local main document has credential command authority. External navigation and new windows are denied in normal native mode. `--host-url` remains an explicit browser development route with no credential IPC authority.

**Forget local pairing** removes only that protected item after explicit action. It preserves local work and does not revoke the host device. Use the existing host `devices` and `revoke` commands for server revocation. Unreadable records require additional native confirmation before removal. Denied or locked reads never authorize automatic replacement, deletion, or a plaintext fallback. Restore access in macOS Keychain Access and select **Reconnect**. If the app's code identity changed, resolve the item's application access policy explicitly; the app cannot silently repair it.

This implementation uses the classic login-Keychain creating-application ACL, not data-protection access groups or iCloud storage. A process-lifetime advisory profile lock excludes cooperating AgentUI copies using the same Application Support directory. External Keychain editors and restore operations are not arbitrated. The bundle remains ad-hoc signed. Same-build persistence was exercised in a disposable signed Mac test app using a test-owned encrypted Keychain and private ephemeral host; default login-Keychain item access was denied in that worker session. These observations do not establish silent access after rebuilds, upgrades, signing changes, keychain migration, screen lock, or backup restore.

Only stock native assets are included in this unit. Embedding the exact committed custom artifact is the following delivery unit. The user's existing custom browser-hosted app is unchanged. Browser development retains its cookie adapter and existing origin storage; this unit does not migrate those records into the native profile.

Cold launch without usable protected access shows connection controls before loading local drafts. Cold offline/auth-blocked draft browsing, multiple profiles, endpoint selection, remote/TLS/iOS, signed upgrades, migration, external-writer exclusion, and the full transition/qualification table remain open. The configured macOS minimum is not a WebView API qualification claim. The actual tested bundled `tauri://localhost` origin exposed IndexedDB and Web Locks; unsupported API/storage access fails closed.

## Record and live observation

One native owner per application installation holds every slot and controls request admission within one lifetime.

```text
SlotKey = { applicationNamespace, profileId, credentialClass = native, endpoint, hostId }
Selection = SlotKey without credentialClass
ProtectedCredential = { formatVersion = 1, key: SlotKey, principalId, secret, generation }
Observation<K> = opaque native-issued reference with observed kind K
LiveReferences = reference -> { kind, key: SlotKey, rawIdentity: ExactRecord | Absent }
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
The [host policy](../../apps/host/src/access.ts) gives newly enrolled native credentials 30 days and browser development credentials one hour. Existing rows are not extended. Revocation remains authoritative. `Ready` establishes local admission only.

The owner keeps at most one live reference per slot and reuses it for unchanged status reads.
Each owner lifetime has a fresh tag from at least 128 CSPRNG bits. Each reference carries that tag and at least 128 fresh CSPRNG bits.
Allocation retries collisions against live entries. Other collisions have negligible probability. The owner retains no retired entries or tombstones.
Retirement deletes the entry. Unknown and retired references are indistinguishable and return `Stale`.
The owner guard requires the current lifetime tag, a live entry, and an authoritative raw identity matching that entry, including unreadable bytes or absence.
Raw identities remain native. JavaScript receives only opaque references, never record bytes or fingerprints.
An identity that cannot be established produces `Blocked(Unavailable)`.
Before replacement, the owner constructs the complete intended record with a fresh `generation` from at least 128 CSPRNG bits.

## Ownership and private store

The owner arbitrates all windows, bridges, processes, and extensions across all slots.
Exclusive ownership covers the authoritative reread, owner guard, mutation, and publication of its outcome.
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

The private backend reads raw state and compares only `expectedRaw`. It has no reference table or owner lifetime.
The owner validates the native pairing reply and selected binding before constructing the complete replacement record.
Backend replacement atomically writes that record. Removal accepts any exact raw identity, including unreadable records and absence.
The backend has no knowledge of caller operations, observations, admission policy, or user confirmation.
`Committed` and `Removed` require durable evidence that a subsequent process can observe the replacement or absence.
`ExclusionLost` means the raw precondition failed after owner acceptance. The backend performs no write, but another writer may have changed the record.

## Owner interface and transitions

```text
status(selection: Selection) -> Status | InvalidInput
enroll(observation: Observation<Ready | Absent>, code) -> Status.Ready | Failure
forget(observation: Observation<Ready | Absent>) -> Status.Absent | Failure
discard(observation: Observation<Unreadable>) -> Status.Absent | Failure
execute(observation: Observation<Ready>, request) -> BoundedServiceResponse | Failure
Failure = InvalidInput | Stale | WrongState | Cancelled | Blocked(StorageBlock)
        | PairingFailed | NetworkFailed | Unauthorized
```

`status(selection)` is the sole selection entry point. Invalid application, profile, host, or endpoint configuration returns `InvalidInput`.
Native enrollment requires the expected host ID before pairing.
Other operations obtain their slot key from the observation. Successful mutations return a fresh observation.
Every observation-taking operation resolves the reference and checks its declared kind at the native boundary.
The owner applies the guard under exclusive ownership before admission, pairing, or confirmation, and again after the pairing reply or discard confirmation.
Every `execute`, including long-poll pulls, requires that protected-storage read. Cached credentials cannot bypass locked storage.

The accepted-mutation rule is one transaction under arbitration. The owner applies the guard, then deletes that slot's live entry before attempting replacement or removal.
Pending pairing and confirmation work keeps its captured reference, so accepted removal of absence also invalidates that work.
The backend receives only the compared raw identity. A failed guard cannot retire a newer reference.
Call rows apply in order. Completion and recovery rows govern their named events. Ordinary retirement is slot-local. Owner recovery invalidates all slots.

| Operation and current state | Outcome and durable effect | Invalidation |
| --- | --- | --- |
| Any call with malformed IPC input or invalid selection configuration | `InvalidInput`. No request, write, or callback. | None. |
| Any observation call with a wrong-lifetime, unknown, or retired reference | `Stale`. No request, write, or callback. | None. |
| Any application operation while durability or exclusion is unresolved | `Blocked(Unavailable)`. Only the recovery below is permitted. | No new observations. |
| Any operation whose required read is `Blocked(reason)` | `Blocked(reason)`. No admission, confirmation, or write. | No new observations. |
| Any live observation call whose raw identity differs from authoritative storage | `Stale`. No request, write, or callback. | Delete the mismatched entry. Other slots are unaffected. |
| `status` with `Ready`, `Absent`, or `Unreadable` | Return the corresponding `Status` and current observation. No write. | Delete any entry with a different raw identity before issuing a new reference. |
| `enroll` with matching `Ready` or `Absent` | Capture the reference for pairing. A validated reply must pass the guard again. Durable replacement returns `Status.Ready`. | Retire on accepted mutation. |
| `enroll` with `Unreadable` | `WrongState`. No pairing or overwrite. | None. |
| `forget` with matching `Ready` or `Absent` | Accept removal. Return fresh `Status.Absent` only after durable absence, including already absent slots. | Retire on acceptance, including absence. |
| `forget` with `Unreadable` | `WrongState`. No removal. | None. |
| `discard` with matching `Unreadable` | Obtain native user confirmation, including unsupported-version downgrade risk. Recheck the guard after confirmation, then accept removal. Durable absence returns fresh `Status.Absent`. | Retire on acceptance. |
| `discard` with `Ready` or `Absent` | `WrongState`. No confirmation or write. | None. |
| Discard confirmation declined | `Cancelled`. No write. | None. |
| `execute` with matching `Ready` | Admit the bounded request with its captured observation and credential. No store write. | None. |
| `execute` with `Absent` or `Unreadable` | `WrongState`. No request. | None. |
| Pairing or transport fails before a store mutation | `PairingFailed` or `NetworkFailed`. No local credential-store write. Remote enrollment or command effects may already exist. No automatic pairing retry. | None. |
| Backend returns `ExclusionLost` | `Blocked(Unavailable)`. No backend write. The current record may belong to another writer. Require whole-owner recovery below, invalidating all slots. | Keep accepted retirement. No new observations or writes. |
| Backend returns `NoWrite(reason)` | `Blocked(reason)`. Previous durable record remains. Later status requires an authoritative read. | Keep retirement from any accepted attempt. |
| Backend returns `CommitUnknown` | `Blocked(Unavailable)`. No success, new observations, or admission. The uncertain write must finish or be fenced against any later write before authoritative durable readback can resolve it. A timeout does not prove this. | Keep retirement. |
| Quiescent or fenced mutation has authoritative readback | Exact equality with the complete intended record or intended absence establishes success. Generation alone is insufficient. The exact prior record establishes no write. Either permits fresh status. An unexplained third identity requires whole-owner recovery, invalidating all slots, and stays `Blocked(Unavailable)` until then. | Old references stay retired. |
| Readback fails or cannot establish durable identity | Remain `Blocked(Unavailable)`. Cached data cannot resolve the outcome. | No new observations. |
| An admitted response or failure arrives | Deliver it only to the original caller, even after reference retirement. No status publication or replacement-connection `onUnauthorized` callback. | None except the guarded 401 below. |
| A 401 arrives for an admitted reference that still passes the owner guard | Return `Unauthorized` and delete that entry under arbitration to stop sibling feeds on the rejected credential. No store write. The user reenrolls because `Ready` checks local admission only. | Later status may issue a fresh reference for the same record. An older 401 cannot retire it. |
| Owner startup or recovery after exclusion loss or a third identity | Restore arbitration and establish quiescence or fencing of all pending and predecessor writes across all slots. Start a fresh lifetime with an empty table, then read authoritative status. Starting a process does not stop late writes. | Every reference from the previous owner lifetime is invalid across all slots. |

## Native transport and application recovery

The native boundary independently validates closed IPC inputs and rejects unknown fields.
Enrollment accepts a bounded invitation and the exact native pairing reply. The reply and bearer secret remain native.
Execution accepts the existing closed service requests except `pair`, and verifies host scope against the observed credential.
JavaScript cannot supply a destination URL, authentication header, cookie, or replacement host identity.
Native code chooses routes and headers from the [native wire rules](../development/recorded-host.md#native-protocol-prerequisite), rejects redirects, and enforces invitation, request, response, and deadline bounds.
Service replies contain only bounded service data and safe transport metadata. Errors use fixed secret-free categories.
Any local failure after remote pairing success, including `Stale` or `Blocked`, may leave a consumed invitation and an unused host credential until expiry or revocation.

Each `ServiceConnection` binds one immutable ready observation. Replacement creates a new connection.
The owner pushes no lifecycle events. Callers observe retirement through `Stale` or `Blocked` replies and request `status` before reconnecting.
The native adapter fails subsequent executions so the existing service engine ends their feeds. Admitted replies remain governed by the table.
The [service engine](../../packages/client/src/service-engine.ts) retains service decoding and resynchronization duties.
Its `onUnauthorized` hook is the callback isolated to the original connection, never a replacement connection.
Its `ServiceExecutor` returns a fetch `Response` through an internal seam, not a [public package export](../../packages/client/package.json).
Its browser `pair()` state does not coordinate native ownership. A future adapter must enforce the table's admission and callback rules.
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

The [Rust entrypoint](../../apps/desktop/src-tauri/src/main.rs) restricts native admission and bundled navigation for the current Mac subset.
The [Swift entrypoint](../../apps/ios/native/ios/AgentUI/AppDelegate.swift) starts React Native and does not implement these interfaces.
[Native HTTP tests](../../tests/application/native-http.test.mjs) cover route and class separation, expiry, revocation, and original-command recovery.
Their [private fixture](../../tests/application/support/native-client.mjs) holds one immutable in-memory credential.
Those tests do not qualify protected persistence, native IPC, replacement safety, installed applications, TLS, LAN access, or remote phone access.

| Future qualification | Required evidence |
| --- | --- |
| Live references and transition table | Exercise every row, all nonmatching observation kinds, absent-forget races, delayed confirmation, parallel pairing, late callbacks, slot-local retirement, bounded live tables, and lifetime isolation across in-process and process restarts. Stale work cannot publish access or affect replacements. |
| Ownership and durable outcomes | Qualify all participants and external writers, exact raw changes, atomic mutations, every failure outcome, and readback after pending and predecessor writes are quiescent or fenced. Unarbitrated mutation remains unavailable. |
| Binding and platform protection | Prove application, profile, class, endpoint, and host isolation, plus the record's principal binding. Qualify per-request read latency, lock behavior during active feeds, backup, identity changes, migration, denied-access recovery, bounds, redirects, and redaction. |
| Application recovery | Preserve original command identity and unresolved effects through every credential transition without automatic replay. |
