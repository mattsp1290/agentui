# Codex dependency assessment

Assessed on 2026-11-15 against AgentUI `d81f04eec198095475b04c8abe118d142e78963b`.
Keep the working direct Codex bridge for the solo-user MVP until Switchboard
provides a public Codex adapter. The final integration belongs on that shared
adapter, with Codex protocol parsing and process ownership in Switchboard.

## Installed artifacts and current source

The [runtime pin](../../../vendor/switchboard.json) identifies Switchboard
`58c7922d8fade3617cc86fedcf41677f897025ef`.
The [development-only pin](../../../vendor/dev-qualification/switchboard.json)
identifies `71d204015f573e1399d8ba19a33a2d4b4067fa1a` and its qualification alias.
Neither installed public API exports a Codex adapter or a `./codex` entrypoint.
The read-only public-export probe checked both archive digests and imported both
public entrypoints. It launched no native process and accessed no credentials.

Generic adapter lifecycle, session discovery, and session inspection contracts
are not native implementations. `parseInteractionContinuation` validates replies.
`createDispatchOperation` delegates delivery to a host-supplied `dispatchNative`.
The AG-UI projection accepts normalized facts rather than Codex notifications.
Its interrupt descriptor reports representability with undeclared native
availability and qualification. A bump to the development artifact supplies none
of the missing native mechanics.

AgentUI's [native contract](../../../packages/contracts/src/compatibility.ts)
and [host instructions](../../development/codex-host.md) require Codex **0.167.2**
with format `codex-app-server-v2`.
Upstream's [selection at source 56e5bfd](https://github.com/mattsp1290/switchboard/blob/56e5bfd033d12a7d9e773af3997baae6b2ac4175/docs/qualification/codex-selection.md)
selects **0.169.0** and resolves the historical unknown-file omission selection
blocker. That clean local source revision was also verified on GitHub.
It is separate from both installed artifacts. This assessment does not package
that source or rerun its native qualification. Selection does not establish a
public adapter or qualify the AgentUI integration.

## Bounded dependency handoff

Upstream `switchboard-x9av` owns session execution and `switchboard-118i` owns
action delivery and cancellation. AgentUI `agentui-yr72` and `agentui-iezb`
remain open and depend on that delivery. The needed public adapter must own process
lifecycle, create, turn submission, resume, native event translation, command
and file Allow and Deny, and interrupt. It must retain typed native identifiers
and distinguish rejection from uncertain delivery without blind retries.

Replace [createCodexDriver](../../../packages/host/src/codex-driver.ts) behind
the existing `ProviderDriver` boundary once that adapter exists. Route its shared
AG-UI output into the host transcript and remove the replaced local Codex wire
parser and translation. Do not copy private upstream transport into AgentUI.
The host keeps pairing, authorization, the conversation catalog, durable command
admission, receipts, replay, and reconnect recovery.

Preserve the existing create, streaming reply, follow-up, restart-resume, Allow,
Deny, and Stop flow. An interrupt acknowledgement and a terminal event remain
separate facts. Missing acknowledgements must not become success or trigger
repeat dispatch. External history discovery and a broad provider qualification
matrix are outside this MVP handoff.

## Owned history and the version transition

List only AgentUI's stored conversation catalog and resume only its saved session
references. Never import native history or accept arbitrary client thread IDs.
The current driver stores format-version-1 `SessionReference` values with the
native thread ID in `opaque`. It selects installation `codex-local-v1`.
The session binding includes the engine, account `local`, the resolved workspace,
native version, and native format.

The [SQLite store](../../../packages/host/src/sqlite-store.ts) compares installation
bindings exactly. A blind CLI bump changes that binding and rejects old records.
Establish whether the public adapter can accept the existing references before
changing versions. If the binding must change, use a narrow, explicit transition
for AgentUI-owned records that preserves saved transcripts and receipts.
Expire process-bound approvals through the existing
[recovery path](../../../apps/host/src/codex-recovery.ts). Keep unknown outcomes
unknown. Resume compatibility across 0.167.2 and 0.169.0 is not established here.

Use small ordinary follow-up tests for owned-session create, streaming, follow-up,
restart-resume, foreign-reference rejection, typed Allow and Deny, stale decisions,
Stop, and acknowledgement loss without duplicate dispatch. Then run one real app
smoke journey, including reopening a pre-transition owned conversation.
This document adds no native qualification claim or new verification infrastructure.
