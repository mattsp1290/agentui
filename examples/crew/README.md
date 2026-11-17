# Crew public provider example

`crewProvider` from `@agentui/example-crew/provider` supplies a public `ServerExtensionEntry`, `BackendProvider`, and `ProviderPresentation`. It discovers one configured existing member and creates fresh AgentUI conversations. The ordinary provider chooser, transcript, approval buttons, and Stop control use the host's existing durable command store.

## Run the provider

Build the repository with its pinned Node 24 runtime using `npm ci && npm run build`. Save a private configuration file with these fields and your existing service values.

```json
{
  "service": "http://127.0.0.1:18089",
  "memberId": "11111111-1111-4111-8111-111111111111",
  "installationId": "personal-crew",
  "generation": "1",
  "credentialRevision": "owner-1",
  "tokenFile": "/absolute/private/owner.token",
  "directory": "/absolute/private/agentui-crew",
  "port": 8787
}
```

Run `node examples/crew/run.mjs /absolute/private/crew-provider.json`. Open the printed URL. Select **Provider**, select the Crew member, and start a new chat. Set `nativeConfig` to an existing AgentUI agent configuration path to keep native agents available in the same host.

Keep the installation, generation, credential revision, member, and service stable when reopening. The token is read only through the host's configured credential resolver. The provider uses the original creation UUID as the remote conversation UUID and the original send operation UUID as the remote request UUID. Recovery uses GET for those original identities. Missing status and conflicting admission remain uncertain. When a new Send is blocked by an accepted earlier send, the host checks that earlier request through its original status route before retrying admission once. A confirmed terminal result permits the follow-up; a pending, unknown or failed lookup preserves the refusal and saved draft. **Check pending command** remains available for explicit recovery. Completed, failed, and cancelled requests settle the send receipt; their transcript outcomes remain distinct. Confirmed native termination also settles the send command and ends the visible run as interrupted. The saved request status can still be uncertain, and cancellation effects remain unassessed. Settling the command does not prove that a protected action did or did not occur. Missing or unconfirmed termination evidence leaves an uncertain request active.

The public observer owns remote history. The adapter admits explicit message payloads and complete state snapshots through awaited callbacks, retains the same observer between baseline and subscription, and replaces the baseline on reopen. Its cursor records an observation epoch, admitted sequence, and known request identities. It is not a remote replay cursor. Assistant content comes from observed messages; run completion comes from the original request's public status or its explicit native termination confirmation. Closing aborts and drains local observation without cancelling remote work. Each connection is limited to 8 MiB of response bytes; restart the host for a fresh baseline if that limit ends observation. Redirects are refused.

When Crew advertises version 1 owner approval details for `record_work_item`, the provider reads the complete immutable proposal before publishing its approval card. The card shows the tool and all proposed arguments, including the exact optional note, before **Approve once** is available. The read uses the existing owner credential and exact conversation, member, request, invocation, approval, and version. Full note text is intentionally saved in this solo owner's private AgentUI conversation. Crew's passive stream still redacts it. A failed or invalid detail read pauses updates and preserves saved material; **Check for updates** or reopening can recover. The read does not promise that the action is still available, and Crew validates the original choice when submitted.

When Crew also advertises the supported standing-grant version 1 contract, a complete owner-detail card may offer **Approve this item and allow work items for this conversation**. The choice requires policy version 1, a top-level invocation and Crew’s actual offered conversation choice. It approves the current item and future owner-initiated work items in this conversation, including different notes. The permission survives model or profile changes. Member-wide grant creation remains deferred.

The persistent **Permissions** panel shows applicable conversation and member permissions after a run ends and after reconnect. Refresh a stale listing before revoking. Revoking a member permission requires explicit all-conversations confirmation. Revocation applies to later proposals; already-approved work may finish, and any other applicable member permission remains effective. A current permission read does not settle an unknown original approval or revoke acknowledgement.

Without that capability, or with an unsupported version or tool, approval cards retain their existing behavior. **Approve once** requires Crew's public completeness proof and matching `record_work_item` arguments. Incomplete cards show a warning and offer only **Deny**. Open cards can acquire richer details; reserved cards retain their original material and captured command, and closed cards stay closed. Questions use the known empty `choose_next_step` argument contract and retain the offered **Inspect** and **Test** choices, including after reopening a paused child call. Child transcripts remain hidden. Crew's decision API does not accept the host command UUID or expose a GET receipt for an exact choice. A matching positive reply completes the decision command without claiming that the protected tool completed. A lost or mismatched decision reply remains uncertain even if its card disappears or the request finishes. Older accepted decisions without an exact-choice lookup remain unresolved; the adapter does not replay them or rewrite their history. Stop retains the original request ID and reports native termination only when Crew confirms it. Real protected-write, cancellation-race, cold-worker replacement, and broad provider-availability qualification remain separate work.

The provider imports the retained `@birbcrew/client/agui` observer and the frozen AG-UI client/core/encoder/proto archives. The owner-detail update changes the source-pinned Crew client artifact while retaining wire, SDK, projection, and npm versions. `examples/crew/tests/provider.test.mjs` exercises the public HTTP/SSE boundary, SQLite reopen, approvals, Stop, callback drain, and GET-only uncertainty recovery. Controlled responses do not qualify a production Crew deployment.

## Trace the host and Crew worker

The launcher reads the same [host observability settings](../../docs/development/observability.md) as the normal host CLI. To export AgentUI request spans to a local OTLP HTTP JSON receiver, run:

```sh
OTEL_TRACES_EXPORTER=otlp \
OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 \
OTEL_SERVICE_NAME=agentui-host \
node examples/crew/run.mjs /absolute/private/crew-provider.json
```

Open the printed URL, select the Crew member, and send a message. The `agentui-host` service records admitted host requests. Tracing is disabled unless `OTEL_TRACES_EXPORTER=otlp` is set. Invalid enabled settings stop the launcher before host startup. Collector failure does not change a command result.

Configure the remote Crew worker separately using [the Crew tracing guide](../../docs/development/observability.md#configure-the-crew-worker). AgentUI does not start that worker or forward its collector settings. Crew owns actual native invocation spans. Remote conversation snapshots do not produce AgentUI `invoke_agent` spans. The two services have separate traces, without propagated trace headers or shared exported identifiers.

## Legacy standalone HTTP helper

This standalone integration example attaches an AgentUI conversation to an existing Crew conversation and member through the packed `@birbcrew/client` HTTP SDK. Crew remains the remote authority. The example does not create members, start native engines, register a provider SDK extension, or implement a server provider lifecycle. The registered provider above does not use this helper or its separate journal.

`connectCrewConversation` verifies the existing conversation through GET. Its local journal binds the AgentUI host/conversation scope, Crew installation, Crew conversation, member, original request UUID and exact request body. A send saves that intent before HTTP submission. A lost reply leaves it available after process recreation. `retry()` submits the original identity and body. `reconcile()` reads request status through GET and updates the local receipt; it never dispatches or creates a request. A missing status remains unresolved. No automatic retry runs.

Run `npm ci` and `npm run build` from the repository root. Use a separate journal file and a single owner for each conversation. The filesystem adapter targets POSIX filesystems and creates private directories and files. It reapplies file permissions when a temporary file already exists. The storage flushes the file, renames it, and flushes its directory before returning. Concurrent processes sharing the same journal require a separate locking/storage design.

```js
import { CrewClient } from '@birbcrew/client';
import { connectCrewConversation } from '@agentui/example-crew';
import { fileIntents } from '@agentui/example-crew/file-intents';

const conversation = await connectCrewConversation({
  client: new CrewClient({
    baseUrl: process.env.CREW_BASE_URL,
    token: process.env.CREW_TOKEN,
  }),
  scope: { hostId: 'my-workstation', conversationId: 'local-conversation' },
  installationId: 'my-crew-installation',
  conversationId: process.env.CREW_CONVERSATION_ID,
  memberId: process.env.CREW_MEMBER_ID,
  intents: fileIntents('/absolute/private/path/crew-intent.json'),
});

const receipt = await conversation.reconcile();
console.log(receipt, conversation.runIdentity());
```

Reopening performs no submission. To send new work, explicitly call `await conversation.send('Inspect the existing project')`. To retry a saved request, call `await conversation.retry()`.

An installation ID must consistently identify one Crew endpoint and credential authority. Changing it, the member, or either conversation scope requires a separate journal. Credentials stay in the SDK instance and are not persisted in the intent.

Observed receipts preserve future initiator kinds and additive initiator fields when saved and reopened. Submission commands retain strict validation.

The version 2 journal records an unresolved outcome, a definitive initial rejection, or an observed receipt. A definitive HTTP 4xx on the first submission is saved as rejected and permits a corrected send with a new UUID. An explicit retry of that rejected request durably invalidates the rejection before HTTP; a lost retry reply therefore blocks new work after reopening. A 4xx refusal after an earlier unknown outcome cannot establish that the earlier request was absent and never releases that identity. A failed save prevents dispatch or retains the previous recovery record.

A nonterminal or unknown request blocks another send. Crew's `uncertain` receipt means native execution reconciliation could not establish a safe final result. It remains blocking until authoritative status resolves it; it is not proof of no effect and must not be acknowledged away or replayed as new work. `reconcile()` can refresh that status without dispatching. Once a completed, failed or cancelled receipt is saved, a new send receives a new UUID. Crew owns request admission and deduplication. This example preserves that identity; its controlled HTTP fixture does not qualify real Crew SQL, Temporal, native execution, credentials, or provider effects.

`npm test` includes the example's HTTP-boundary tests. They exercise the actual packed SDK against a local controlled server, including dropped replies, exact retry bodies, read-only lookup, failed local saves and foreign authority rejection. The host/client proof in `tests/client/host-integration.test.mjs` separately uses real SQLite and a versioned recorded provider fixture.

The archive under `vendor/crew-client/f3327346d979270a18c9f46b9cfe6a075b1cb157/` pins the Crew `main` client source. It adds typed handoff creation and reading to the owner-detail and standing-grant client. It also validates a `subagents` field on each member, which defaults to legacy mode when absent. It validates optional handoff capability metadata. Member and capability reads now reject responses that violate these contracts. AgentUI uses none of these features yet. Its manifest records the exact source, source/package digests, build versions and npm integrity. The package was built from that clean source with Node 24.22.3. Crew's Node 22 `verify:client` check was not run for this pin, as the manifest records. The retained MIT license covers the package. Earlier vendor directories remain historical records. AgentUI exposes only the eligible conversation standing choice through the persistent permission controls described above; member-wide creation stays filtered.

AgentUI pins the example's Zod dependency to `4.6.6` and applies a root npm override to `@birbcrew/client@0.1.0` so both use that patched version. This consuming-runtime policy addresses [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The retained package declares `4.4.3`; AgentUI continues to override it. Root overrides do not travel with packed libraries. A separate consumer must configure its own dependency policy, as the installed-example test does.

The root SDK and `/contract` imports need no AG-UI runtime. The legacy helper does not import `/agui`. AgentUI's existing pinned AG-UI fork remains unchanged. The SDK supports Node 22 and 24 independently of Crew's full service runtime. AgentUI's host tests require the repository's pinned Node 24 runtime.
