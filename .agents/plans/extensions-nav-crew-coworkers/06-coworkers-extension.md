# WP7, WP8, WP10: The Coworkers extension

All new paths are under `extensions/coworkers` (new directory, created in WP7 beside `extensions/crew`).

## Evidence

Repository:

- `tests/extensions/providers/conformance/ledger.mjs` is a non-AG-UI HTTP provider registered with `providers.add`. Its `fold` emits `run-started`, `message-updated` and `run-ended`. Its `observe` runs its own loop. It is the template.
- `tests/extensions/providers/conformance/providers.mjs` holds the table of providers the conformance suite runs.
- `packages/sdk/src/providers.ts`: `ConnectedProvider` requires `capabilities` (`create`, `send`, `cancel`, `decide`, `reconcile`, `observe`), `discover`, `create`, `submit`, `reconcileCreation`, `reconcileCommand`, `snapshot`, `observe`, `close`.
- `packages/sdk/src/provider-presentation.ts`: `ProviderPresentation` requires `decodeRequest`, `decodeCursor`, `decodeState`, `decodeEvent`, `request`, `snapshot`, `apply`.
- `packages/contracts/src/conversation.ts`: `Transcript`, `TranscriptEvent` (`message-updated`, `run-started`, `run-ended`), and `RunOutcome = 'completed' | 'interrupted' | 'failed' | 'connection-lost'`.
- `docs/extensions/provider-contract.md`: a feed that ends `disconnected` leaves the conversation stopped; the host does not resubscribe by itself. `packages/host/src/provider-stream.ts` reopens only after `resync`.
- `apps/host/src/server.ts` starts observation for every saved provider conversation when a generation activates.
- `packages/contracts/src/budgets.ts`: `HOST_DEFAULT_SNAPSHOT_BYTES = 4_000_000`. `packages/host/src/sqlite-store.ts` rejects provider state over that budget.
- `credentials.use` turns any error thrown inside its action into one fixed opaque error.
- Reply text reaches the host only through observation snapshots and events. The SDK has no polling primitive.
- `crabber` appears nowhere in this repository today.

Upstream (crabber-coworkers at `44ed2ad8326a4822a67a3eeca4087cfc98f03df8`, `docs/http-api.md` and `openapi/crabber-coworkers.v1.json`):

- Every route needs `Authorization: Bearer <token>`. Success bodies carry `apiVersion: "1"`. JSON is camelCase. Unknown fields give 400.
- `GET /v1/capabilities` returns `requestContract` (`sqlite-outbox-keyed-admission-v1`), `backend`, status vocabularies and limits (`maxPromptBytes`, `maxQueuedPerConversation`, `modelTurnSeconds`, `maxPageSize`).
- `GET /v1/coworkers` returns `coworkers[{coworkerId, name, role, workspace, slack, instructions{bytes, digest}}]`.
- `POST /v1/conversations` takes `{conversationId, coworkerId}` with a client-chosen lowercase UUID. It is idempotent for the same coworker and gives 409 for another.
- `GET /v1/conversations/{conversationId}` returns `{state, messages[{requestId, role, text}], truncated}`, capped at the newest 100 requests and 4 MiB.
- `POST /v1/conversations/{conversationId}/requests` takes `{requestId, text}` and returns 202 with a receipt. It is idempotent by `(conversationId, requestId)` and text.
- `GET …/requests/{requestId}` returns the receipt with `status` in `accepted, running, cancellation_requested, completed, cancelled, failed, uncertain` and `result.text` when completed.
- `POST …/requests/{requestId}/cancel` takes `{}`.
- Error bodies are `{"error": "<code>"}`. `retry_same_request` means resend the identical request.
- A 404 on a read is not proof of absence: the first send can still commit (`docs/http-api.md`).
- Snapshot messages carry no status. Only a receipt shows `failed`, `cancelled` or `uncertain`.
- When `api.allow_remote` is true, upstream requires a TLS-terminating proxy in front of the API (`docs/http-api.md`).
- The server-side token variable is `CRABBER_COWORKERS_API_TOKEN`. The API listens on loopback unless `api.allow_remote` is true.

## WP7: Provider, server entry, list operation

Prerequisite state: WP6 merged. The order is sequential so that shared files (`package.json`, `package-lock.json`, `tests/extensions/providers/conformance/providers.mjs`) change in one branch at a time.

### Change surface

- `package.json` (new): `agentui-extension-coworkers` (outside the `@agentui/` scope, decision D12), with `agentui.extension` namespace `coworkers`, entries `server` → `./dist/server.js` and `desktop` → `./dist/desktop.js`, and `agentui.sources` for the desktop entry. Dependencies: `@agentui/sdk`, `@agentui/contracts`, `zod` at the repository's pinned version. No new third-party dependency.
- Root `package.json`: add the workspace and `extensions/coworkers/tests/*.test.mjs` to the `test` script.
- `openapi/crabber-coworkers.v1.json` (new): a byte copy of the upstream document at the observed revision, with a `REVISION` file (new) holding the 40-character commit.
- `src/client.ts` (new): a hand-written `fetch` client for the nine v1 routes. It refuses redirects, sets a per-call timeout, caps response bodies at 5 MiB, and validates responses with Zod schemas written from the OpenAPI document. It returns a closed result type for HTTP and transport failures and does not throw for them, so callers inside a `credentials.use` action can classify the failure. Every call takes an `AbortSignal`.
- `src/provider.ts` (new): the `BackendProvider`.
- `src/presentation.ts` (new): the `ProviderPresentation`.
- `src/server.ts` (new): default-export `ServerExtensionEntry`. For each `context.installations` entry it registers one provider with `context.providers.add(installation.id, …)`, taking `service` from the installation. It registers the operation below once.
- `src/poller.ts` (new): the shared polling scheduler described below.
- `src/desktop/index.tsx` (new): placeholder workspace with label `Coworkers`, replaced in WP8.

### Provider mapping

| Contract method | Behaviour |
|---|---|
| `connect` | Call `capabilities` inside `credentials.use`. Return `ProviderUnsupported` unless `apiVersion` is `"1"` and `requestContract` is `sqlite-outbox-keyed-admission-v1`. Map 401 to `authentication-failed`, a refused connection to `unavailable`. |
| `capabilities` | `create`, `send`, `cancel`, `reconcile`, `observe` supported. `decide` unsupported with a fixed reason. |
| `discover` | `GET /v1/coworkers`. One agent per coworker. Opaque ID is `coworkerId`. Name is `name`. |
| `create` | `POST /v1/conversations`. The `conversationId` is a UUID derived deterministically from the creation operation's identity, so a retry sends the same ID. Follow how `ledger.mjs` and the Crew provider derive their creation keys. 409 for another coworker is a rejected outcome. |
| `reconcileCreation` | Repeat the identical `POST /v1/conversations`. The route is idempotent for the same coworker, so success means created. 409 for another coworker is rejected. A transport failure is uncertain. Do not treat a 404 on a read as proof of absence. |
| `submit` (send) | `POST …/requests` with a `requestId` UUID derived from the command identity and the exact text. 202 is accepted. `queue_full` and `payload_too_large` are rejected outcomes with fixed reasons. `retry_same_request` and transport failures are uncertain. |
| `submit` (cancel) | `POST …/requests/{requestId}/cancel` with `{}` for the run's request. |
| `reconcileCommand` | `GET …/requests/{requestId}`. Any receipt means the send was admitted. A 404 or a transport failure is uncertain, because upstream states that the first send can still commit. Reconcile never sends a different body. A later explicit retry by the host resends the identical `requestId` and text, which upstream treats as the same request. |
| `snapshot` | `GET /v1/conversations/{conversationId}`, folded into provider state. |
| `observe` | A polling loop, described below. |
| `close` | Stop every loop and wait for in-flight requests. |

### Observation by polling

- State bound: the state holds at most the newest 100 requests, the same window upstream returns. A request that leaves the upstream window leaves the state, and `truncated` becomes true. Each stored text is capped at 16,000 bytes with a visible truncation marker. The serialized state therefore stays under 3,300,000 bytes, below the host's 4,000,000-byte budget. Because each delivery is a whole snapshot, the transcript shows the current window and a leading notice; older turns are not shown.
- State: the ordered list of `{requestId, userText, assistantText | null, status}`. Message text comes from the conversation snapshot. Status comes from receipts. A terminal receipt status is stored in state permanently and is never fetched again.
- Cursor: a SHA-256 of the canonical state. `decodeCursor` accepts a 64-character lowercase hex string.
- One poll of a conversation: fetch the conversation snapshot. For each request without a stored terminal status, fetch its receipt. If the cursor differs from the last delivered cursor, deliver one `{ kind: 'snapshot', snapshot }` item and wait for `receive` to resolve.
- Scheduler (`src/poller.ts`), one per installation:
  - A conversation with a non-terminal request is active. An active conversation is polled every 1 second.
  - A conversation with no non-terminal request is idle. An idle conversation backs off 5, 15, 60, then 300 seconds.
  - A submit on a binding makes that conversation active at once.
  - At most 4 HTTP requests are in flight per installation. Due polls queue behind that limit.
- Failure handling: a failed poll doubles that conversation's delay up to 300 seconds and tries again. The feed does not end on poll failures, because the host would then leave the conversation stopped. The feed ends only on `close()`, or as `resync` when the service reports that the conversation no longer exists.
- `after` equal to the current cursor delivers nothing until a change.
- `truncated: true` in a snapshot is kept in state. The presentation adds a leading notice message that older turns are not shown.
- The implementer confirms against `packages/host/src/provider-observations.ts` and `packages/host/src/provider-stream.ts` that a feed made only of snapshot items commits transcripts and settles receipts. If the host requires `event` items for run boundaries, switch to events produced by diffing consecutive states and keep the same cursor rule.

### Presentation mapping

- Each request is one run with `runId` equal to `requestId`.
- A request yields a user message (`messageId` `<requestId>:user`, complete) and, when `result.text` exists, an assistant message (`<requestId>:assistant`, complete).
- Run outcome, using `RunOutcome`: `completed` → `completed`; `cancelled` → `interrupted`; `failed` → `failed`; `uncertain` → `connection-lost`. Upstream `uncertain` means the service lost track of the turn's result, which is the closest meaning to `connection-lost`; `failed` would claim a known failure. `accepted`, `running` and `cancellation_requested` keep the run current.
- `request(text, binding)` builds `{ text }`. `decodeRequest` rejects text over `maxPromptBytes` read at connect, with 16 KiB as the fallback.
- No `closure` and no `continuation` hook.

### Operation

| Operation ID | Input | Calls | Output |
|---|---|---|---|
| `coworkers.list` | `{}` | `GET /v1/coworkers` | `{ coworkers: [{ coworkerId, name, role, workspace, slack, instructionsBytes }], management: false }` |

Refused codes: `invalid-input`, `unauthorized`, `unreachable`, `rejected`. The operation passes `call.signal` and sets a 10-second timeout.

### Tests and acceptance

- `tests/support/coworkers-service.mjs` (new): a fake that implements the nine routes, the idempotency rules and the status progression, with controls to hold a request in `running`, fail it, or mark it `uncertain`.
- `tests/contract.test.mjs` (new): validates every fake response used by the tests against `openapi/crabber-coworkers.v1.json` with `ajv`. A second assertion fails when `REVISION` and the document's recorded version disagree with the constants in `src/client.ts`.
- `tests/provider.test.mjs` (new): connect refusal on a wrong `requestContract`; discovery; idempotent create; send then polled completion delivers user and assistant messages and a completed run; cancel; `failed` and `uncertain` outcomes; reconcile after a lost submit response; a submit whose read returns 404 and which then commits is reported uncertain first and completes later with exactly one run; the fake goes down for 30 seconds and comes back, and a reply that completed meanwhile arrives with no client retry and no ended feed; `close` stops polling.
- A test with an upstream snapshot of 100 requests at the maximum text size shows that the state stays under the budget and observation continues.
- An operation and a `connect` test run through the host's real credential authority: a 401 maps to `authentication-failed` and `unauthorized`, not to an opaque thrown error.
- `tests/poller.test.mjs` (new): with 50 idle conversations and a fake clock, the request rate settles at or below 50 conversation reads per 300 seconds and never exceeds 4 requests in flight; a terminal receipt is never fetched twice.
- Add the provider to `tests/extensions/providers/conformance/providers.mjs` with the fake service, and pass the suite. Record which conformance cases are declared unsupported (`decide`).
- A host-level test starts the built host with the installed extension, creates a conversation through the service API, submits text and reads the assistant reply from the conversation feed.
- Live qualification: run `crabber-coworkers serve` at `44ed2ad8326a4822a67a3eeca4087cfc98f03df8` with one configured coworker, then list and complete one chat turn through the extension. Record the result in `docs/qualification/coworkers.md` (new, beside `docs/qualification/crew.md`). If the service cannot be run, state in the pull request and in that document that the live run did not happen.
- `git grep -n -i "crabber\|coworker" -- apps packages scripts templates` returns nothing. The boundary test does not check these words; this is a manual check that core code stays generic.

## WP8: Teams-style workspace view

Prerequisite state: WP7 merged.

### Change surface

- `src/desktop/index.tsx`: return `{ modules: [], workspace: { label: 'Coworkers', component: CoworkersWorkspace, transcript: CoworkersTranscript }, dispose }`.
- `src/desktop/CoworkersWorkspace.tsx`, `CoworkersTranscript.tsx`, `CoworkerForm.tsx`, `styles.css` (all new). Same import policy, `tsconfig.desktop.json`, peer dependencies and stylesheet rules as WP6. Every selector starts with `[data-extension-workspace="coworkers"]`.

### Layout (Teams idiom, no Microsoft assets or names)

- A nested `ThemeScope` with a neutral grey surface and an indigo accent derived from the colour roles.
- A slim inner app bar on the left with two icon tabs: `Chat` and `Coworkers`.
- `Chat` tab:
  - a chat list column, about 300px, with one card per conversation: round avatar with initials, coworker name and catalog preview, under the heading `Chats`;
  - a main pane with a header (avatar, coworker name, role, and pill tabs `Chat` and `About`);
  - `props.conversation` fills the `Chat` pill;
  - `CoworkersTranscript` renders bubbles: the user's messages right-aligned on the accent tint, the coworker's left-aligned on a neutral surface with the avatar and name above the first bubble of a group;
  - a running request shows a typing indicator row. This is the only progress signal, because replies are not streamed.
- `Coworkers` tab: a card grid of coworkers with name, role, workspace access badge, a Slack badge when `slack` is true, and a `Chat` button.
- `About` pill: coworker ID, role, workspace access, instruction size in bytes.
- Below 640px of content width the chat list becomes the first screen and a conversation is the second.

### Behaviour

- Coworker cards come from `props.agents` joined with `coworkers.list` on `providerAgentId`.
- A coworker's conversations are `props.conversations.entries` whose `provider.providerAgentId` equals the coworker ID.
- `Chat` on a card switches to the `Chat` tab filtered to that coworker. With no conversation it calls `props.create(agent.id)`. With one or more it opens the first in list order. A `New chat` button always creates.
- The chat list order is the catalog order the host returns. The host has no activity time, so the list makes no recency claim.
- Create, Edit and Delete controls are present and disabled with the tooltip `Requires a newer Coworkers service` while `management` is false.
- With no installation: a setup panel that names the configuration file and the variable `AGENTUI_EXTENSION_COWORKERS_TOKEN`, and notes that the service must listen on an address the host can reach.
- With an unavailable installation: the sanitized status and a `Retry` button.

### Tests and acceptance

- `tests/desktop.browser.test.mjs` (new). It uses `extensionFixture` (WP3) with the built server entry configured against the fake service and the real `apps/desktop/web-dist-browser` build:
  - the Extensions list shows `Coworkers` as `Ready`;
  - the `Coworkers` tab lists the fake's coworkers;
  - `Chat` creates a conversation; a sent message shows the typing indicator while the fake holds the request, then the reply bubble;
  - a failed request shows the host's failure state inside the conversation node;
  - with three conversations for one coworker, the `Chat` button opens the first in list order;
  - management controls are disabled.
- Structural style assertions: the workspace has an inner app bar with `Chat` and `Coworkers` tabs, the conversation header has `Chat` and `About` pills, and the user's messages and the coworker's messages render in bubble containers on opposite sides.
- With both extensions loaded, the computed styles of the Chats view's composer and one transcript message equal those recorded without them, and Crew workspace styles are unchanged by the Coworkers stylesheet.
- The page loads with no CSP violation in the console.
- An axe-core pass in light and dark appearance.
- Screenshots in light and dark appearance are attached to the pull request. The owner's visual sign-off is a definition-of-done item, not a merge gate.
- With both extensions bundled and configured, a test opens Crew, then Coworkers, then Chats, and confirms each view renders its own transcript style for its own conversations and the default transcript in Chats.

## WP10: Adopt coworker management (gated by G3)

Prerequisite state: work package U-Coworkers delivered (see [07-upstream-requests.md](07-upstream-requests.md)) and gate G3 passed, including the owner's two decisions named in the request (borb and operator token scope). If the delivered contract differs from the request, the implementer updates this section from the response before coding. Unresolved decision U2 (borb) is answered in the response.

### Change surface

- Replace `openapi/crabber-coworkers.v1.json` and `REVISION` with the delivered revision. Extend `src/client.ts` and its schemas.
- `connect` reads the delivered capability (requested name: `coworkerManagement`). `coworkers.list` returns `management` from it and adds `source` per coworker.
- `src/operations.ts` (new, or extend `src/server.ts`) adds:

| Operation ID | Calls | Notes |
|---|---|---|
| `coworkers.get` | `GET /v1/coworkers/{coworkerId}` | returns instruction text, `revision`, `source` |
| `coworkers.create` | `POST /v1/coworkers` | `agentsChanged: true`; idempotent by ID and body |
| `coworkers.update` | `PATCH /v1/coworkers/{coworkerId}` | sends `ifRevision`; `agentsChanged: true` |
| `coworkers.delete` | `DELETE /v1/coworkers/{coworkerId}` | `agentsChanged: true` |

- Refused codes add `conflict` (stale revision, different body for an existing ID, config-owned coworker, running conversation) and `unsupported`.

### View behaviour

- Create: `CoworkerForm` with ID (lowercase slug), name, role, instructions, workspace access (`disabled`, `read_only`, `read_write`). Submit calls `coworkers.create`.
- Read: the `About` pill shows instruction text from `coworkers.get`.
- Update: the form opens prefilled from `coworkers.get` and submits `coworkers.update` with the `revision` it read. A `conflict` reloads the current definition and asks the user to reapply.
- Delete: a confirm step states that conversation history and workspace files are kept and that the ID cannot be reused. A `conflict` because a turn is running tells the user to retry when the coworker is idle.
- A coworker with `source: "config"` shows a `Managed by config.json` badge and has no Edit or Delete action.

### Tests and acceptance

- The fake service gains the delivered routes and passes the contract test against the new document.
- Browser tests: create then chat; read instruction text; edit and see the new text in `About`; stale-revision conflict; delete removes the card and keeps the old conversation readable; a config coworker is read-only.
- A test against the fake with management disabled confirms the WP8 behaviour is unchanged.
- Extend `docs/qualification/coworkers.md` (created in WP7) with a live procedure for management against a real `crabber-coworkers serve` at the delivered commit. State plainly if it was not run.
