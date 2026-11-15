# Crew public client example

This standalone integration example attaches an AgentUI conversation to an existing Crew conversation and member through the packed `@birbcrew/client` HTTP SDK. Crew remains the remote authority. The example does not create members, start native engines, register a provider SDK extension, or implement a server provider lifecycle. That public extension contract is still pending.

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

The archive under `vendor/crew-client/37c596577b4998fba67b09451ddb16ac0695c08d/` was built from a clean Git archive of that exact revision. Its manifest records the source package tree, both archive digests, build versions and npm integrity. The retained MIT license covers the package. The pin identifies the merged public SDK source. The controlled example tests do not establish release qualification.

AgentUI pins the example's Zod dependency to `4.6.6` and applies a root npm override to `@birbcrew/client@0.1.0` so both use that patched version. This consuming-runtime policy addresses [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The retained archive and its original `4.4.3` dependency declaration remain unchanged. Root overrides do not travel with packed libraries. A separate consumer must configure its own dependency policy, as the installed-example test does.

The root SDK and `/contract` imports need no AG-UI runtime. This example does not import `/agui`. AgentUI's existing pinned AG-UI fork remains unchanged. The SDK supports Node 22 and 24 independently of Crew's full service runtime. AgentUI's host tests require the repository's pinned Node 24 runtime.
