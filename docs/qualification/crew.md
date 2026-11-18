# Crew provider extension qualification

Assessment date is 2026-11-17. This assessment covers `agentui-osyo`, the Crew example provider extension. It qualifies creation, streaming, host restart and resume against a real Crew service. It lists the capability gaps that remain.

The extension is `crewProvider` from `agentui-extension-crew/provider`. It is a registered public provider contribution. It discovers one configured existing Crew member and creates fresh AgentUI-owned conversations against it. It never imports existing Crew conversation history. Crew remains the execution, approval, cancellation and recovery authority. The [example README](../../extensions/crew/README.md) describes configuration and behavior.

The deployment model is the one in [AGENTS.md](../../AGENTS.md). One owner runs AgentUI and Crew on a private overlay network. There is no device pairing or service attestation.

## Exact inputs

| Input | Identity |
| --- | --- |
| AgentUI source for the real run | `main` at `8be32fc` |
| Crew service | `f3327346d979270a18c9f46b9cfe6a075b1cb157` |
| Crew image | `agentui-crew-mvp:main-f332734` |
| Crew database schema | 37 |
| Crew profile admission | `BIRBCREW_LIVE_PROFILES`, no attestation |
| Crew member | `961f93a5-68d4-4f79-a1c2-eb94f3a2ecaf`, engine `codex`, profile `chatgpt-gpt-6.1-sol.approval.v1` |
| Crew client | `@birbcrew/client@0.1.0` built from the same Crew revision, [retained manifest](../../vendor/crew-client/f3327346d979270a18c9f46b9cfe6a075b1cb157/manifest.json) |
| Runtime | Node `24.22.3` |

## Real Crew run

The run used the private spark deployment on 2026-11-17. The host ran `node examples/crew/run.mjs <config>` from AgentUI `main` at `8be32fc`. A browser drove the ordinary provider chooser, composer and transcript.

1. AgentUI created owned conversation `e700aae6-44d5-4e1a-b9f5-692e726bbbb4` against the existing member.
2. Send request `0fdd9a97-8400-46a0-9aa9-afb520c5e30f` streamed a 40-line reply.
3. The host was stopped and restarted after the run. One conversation was listed. The prompt and reply each appeared once. No other Crew conversations were imported.
4. Second send `fdfe707d-8597-47c9-9f28-66a26a8c737b` on the same conversation streamed. The host was killed at 26 of 60 lines and restarted. The fresh baseline showed all 60 unique lines once. The earlier turn stayed intact.
5. Both send receipts stayed `accepted` until **Check pending command** settled them. The host recorded the observed run end in the transcript but never read the original request status for the send. This was `agentui-ulb5` and is fixed: an observed run end now triggers one status read that settles the receipt. The real Crew run has not been repeated with the fix.

The run did not exercise protected approvals, Stop, cancellation races, owner-detail cards, permissions or a Crew worker replacement.

## Controlled tests

The controlled tests drive the extension through its public HTTP and SSE boundary against a local fixture. They do not start Crew PostgreSQL, Temporal, workers or native engines.

[`extensions/crew/tests/provider.test.mjs`](../../extensions/crew/tests/provider.test.mjs) covers the Crew extension:

- Creation, streaming, approval, Stop and SQLite reopen: `Crew public entry creates, observes actual SSE text, approves, stops and replaces its baseline on SQLite reopen`.
- No external history: `Crew discovery, creation and host restart touch only the member, owned conversation and its observation, never a listing`. It records every request path. Connection, discovery and creation call exactly `GET /v1/capabilities`, `GET /v1/members`, `POST /v1/conversations` and `POST /v1/conversations/{owned}/events`. After a host restart the calls are exactly `GET /v1/capabilities`, `GET /v1/members` and `POST /v1/conversations/{owned}/events`. The fixture serves the excluded listing route `GET /v1/conversations` with a foreign conversation in it, so a listing call or any foreign conversation path fails the assertion.
- Follow-up sends: `Crew follow-up confirms the original completed request before admitting its own send once`.
- Automatic send settlement: `Crew settles a finished send from its original request status once observation sees the run end` and `Crew settles a send whose request finished while the host was stopped after restart`.
- Lost replies and uncertainty: `Crew lost submit remains original-only GET recovery and does not turn missing lookup into rejection`, `Crew missing original GET remains uncertain and foreign binding refuses before HTTP` and `Crew conflicting admission remains uncertain without retry or replacement identity`.
- Observation integrity: `Crew same-source handoff awaits admitted callbacks and close drains without remote cancellation` and `Crew invalid remote content drains and retains only the last acknowledged cursor`.
- Decisions: `Crew lost decision remains uncertain after card omission and original-only GET on SQLite reopen`, the owner-detail tests and `browser retries owner detail failures and renders a full escaped note before one exact approval`.
- Permissions: `Crew lists every applicable active scope and refuses foreign or changed-scope revocation before POST`, `Crew lost revoke ACK stays uncertain after list absence and host restart without another POST` and the browser permission tests.
- Failure mapping: `Crew maps HTTP, transport and contract failures to typed provider failures without leaking details`.

[`extensions/crew/tests/decision-reconciliation.test.mjs`](../../extensions/crew/tests/decision-reconciliation.test.mjs) runs `extensions/crew/run.mjs` as a child process against a controlled Crew with a decision ledger. It kills the host with `SIGKILL` after Crew committed a named decision, and in other runs before Crew committed it, then restarts it on the same SQLite directory. It also covers a dropped reply, a competing decision, an expired card, a receipt read that returns `404`, `503` or a dropped connection, an absent capability, and fresh `decision_conflict` and `decision_unverifiable` refusals. A decision whose host stopped before Crew committed it stays uncertain until a later reconcile reads a definitive record: Crew committing that decision, a competing decision, or the card closing or expiring. The host never resends it. Each process test counts decide POSTs, receipt reads and ledger effects. `decision verdict table follows Crew decision-receipt semantics` checks the classification table directly.

The generic provider host tests in `tests/application/provider-*.test.mjs` cover the contract the extension relies on:

- [`provider-creation.test.mjs`](../../tests/application/provider-creation.test.mjs): `lost response and restart reconcile only the original immutable operation; concurrent recovery shares its lease` and `reserved restart never dispatches create, original credentials cannot be rebound, and revocation discards late confirmation`.
- [`provider-send.test.mjs`](../../tests/application/provider-send.test.mjs): `authenticated send commits exact target before HTTP effect, persists accepted runs for distinct typed models, and emits receipts only` and `lost response and restart retry never translate or submit; explicit lookup receives original bytes and rejects a changed run`.
- [`provider-stream.test.mjs`](../../tests/application/provider-stream.test.mjs): `real browser selection and send render a growing reply, completion, and persisted history after host/client reopen`.
- [`provider-stream-lifecycle.test.mjs`](../../tests/application/provider-stream-lifecycle.test.mjs): `live replacement resumes one saved observation and an existing HTTP watch without repeating effects`.
- [`provider-resync.test.mjs`](../../tests/application/provider-resync.test.mjs): `provider resync drains admitted callbacks, fetches a fresh snapshot and rejects the retired feed`.
- [`provider-controls.test.mjs`](../../tests/application/provider-controls.test.mjs): `lost approval reply recovers only the saved choice after omission, map replacement, translator changes and restart` and `Stop with a lost reply retains the captured scoped run across restart and completes only its receipt`.

## Capability gaps

- **Exact-choice decision lookup needs Crew decision receipts.** The gap is closed when Crew advertises `decisionReceipts` version 1: the extension names each decision with its host command UUID and reconciles a lost reply from Crew's decision record. Crew without the capability, including the qualified `f332734` service above, keeps lost or mismatched decision replies uncertain. The private spark deployment must run Crew `dfe1c288bc4f0e338011389e10ad35656d6e4154` or later, with migrations 038 and 039 applied, for this to apply there. No real Crew run has exercised it yet.
- **Cold worker replacement is unqualified.** No run replaced the Crew gateway or worker during a request.
- **Frontend tools are unavailable.** Crew accepts no client tool definitions or results. They need Switchboard adapter delivery, tracked as `agentui-9xfk` and `switchboard-5py2`. Switchboard's app-chosen restore contract is [frontend tool restore](https://github.com/mattsp1290/switchboard/blob/main/docs/architecture/frontend-restore.md), merged in Switchboard PR 60.
- **Observation is capped at 8 MiB per connection.** Reaching the cap ends observation. Restart the host for a fresh baseline.
- **There is no remote replay cursor.** The public observer exposes no `after` cursor. Each reopen takes a fresh Crew snapshot as its baseline. The saved cursor is local.
- **Member-wide grants are deferred.** The extension offers only the conversation standing choice. It filters member-wide grant creation.
- **Crew handoffs only create successors.** The extension calls `createHandoff` once to start a successor conversation and afterwards only reads the handoff record while settling that creation. The successor then trusts its stored link. No Continue control reaches users yet.
- **Subagent child transcripts are hidden.** The observation drops messages that carry a `subagentRunId`. Discovery accepts members that declare subagents.

## Verification

Commands ran from the AgentUI worktree with Node `24.22.3` first in `PATH`:

```sh
npm ci
npm run build
npm run check
npm run lint
node --test extensions/crew/tests/provider.test.mjs
npm test
```

`node --test extensions/crew/tests/provider.test.mjs` passed 94 of 94 tests. `npm test` passed 3225 of 3230 tests, with 5 skipped and none failed.

The real run above is the live evidence. It is recorded in the `agentui-osyo` log. No logs from it are committed.

## Extension entry, member list and member creation (WP5)

The installed `extensions/crew` server entry registers one provider per configured installation and the operations `members.list` and `members.create`. Without a fixed member the provider discovers every member, up to 1000.

Controlled evidence: `extensions/crew/tests/operations.test.mjs` runs both operations through the host's real credential authority against the fake Crew service, including a repeated `requestId`, an `unknown_profile` refusal, an unreachable service and a service that never answers. `extensions/crew/tests/contract.test.mjs` validates the fake's member and conversation responses against the vendored client's `openapi.json`. `extensions/crew/tests/provider.test.mjs` covers discovery of several members, an empty owner, the 1000-member bound, and create, send, observe and a permission read on a second member of one installation.

Live qualification against a real Crew service did not happen. No Crew service and owner token were available to the implementing session, so create, list and one chat turn against Crew `origin/main` (`775fd7299d186c2c75d9c59e9285ad66b2631c05`) remain unverified live.

The vendored client stays at `dfe1c288bc4f0e338011389e10ad35656d6e4154`. `git diff dfe1c288bc4f0e338011389e10ad35656d6e4154 775fd7299d186c2c75d9c59e9285ad66b2631c05 -- packages/client` is empty, so a repacked client at `origin/main` would carry the same client source.
