# Crew provider extension qualification

Assessment date is 2026-11-17. This assessment covers `agentui-osyo`, the Crew example provider extension. It qualifies creation, streaming, host restart and resume against a real Crew service. It lists the capability gaps that remain.

The extension is `crewProvider` from `@agentui/example-crew/provider`. It is a registered public provider contribution. It discovers one configured existing Crew member and creates fresh AgentUI-owned conversations against it. It never imports existing Crew conversation history. Crew remains the execution, approval, cancellation and recovery authority. The [example README](../../examples/crew/README.md) describes configuration and behavior.

The deployment model is the one in [AGENTS.md](../../AGENTS.md). One owner runs AgentUI and Crew on a private overlay network, which is the trust boundary. There is no device pairing or service attestation.

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

[`examples/crew/tests/provider.test.mjs`](../../examples/crew/tests/provider.test.mjs) covers the Crew extension:

- Creation, streaming, approval, Stop and SQLite reopen: `Crew public entry creates, observes actual SSE text, approves, stops and replaces its baseline on SQLite reopen`.
- No external history: `Crew discovery, creation and host restart touch only the member, owned conversation and its observation, never a listing`. It records every request path. Connection, discovery and creation call exactly `GET /v1/capabilities`, `GET /v1/members`, `POST /v1/conversations` and `POST /v1/conversations/{owned}/events`. After a host restart the calls are exactly `GET /v1/capabilities`, `GET /v1/members` and `POST /v1/conversations/{owned}/events`. The fixture serves the excluded listing route `GET /v1/conversations` with a foreign conversation in it, so a listing call or any foreign conversation path fails the assertion.
- Follow-up sends: `Crew follow-up confirms the original completed request before admitting its own send once`.
- Automatic send settlement: `Crew settles a finished send from its original request status once observation sees the run end` and `Crew settles a send whose request finished while the host was stopped after restart`.
- Lost replies and uncertainty: `Crew lost submit remains original-only GET recovery and does not turn missing lookup into rejection`, `Crew missing original GET remains uncertain and foreign binding refuses before HTTP` and `Crew conflicting admission remains uncertain without retry or replacement identity`.
- Observation integrity: `Crew same-source handoff awaits admitted callbacks and close drains without remote cancellation` and `Crew invalid remote content drains and retains only the last acknowledged cursor`.
- Decisions: `Crew lost decision remains uncertain after card omission and original-only GET on SQLite reopen`, the owner-detail tests and `browser retries owner detail failures and renders a full escaped note before one exact approval`.
- Permissions: `Crew lists every applicable active scope and refuses foreign or changed-scope revocation before POST`, `Crew lost revoke ACK stays uncertain after list absence and host restart without another POST` and the browser permission tests.
- Failure mapping: `Crew maps HTTP, transport and contract failures to typed provider failures without leaking details`.
- Closure: the `Crew {phase} phase saves a {cause} closure and reports the conversation concluded` tests, `Crew concluded conversation stays concluded after restart without observing again` and `browser shows a closed Crew conversation without Stop or an update check, even after failed or stopped status reads, and keeps the draft`. A Crew conversation that is stopped, fails or reaches its turn limit stays closed. The desktop says why, disables Send and hides Stop.
- Continue: [`continuation.test.mjs`](../../examples/crew/tests/continuation.test.mjs) covers the host operation, including ten concurrent starts that make one handoff POST and each Crew refusal. [`continue-browser.test.mjs`](../../examples/crew/tests/continue-browser.test.mjs) drives the desktop: Stop, Continue and the boundary counts; two pages that converge on one successor; a reload during a held handoff that shows "Continuing…" without a second POST; each refusal's buttons; an uncertain handoff that is never posted again; the draft moving to the new composer unsent; and search that finds an earlier segment's text and opens the newest one. Continue starts a new Crew conversation with the same member, and Crew carries the newest complete turns, up to 64 KiB, into it. The successor's first message holds those turns and stays hidden. Its acknowledgement shows below a boundary that names the carried, omitted and uncertain counts.

[`examples/crew/tests/decision-reconciliation.test.mjs`](../../examples/crew/tests/decision-reconciliation.test.mjs) runs `examples/crew/run.mjs` as a child process against a controlled Crew with a decision ledger. It kills the host with `SIGKILL` after Crew committed a named decision, and in other runs before Crew committed it, then restarts it on the same SQLite directory. It also covers a dropped reply, a competing decision, an expired card, a receipt read that returns `404`, `503` or a dropped connection, an absent capability, and fresh `decision_conflict` and `decision_unverifiable` refusals. A decision whose host stopped before Crew committed it stays uncertain until a later reconcile reads a definitive record: Crew committing that decision, a competing decision, or the card closing or expiring. The host never resends it. Each process test counts decide POSTs, receipt reads and ledger effects. `decision verdict table follows Crew decision-receipt semantics` checks the classification table directly.

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
- **Crew handoffs only create successors, and only on Continue.** The desktop's **Continue** on a closed chat makes the host call `createHandoff` once per attempt, each with a new request ID. Afterwards the host only reads the handoff record while settling that attempt and never posts it again. The successor then trusts its stored link. No real Crew run has continued a conversation yet.
- **Subagent child transcripts are hidden.** The observation drops messages that carry a `subagentRunId`. Discovery accepts members that declare subagents.

## Verification

Commands ran from the AgentUI worktree with Node `24.22.3` first in `PATH`:

```sh
npm ci
npm run build
npm run check
npm run lint
node --test examples/crew/tests/provider.test.mjs
npm test
```

`node --test examples/crew/tests/provider.test.mjs` passed 94 of 94 tests. `npm test` passed 3225 of 3230 tests, with 5 skipped and none failed.

The real run above is the live evidence. It is recorded in the `agentui-osyo` log. No logs from it are committed.
