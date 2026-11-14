# Crew public client example

This standalone integration example attaches an AgentUI conversation to an existing Crew conversation and member through the packed `@birbcrew/client` HTTP SDK. Crew remains the remote authority. The example does not create members, start native engines, register a provider SDK extension, or implement a server provider lifecycle. That public extension contract is still pending.

`connectCrewConversation` verifies the existing conversation through GET. Its local journal binds the AgentUI host/conversation scope, Crew installation, Crew conversation, member, original request UUID and exact request body. A send saves that intent before HTTP submission. A lost reply leaves it available after process recreation. `retry()` submits the original identity and body. `reconcile()` reads request status through GET and updates the local receipt; it never dispatches or creates a request. A missing status remains unresolved. No automatic retry runs.

Run `npm ci` and `npm run build` from the repository root. Use a separate journal file and a single owner for each conversation. The filesystem storage flushes the file, renames it, and flushes its directory before returning. Concurrent processes sharing the same journal require a separate locking/storage design.

```js
import { CrewClient } from '@birbcrew/client';
import { connectCrewConversation } from '@agentui/example-crew';
import { fileIntents } from './examples/crew/dist/file-intents.js';

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

A nonterminal or unknown request blocks another send. Once a completed, failed or cancelled receipt is saved, a new send receives a new UUID. Crew owns request admission and deduplication. This example preserves that identity; its controlled HTTP fixture does not qualify real Crew SQL, Temporal, native execution, credentials, or provider effects.

`npm test` includes the example's HTTP-boundary tests. They exercise the actual packed SDK against a local controlled server, including dropped replies, exact retry bodies, read-only lookup, failed local saves and foreign authority rejection. The host/client proof in `tests/client/host-integration.test.mjs` separately uses real SQLite and a versioned recorded provider fixture.

The archive under `vendor/crew-client/80c9804cfae7d5c323dbbdda77071ac9d0939877/` was built from a clean Git archive of that exact revision. Its manifest records the source package tree, both archive digests, build versions and npm integrity. The retained MIT license covers the package. This is a candidate pin awaiting the upstream review gate, not a release qualification claim.

The root SDK and `/contract` imports need no AG-UI runtime. This example does not import `/agui`. AgentUI's existing pinned AG-UI fork remains unchanged. The SDK supports Node 22 and 24 independently of Crew's full service runtime. AgentUI's host tests require the repository's pinned Node 24 runtime.
