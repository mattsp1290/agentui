# WP9–WP12: Delete for both services and create for coworkers

These four packages are independent of WP2–WP8. They touch `extensions/crew` and `extensions/coworkers`, so they run after WP1 to avoid conflicts in the same files.

## Evidence

Repository:

- `extensions/crew/src/operations.ts`: operations `members.list` and `members.create`, with error mapping inside the `credentials.use` action and a 10-second timeout. `extensions/crew/src/members.ts`: the shared member pager. `extensions/crew/src/operation-output.ts`: typed outputs.
- `extensions/crew/src/desktop/CrewWorkspace.tsx`: Edit and Delete controls are present and disabled with the tooltip `Requires a newer Crew service`. `MemberForm.tsx` handles create with a request key and retry rules.
- `extensions/crew/src/provider.ts`: `discover` returns every member, bounded at 1000.
- `extensions/coworkers/src/server.ts`: operation `coworkers.list` returning `{ coworkers, management: false, truncated }`. `extensions/coworkers/src/client.ts`: a hand-written client for the nine v1 routes with Zod schemas. `extensions/coworkers/openapi/crabber-coworkers.v1.json` and `REVISION`. `extensions/coworkers/tests/contract.test.mjs` validates the fake service against the OpenAPI document.
- `extensions/coworkers/src/desktop/CoworkersWorkspace.tsx`: `New coworker` and the management controls are disabled while `management` is false.
- `vendor/crew-client/dfe1c288bc4f0e338011389e10ad35656d6e4154/` holds the vendored client. The root `package.json` has an `overrides` entry for it.
- The catalog filter reads the installation stored with each conversation, so conversations of a retired member or a deleted coworker stay in the workspace list.

Upstream:

- Crew `origin/main` at `775fd7299d186c2c75d9c59e9285ad66b2631c05`: no retire route. Members are immutable and cannot be deleted.
- crabber-coworkers at `44ed2ad8326a4822a67a3eeca4087cfc98f03df8`: coworkers come from `config.json`; no create or delete route.

## WP9: U-Crew (upstream, in the Crew repository)

Prerequisite state: none in AgentUI.

- Input: `$HOME/.agents/projects/crew/requests/2026-11-18-member-retire.md`.
- Work from a fresh checkout of Crew's default branch. The local checkout at `$HOME/git/crew` was far behind when this plan was written; fetch first.
- Follow Crew's own contributor rules, tests and review process. Crew's README says authentication and permission changes need human review before merge; a retire route is a permission-relevant change, so the owner reviews it.
- Deliver: the routes and client method the request lists, merged by Crew's process; a packed `@birbcrew/client` tarball at the merge commit; the response file with the 40-character commit and the name of the capability block.
- Verification: Crew's own gates (`npm run check:openapi` and its test suite), and the consumer test the request describes. Crew's root `package.json` declares `"os": ["linux"]`, so run them on Linux.

## WP10: Crew Delete in AgentUI (gate G3)

Prerequisite state: WP1 merged and gate G3 passed. Build against the delivered contract in the response file, not the request text.

### Change surface

- Vendor the delivered tarball under `vendor/crew-client/<commit>/`. Update the dependency path in `extensions/crew/package.json`. The root `overrides` key is `@birbcrew/client@0.1.0` (a name and version); change it only if the delivered client's version changed. Run `npm install` and commit the regenerated `package-lock.json`: customization builds run `npm ci` against the committed lock, so a stale lock breaks them. Rerun the existing Crew tests before any other change.
- `extensions/crew/src/operations.ts`: operation `members.retire` (new). Input `{ memberId }`. It calls `retireMember`, returns `{ memberId, retired: true }` with `agentsChanged: true`, and maps errors as the existing operations do. A missing capability returns `refused` with code `unsupported`.
- `members.list` output gains `retire: boolean` (new field), true when the connected Crew advertises the capability. Update `operation-output.ts` and its guard.
- `extensions/crew/src/provider.ts`: map Crew's `409 member_retired` on conversation creation, handoff and send to a fixed refusal that the host shows as a fixed message (follow how the provider maps other Crew refusals today), and confirm against the delivered contract that the default member list omits retired members so `discover` needs no filter.
- `extensions/crew/src/desktop/CrewWorkspace.tsx`:
  - Delete is enabled when `retire` is true. Otherwise it keeps the disabled state and tooltip.
  - Delete opens a confirm step: "Delete <member>? Crew keeps the member's conversations and history. The member can no longer start conversations. This cannot be undone."
  - Confirm calls `members.retire`, then `props.refresh()`. The member leaves the list. Its conversations move to a `Deleted members` section and stay readable.
  - When starting a conversation fails because the member was retired from another client, the host shows the provider's fixed message, and the workspace refreshes its member list on the next `props.refresh()`.
  - Retire is idempotent upstream, so a retry after a failed or unknown outcome repeats the same call. No request key is needed.
  - Edit stays disabled.
- `extensions/crew/tests/support/crew-service.mjs`: add the retire route, the capability, the default-list omission and `409 member_retired` on a new conversation.

### Tests and acceptance

- The fake's retire responses validate against the delivered client's `openapi.json` in the existing contract test.
- `extensions/crew/tests/provider.test.mjs`: creating a conversation with a retired member returns the fixed refusal, not a generic failure.
- `extensions/crew/tests/operations.test.mjs`: retire success, repeated retire, unsupported capability, unreachable service returned as `refused`.
- `extensions/crew/tests/desktop.browser.test.mjs`: Delete with confirm removes the member, keeps its conversation under `Deleted members` and readable; cancel changes nothing; against a fake without the capability, Delete stays disabled and create and chat still work.
- The provider conformance suite passes for Crew.
- Record a live run against a real Crew service at the delivered commit in `docs/qualification/crew.md`, or state there that it was not run. The Crew service runs on Linux.
- Connected-flow check: merge `main` into the example's connected branch, let the worker build it, apply, and confirm Delete works in the app that the launcher started. The extension browser tests run against the test bundle, so this is the only check that the change reaches a user. Report it, or state that it was not run.
- `npm run verify` passes.

## WP11: U-Coworkers (upstream, in the crabber-coworkers repository)

Prerequisite state: none in AgentUI.

- Input: `$HOME/.agents/projects/crabber-coworkers/requests/2026-11-18-coworker-create-and-delete.md`, including its two proposed owner decisions.
- Work from a fresh clone of the default branch. Follow that repository's `AGENTS.md` (import crabber only through the facade crate, no `[patch]` sections, track work in `bn`).
- Deliver: the routes, the `source` field and the capability, merged by that repository's process; the regenerated `openapi/crabber-coworkers.v1.json`; the response file with the 40-character commit and the answers to the two proposed decisions. The clone used for this plan's evidence was at `44ed2ad` and could not be refreshed during planning; confirm the default branch's head first.
- Verification: `cargo xtask check` and the tests the request describes.

## WP12: Coworkers create and delete in AgentUI (gate G4)

Prerequisite state: WP1 merged and gate G4 passed, including the owner's answers to the two proposed decisions (unresolved decision U1). Build against the delivered contract in the response file. If an answer differs from the proposal, update this section's management-switch and backend assumptions before coding.

### Change surface

- Replace `extensions/coworkers/openapi/crabber-coworkers.v1.json` and `REVISION` with the delivered revision.
- `extensions/coworkers/src/client.ts`: add create and delete calls, the `source` field on list entries and the capability, with Zod schemas written from the delivered document.
- `extensions/coworkers/src/server.ts` (or a new `extensions/coworkers/src/operations.ts` if the file grows past what the existing structure holds comfortably):
  - `coworkers.list` returns `management` from the capability and `source` per coworker.
  - `coworkers.create` (new): input `{ coworkerId, name, role, instructions, workspace }`. Returns the created summary with `agentsChanged: true`. Upstream create is idempotent for the same ID and body, so a retry repeats the identical call.
  - `coworkers.delete` (new): input `{ coworkerId }`. Returns `{ coworkerId, deleted: true }` with `agentsChanged: true`.
  - Refused codes add `conflict` and `unsupported`. Map upstream `409 conflict` to `conflict`.
- `extensions/coworkers/src/provider.ts`: creating a conversation with a deleted coworker is refused upstream; map that refusal to a fixed message the same way, and add a provider test for it.
- `extensions/coworkers/src/desktop/CoworkerForm.tsx` (new, beside `CoworkersWorkspace.tsx`): fields ID (lowercase slug; the implementer takes the exact pattern and length limits from the delivered OpenAPI document), name, role, instructions, workspace access (`disabled`, `read_only`, `read_write`).
  - Fields lock while a request is pending and after an unknown outcome, and `Retry` repeats the identical request. The user cannot change the ID or body between an unknown outcome and its retry.
  - `conflict` on create says a coworker with that ID already exists or existed.
- `extensions/coworkers/src/desktop/CoworkersWorkspace.tsx`:
  - `New coworker` is enabled when `management` is true and opens the form. On success it refreshes and shows the new coworker.
  - Each card with `source: "api"` has Delete with a confirm step: "Delete <name>? Its conversations and workspace files are kept. The ID cannot be used again."
  - A card with `source: "config"` shows `Managed by config.json` and has no Delete.
  - `conflict` on delete while a turn runs tells the user to retry when the coworker is idle.
  - A deleted coworker's chats stay in the list under `Deleted coworkers` and stay readable.
  - With `management` false, the controls keep the disabled state and tooltip.
- `extensions/coworkers/tests/support/coworkers-service.mjs`: add the routes, `source`, the capability, the management switch, ID reuse refusal, and `409` on delete during a running request.

### Tests and acceptance

- `extensions/coworkers/tests/contract.test.mjs`: the fake's new responses validate against the delivered OpenAPI document.
- An operations test: create success, identical retry, conflicting body, delete success, repeated delete, delete of a config coworker, delete during a running request, unsupported capability.
- `extensions/coworkers/tests/desktop.browser.test.mjs`: create then chat with the new coworker; an unknown outcome locks the form and Retry sends the identical body; delete removes the card and keeps the chat readable; a config coworker has no Delete; with management off the controls stay disabled.
- The provider conformance suite passes for Coworkers.
- Extend `docs/qualification/coworkers.md` with a live procedure against `crabber-coworkers serve` at the delivered commit with `api.manage_coworkers` true, and record the run or state that it was not run.
- Connected-flow check, as in WP10: merge `main` into the connected branch, build, apply, and confirm New coworker and Delete work in the launcher-started app. Report it, or state that it was not run.
- `npm run verify` passes.

## Exclusions

- No update of a member or coworker.
- No hard delete in Crew.
- No Slack binding from the UI.
