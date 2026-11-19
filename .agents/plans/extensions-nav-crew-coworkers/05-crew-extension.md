# WP5, WP6, WP9: The Crew extension

All paths are under `extensions/crew` after WP4.

## Repository evidence

- `src/provider.ts`: `crewProvider` closes over one `memberId` from `CrewProviderOptions`. That value is used in `member()` (synchronous, called from validation, rejects other agents with `'Foreign Crew member'`), in settlement, in `createHandoff`, in `openConversation`, in `decide`, in observation, and in the grant and permission paths. `discover` pages `listMembers` and returns the one matching member named `` `Crew · ${member.engine} · ${member.profile}` ``. Registration is `context.providers.add('member', …)`. `protocolVersion` must be `'1'`.
- `packages/host/src/providers.ts` rejects a discovery that returns more than 1000 agents.
- The provider already uses `CrewClient` methods `capabilities`, `listMembers`, `openConversation`, `conversation`, `submit`, `cancel`, `requestStatus`, `createHandoff`, `handoff`, `listGrants`, `revokeGrant`, `decide`, `decisionRecord`, `approvalDetail`, and `createCrewObserver` from `@birbcrew/client/agui`.
- `tests/support/crew-service.mjs` is the fake Crew service.
- `tests/extensions/providers/conformance/providers.mjs` (repository root) runs the conformance suite against the Crew provider.
- Upstream facts (Crew `origin/main` at `775fd7299d186c2c75d9c59e9285ad66b2631c05`): `POST /v1/members` takes `{requestId, engine, profile, instructions?, instructionPacks?}` and returns `{memberId, engine, profile, subagents, instructions?: {bytes, digest}, instructionPacks?}`; an unregistered profile gives `409 unknown_profile`; engines are `pi`, `claude`, `codex`; a conversation closes after 128 turns; the member list page size defaults to 50 and is capped at 100.
- The vendored tarball `vendor/crew-client/dfe1c288bc4f0e338011389e10ad35656d6e4154/birbcrew-client-0.1.0.tgz` already contains `createMember`. That pin is behind Crew `origin/main` with no difference under `packages/client`.
- `credentials.use` turns any error thrown inside its action into one fixed opaque error. The existing provider catches inside the action for that reason.

## WP5: Server entry, multi-member discovery, member operations

Prerequisite state: WP4 merged.

### First step

Refresh the vendored client to current Crew `origin/main`: pack `packages/client` at that commit, vendor it under `vendor/crew-client/<commit>/`, update the dependency path and the root `overrides` key, and rerun the existing Crew tests. Follow `vendor/README.md`. If the Crew checkout cannot be fetched or packed in the implementing environment, keep the current pin and state that in the pull request.

### Change surface

- `src/provider.ts`:
  - `discover` returns every member as an agent. `ref` carries the member ID as the opaque ID. `name` is `` `${member.engine} · ${member.profile}` `` until WP9 adds names.
  - Remove the `'Configured Crew member is not available'` failure. An owner with no members is `available` with an empty agent list.
  - Replace the closed-over `memberId` at every call site listed under "Repository evidence". Each path derives the member from its own binding (`binding.creation.agent.opaqueId`) or, for creation, from the creation intent's agent.
  - `member()` stays synchronous and structural: the opaque ID must be a well-formed member ID and the binding must belong to this installation. It makes no network call. Crew rejects an unknown member when the call is made.
  - Standing-grant permission reads and revokes use the member of the binding they are called for.
  - `CrewProviderOptions.memberId` is already optional (WP4b). When present it restricts discovery to that member. The conformance suite and existing tests may keep using it.
  - Bound discovery by agent count: stop when 1000 members are read and report the installation `available` with those agents. Record the truncation through the existing observability path. Keep the existing per-page timeout.
- `src/server.ts` (created in WP4): for each `context.installations` entry, register one provider under the grant `id` and register the operations below once with `context.operations.add`. Each operation builds its `CrewClient` from `call.installation.service` inside `credentials.use({ credential: call.credential, service: call.installation.service }, …)`.
- `src/operations.ts` (new):

| Operation ID | Input | Calls | Output |
|---|---|---|---|
| `members.list` | `{}` | `listMembers`, up to 1000 members | `{ members: [{ memberId, engine, profile }], truncated }` |
| `members.create` | `{ requestId, engine, profile, instructions? }` | `createMember` | `{ member: { memberId, engine, profile } }` with `agentsChanged: true` |

  - Each operation decodes `input` with the Zod schemas the package already depends on and returns `refused` with code `invalid-input` on a mismatch.
  - Each operation catches client errors inside the `credentials.use` action and returns a typed value from it. It never lets a client error cross the `use` boundary.
  - Map `CrewHttpError` codes to `refused` codes: `unknown_profile` → `unknown-profile`; 401 or 403 → `unauthorized`; any other 4xx → `rejected`. `CrewTransportError` → `unreachable`. `CrewUnknownOutcomeError` → `unknown-outcome`.
  - Each operation passes `call.signal` to its requests and sets its own 10-second timeout, below the host's 15-second deadline.
  - `members.create` is idempotent through `requestId`. The UI reuses the same `requestId` when it retries after `unknown-outcome` or `unreachable`.

### Invariants

- No operation returns the token, the service URL or raw Crew error text.
- A member created in Crew by another client appears after the next discovery.
- Existing single-member behaviour (continuation, decisions, receipts) is unchanged for each member.

### Tests and acceptance

- Extend `tests/support/crew-service.mjs` with `POST /v1/members` and several members.
- Add a contract test that validates the fake service's member and conversation responses against `@birbcrew/client/openapi.json` with `ajv`. This keeps the fake honest.
- `tests/provider.test.mjs`: discovery returns three members as three agents; an empty owner is `available`; 1001 members give 1000 agents and a truncation record, not a failed discovery.
- `tests/continuation.test.mjs` and `tests/decision-reconciliation.test.mjs`: add a case that runs on a second member in the same installation, to prove no path still uses a fixed member.
- A permission read and revoke test on a second member.
- New `tests/operations.test.mjs`, run through the host's real credential authority, not a stub: `members.list`; `members.create` success, repeated `requestId`, `unknown-profile` returned as `refused` (not `threw`), unreachable service returned as `refused` `unreachable`; a fake that never answers is abandoned when `signal` aborts and leaves no pending credential task.
- A host-level test (`tests/application/` at the repository root) starts the host with the built extension through an installed entry, calls `extension-call members.create`, then reads `metadata` and finds the new agent with `providerAgentId` equal to the new member ID.
- The conformance suite still passes for Crew.
- Live qualification: run create, list and one chat turn against a real Crew service against current Crew `origin/main`, following `docs/qualification/crew.md`, and record the result there. If no service is available, state in the pull request and in that document that the live run did not happen.

## WP6: Slack-style workspace view

Prerequisite state: WP5 merged.

### Change surface

- `src/desktop/index.tsx`: replace the placeholder with the real entry. Return `{ modules: [], workspace: { label: 'Crew', component: CrewWorkspace, transcript: CrewTranscript }, dispose }`.
- `src/desktop/CrewWorkspace.tsx`, `CrewTranscript.tsx`, `MemberForm.tsx`, `styles.css` (all new). The stylesheet follows `customizationCssPolicy` in `scripts/local-customization.mjs` and the cases in `tests/customization/build/css-url-expressions.test.mjs`. It is imported from the entry and ships as a file. Every selector starts with `[data-extension-workspace="crew"]`.
- Imports stay inside the bundling policy: `react`, `@agentui/sdk/react`, `@agentui/contracts/*`, `@agentui/theme/react`, `@agentui/ui-primitives/desktop`. No `@birbcrew/client` import in desktop code.

### Layout (Slack idiom, no Slack assets or names)

- A nested `ThemeScope` with a dark aubergine sidebar palette and a light message area. Derive both from the 11 colour roles so light and dark appearance both work.
- Left sidebar, about 260px:
  - a workspace header with the installation ID and a compose button;
  - a section `Members` listing each agent as a direct-message row: square rounded avatar with initials, label, and a status dot from `availability`;
  - under the selected member, its conversations as indented rows with the catalog preview;
  - an `Add member` row at the end of the section.
- Main area:
  - a header bar with the member label, engine and profile, and a details button;
  - `props.conversation` filling the rest. The host-rendered node keeps the composer and approvals.
  - `CrewTranscript` renders flat rows (avatar, bold sender name, message text, no bubbles) with Markdown through the same components the default transcript exposes to extensions. If the SDK exposes none, render text as the SDK example does and record the gap in the pull request.
- Details panel on the right (toggle): member ID, engine, profile, and the actions that exist in the current phase.
- Below 640px of content width the sidebar becomes a drawer.

### Behaviour

- Member rows come from `props.agents`. Extra details come from `members.list`, joined on `providerAgentId`.
- A member's conversations are `props.conversations.entries` whose `provider.providerAgentId` equals the member ID.
- Selecting a member with no conversation shows an empty state with a `Start conversation` button that calls `props.create(agent.id)`.
- Selecting a conversation row calls `props.open(scope)`.
- `Add member` opens `MemberForm`: engine select (`pi`, `claude`, `codex`), profile text field, instructions textarea. Submit calls `members.create` with a `requestId` generated once per form instance. On `ok` it calls `props.refresh()` and selects the new member. On `refused` it shows a fixed message per code. On `failed` (including `unavailable` and `timeout`) it shows a generic failure and keeps the form and the same `requestId` for retry.
- With no installation: a setup panel that names the configuration file and the variable name `AGENTUI_EXTENSION_CREW_TOKEN`, and links to the documentation. No token entry field.
- With an unavailable installation: the sanitized status and a `Retry` button that calls `props.refresh()`.
- Edit and Delete controls are present and disabled in this phase with the tooltip `Requires a newer Crew service`. WP9 enables them.
- A concluded conversation (128 turns or closed) shows the host's existing state inside the conversation node. This plan adds no Continue control.

### Tests and acceptance

- New `tests/desktop.browser.test.mjs` in the extension, covered by the root `extensions/crew/tests/*.test.mjs` glob. It uses `extensionFixture` (WP3) with the built Crew server entry configured against the fake Crew service, and the real `apps/desktop/web-dist-browser` build. It does not use `customRuntime`.
  - the Extensions list shows `Crew` as `Ready`;
  - the sidebar lists the fake's members;
  - `Add member` creates a member that then appears and is selected;
  - `Start conversation` then typing in the composer sends a message, and the fake's reply renders in `CrewTranscript`;
  - an `unknown-profile` refusal shows its message and keeps the form;
  - with no installation the setup panel renders and no network call leaves the page except to the host origin.
- Structural style assertions: the workspace has a member sidebar landmark, message rows are flat list rows with a sender name and no bubble container, and the sidebar background differs from the message area background.
- With the extension loaded, the computed styles of the Chats view's composer and one transcript message equal those recorded without it.
- The page loads with no CSP violation in the console.
- An axe-core pass on the workspace in light and dark appearance.
- Screenshots of the workspace in light and dark appearance are attached to the pull request. The owner's visual sign-off is a definition-of-done item (see [08-execution-handoff.md](08-execution-handoff.md)), not a merge gate.

## WP9: Adopt Crew member management (gated by G2)

Prerequisite state: work package U-Crew delivered (see [07-upstream-requests.md](07-upstream-requests.md)) and gate G2 passed, including the owner's answer to unresolved decision U3. The response file names the delivered contract. If the delivered contract differs from the request, the implementer updates this section's table from the response before coding.

### Change surface

- Vendor the delivered client tarball under `vendor/crew-client/<commit>/` and update the dependency and the root `overrides` key.
- `src/operations.ts` adds, each guarded by the capability block the response names:

| Operation ID | Calls | Notes |
|---|---|---|
| `members.get` | `member` | includes `name`, retirement state, instructions summary |
| `members.instructions` | `memberInstructions` | returns instruction text for the details panel |
| `members.retire` | `retireMember` | `agentsChanged: true` |
| `profiles.list` | `listProfiles` | feeds the profile select |

- `members.create` accepts `name`. `members.list` returns `name` and can include retired members.
- `src/provider.ts`: the agent `name` is the member `name` when present. Retired members are not returned by `discover`.
- A missing capability gives `refused` with code `unsupported`. The view then keeps the WP6 disabled state for that control.

### View behaviour

- Create: adds a name field. The profile field becomes a select fed by `profiles.list`, with free text as the fallback when the operation is unsupported.
- Read: the details panel shows name, engine, profile, instruction text and retirement state.
- Update: an `Edit` action opens the form prefilled from `members.get` and `members.instructions`. Its confirm step states: "Crew members cannot be changed. This creates a replacement member and retires the current one. Grants, memory, routines and budgets stay with the retired member." Confirm runs `members.create`, then `members.retire` on the old member. If retire fails after create succeeded, the view shows both members and a `Retire old member` retry. It never reports the edit as complete in that state.
- Delete: a `Retire` action with a confirm step that states that existing conversations stay readable. It runs `members.retire`.
- Conversations of a retired member stay listed under a `Retired` section. They remain in `props.conversations` because the catalog filter reads the stored installation (WP2). They open through the host's existing state for a conversation whose agent is no longer available.

### Tests and acceptance

- The fake service gains the delivered routes and passes the OpenAPI contract test against the new client's `openapi.json`.
- Browser tests: create with name; read details with instructions; edit produces a new member and retires the old one; a failed retire after create shows the retry state; retire removes the member from `Members` and keeps its conversation readable.
- A test runs the new extension against the fake service with the capability blocks removed and confirms that Edit and Delete stay disabled and create and chat still work.
- Record a live qualification against a real Crew service at the delivered commit in `docs/qualification/crew.md`, following that document's existing procedure. State plainly if it was not run.
