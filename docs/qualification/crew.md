# Crew public provider qualification

Assessment date is 2026-11-14. `agentui-4wpa` has controlled HTTP evidence and explicit live-service blockers. This assessment does not qualify a deployed Crew service or an AgentUI provider extension.

The retained client supports a remote provider integration without importing Crew's database, Temporal, or native engine code. Crew remains the execution, approval, cancellation, and recovery authority. AgentUI's existing example preserves request identity across local recreation. It attaches an existing Crew conversation and does not establish AgentUI-created conversation provenance.

## Exact inputs

| Input | Identity |
| --- | --- |
| AgentUI source | `85ad5e423d231c628cb60e9a11908ccec3bb2239` |
| Crew client | `@birbcrew/client@0.1.0` |
| Crew SDK and service source inspected | `37c596577b4998fba67b09451ddb16ac0695c08d` |
| Crew source tree | `304b892eccc22d1f6a7d4e3a70a30e840bc1d856` |
| Crew client source package tree | `7968b05bf317f9036ca2cb6d7a998d2856025099` |
| Retained package SHA256 | `00a7060f3441e4a77adef3da34e480e1fc3c86035de3e40438bbcbccee255c2b` |
| Retained client source archive SHA256 | `18c2f6d2a826f528831b35d044703c809a95f1252146e4581a8896541df2114f` |
| Runtime for this assessment | Node `24.22.3`, npm `11.19.1`, Linux |
| Client dependency | Zod `4.4.3` |
| Optional observation peers declared by Crew | `@ag-ui/client@1.0.4`, `@ag-ui/core@1.0.4` |

The [retained manifest](../../vendor/crew-client/37c596577b4998fba67b09451ddb16ac0695c08d/manifest.json) records npm integrity and acquisition. The source archive contains `packages/client`, not the full service. Service claims below come from the local Crew Git objects at the exact revision, not its current checkout or a deployed server. The [qualification receipt](../../spikes/crew/qualification.json) records commands and limits. No retained package bytes or lockfiles changed.

The inspected public sources are [client methods](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/packages/client/src/index.ts), [shared contract](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/packages/client/src/contract.ts), [observer](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/packages/client/src/agui.ts), [integration API](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/docs/integration-api-v1.md), [gateway](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/gateway.ts), [service receipts](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/integration-api.ts), [member client](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/client.ts), [conversation store](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/store.ts), [approval store](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/approvals.ts), and [observation ledger](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/observation.ts).

## Public capabilities and proof limits

Every live entry in this table is **NOT RUN**. A controlled HTTP pass proves the packed SDK's behavior against a local fixture. It does not prove server admission, durable effects, native execution, or service ownership enforcement.

| Requirement | Public method and route | Source contract and controlled proof |
| --- | --- | --- |
| Assess compatibility | `CrewClient.capabilities()`, `GET /v1/capabilities` | The [capabilities schema](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/packages/client/src/contract.ts#L230-L238) requires API `1`, request contract `sql-admission-temporal-queue-v1`, AG-UI snapshot-and-bounded-tail mode, and an `initiatorKinds` array of nonempty strings. Upstream client suite verifies one authenticated call. Deployment identity and advertised capability accuracy remain unqualified. |
| Assess dependencies | `health()`, `GET /v1/health` | Returns structured readiness on HTTP `200` and `503`. Upstream suite covers `not_ready` and malformed replies. Service source probes PostgreSQL and Temporal frontend only. Ready does not prove a namespace exists, workers poll, a member profile works, or model access exists. |
| Discover existing agents | `listMembers({limit, after})`, `GET /v1/members` | Returns authenticated owner's members and opaque `next`. Source specifies keyset pages, default 50, maximum 100. Upstream suite proves query encoding and result parsing, not complete multi-page service traversal. Register these existing members in AgentUI under namespace, installation, and opaque member ID. |
| Create members | `createMember()`, `POST /v1/members` | Public method exists and its wire shape passes the upstream fixture. AgentUI's existing-agent scope excludes invoking it. |
| Create an AgentUI-owned conversation | `openConversation({conversationId, memberId})`, `POST /v1/conversations` | Caller supplies UUID and existing member. Upstream fixture proves request and matching snapshot validation. The [store open path](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/store.ts#L224-L250) inserts only if the conversation UUID is absent, returns the existing owner-scoped conversation, and rejects another member binding. The SDK independently rejects mismatched conversation or member IDs. No AgentUI creation or uncertain-creation recovery path exists in the example. |
| Read a bound conversation | `conversation({conversationId})`, `GET /v1/conversations/{conversationId}` | Example verifies member identity through GET and rejects foreign local bindings before HTTP. Upstream suite checks projected snapshot. Neither suite proves native history provenance. |
| Submit and recover | `submit()`, `POST /v1/conversations/{conversationId}/requests`; `requestStatus()`, corresponding GET | Example tests prove save-before-send, lost-response recreation, original-ID retry, exact body reuse, GET-only reconciliation, and blocking uncertainty. Upstream suite independently proves one attempt per call and unknown-outcome errors. |
| Observe and reconnect | `createCrewObserver()` from `/agui`, `POST /v1/conversations/{conversationId}/events` | Source inspected only. Observer clears messages, tools, context, state, forwarded properties, and resume input. It exposes no `after`, so SDK reconnect obtains a fresh snapshot. Gateway sends the current snapshot, then contiguous events without a per-connection count cap. Raw cursor rejection, in-stream errors, and tail retention differ as described below. No observation executable or live stream was run here. |
| Answer a remote approval | `decide()`, `POST /v1/conversations/{conversationId}/human` | Requires conversation, member, request, invocation, approval, version, and permitted choice. Upstream fixture proves one authenticated decision request and receipt parsing. Neither `conversation()` nor `requestStatus()` supplies the card's `invocationId`, `approvalId`, `version`, or permitted choices. The [root snapshot schema](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/packages/client/src/contract.ts#L204-L219) projects only identity, engine, profile, phase, and cursor. A provider needs the observer to obtain the tuple, so approval answering inherits the observation blocker. Real pending-card validation, duplicate decisions, expiry, and native continuation remain unqualified. |
| Request cancellation | `cancel()`, `POST /v1/conversations/{conversationId}/requests/{requestId}/cancel` | Upstream fixture proves original target and empty body. Source defines durable deduplicated intent. Receipt delivery, native termination, and effects remain distinct. No real cancellation or stop was run. |
| Supply frontend tools | No supported public client method | Strict submit accepts request UUID, text, and optional approval deadline. Gateway rejects tool or result injection through observation. Operator-configured trusted context is not a public client registry. Blocked upstream. |

The [gateway observation loop](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/gateway.ts#L120-L184) streams until a terminal phase, disconnect, cursor gap, or failure. A gap emits `RUN_ERROR` with code `CURSOR_EXPIRED`. Other stream failures emit `RUN_ERROR` with code `OBSERVATION_FAILED`. Before streaming, the [raw events route](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/gateway.ts#L407-L414) rejects mismatched threads or nonempty inputs. Any raw `after` value other than the current snapshot cursor returns HTTP `410 CURSOR_EXPIRED`. The [SDK observer](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/packages/client/src/agui.ts#L4-L14) exposes no `after` cursor. Recreating it therefore requests the current snapshot rather than replay from a saved cursor.

The integration API documents a 256-event retention tail. The [ledger constant](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/observation.ts#L10) and [publication pruning](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/observation.ts#L407-L425) implement that threshold. Text, tool-preview, and tool-value publications return before pruning, so 256 is not a hard bound on instantaneous retention. Event reads use batches of 32. Neither number caps the total events one connection can receive.

## Ownership, authentication, and versions

Crew's operator configures a bearer-token hash mapping to one owner. Every `/v1` route, including health and capabilities, requires authentication. Gateway source authenticates before URL parsing, body parsing, or dependency access. Other owners receive `404`. The fixture proves SDK header delivery, not actual token validity or cross-owner isolation. No credential was read.

The public service advertises API `1`, request contract `sql-admission-temporal-queue-v1`, cancellation `durable-intent-v1`, and observation version `1`. The stream declares AG-UI protocol `1.0`. Capabilities accept additive fields. The SDK validates its required API and request fields but does not validate every advertised service capability, including the cancellation identifier. A provider must assess the capabilities it uses explicitly.

Client exports are root, `/contract`, `/agui`, and `/openapi.json`. The root client requires no AG-UI runtime. The exported OpenAPI document covers core integration routes and lists excluded service extensions. It is not a complete Crew API specification. AgentUI's retained AG-UI fork remains unchanged, and compatibility between that fork and Crew observation is unqualified here.

## Identities and reconciliation

Crew deduplicates by authenticated owner, conversation UUID, and request UUID. UUIDs normalize to lowercase. Text equivalence is exact UTF-8 equality, including whitespace and Unicode form. Whether `approvalDeadlineSeconds` is present, and its value, are part of the payload. A retry must repeat it exactly, or omit it if the original did. A changed payload under the same identity conflicts. A new conversation creates a different identity and can execute twice.

The [example](../../examples/crew/README.md) persists the local host and conversation scope, Crew installation, remote conversation, member, original request UUID, exact body, and unresolved or observed outcome before dispatch. Credentials stay in the client. It uses one owner per journal file. Tests reject changed installations, foreign scopes, and mismatched receipts.

After a lost reply, the original identifiers and body remain authoritative. `requestStatus()` performs GET and does not dispatch inference. Server source can reconcile existing admissions against workflow evidence and update receipts, so read-only reconciliation means no new work or cancellation delivery, not that the server never writes a reconciliation record. A missing lookup preserves uncertainty. A later retry refusal cannot disprove an earlier ambiguous submission. The fixture verifies both cases after recreation.

Crew's `uncertain` receipt is a remote reconciliation result. It differs from a client `CrewUnknownOutcomeError`, which means the HTTP command's outcome is unknown. Neither permits replacing the UUID and replaying effects. The example blocks new sends until authoritative status resolves the pending request. Retained receipts and results have no automatic TTL under the source contract, but database deletion or restoration is a separate operator concern.

Conversation creation needs its own durable provenance. Before `openConversation`, AgentUI must persist its newly allocated conversation UUID and selected existing member. A lost response must preserve that UUID. The service's same-UUID open and GET snapshot provide public mechanisms, but their use for AgentUI-owned creation remains unimplemented and unqualified here. Discovery must not import existing native conversation history. The service also exposes an [owner-scoped conversation listing](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/integration-api.ts#L212-L223) at `GET /v1/conversations`, but the SDK has no method for that listing. The intended extension leaves this raw route unused.

## Approval and cancellation are separate operations

`decide()` answers an existing remote approval. It is neither a frontend tool result nor cancellation. Crew owns the card and permitted choice. Service source resolves its native call identity internally. Clients do not supply native receipt authority. The [member decision path](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/client.ts#L111-L127) checks the [approval ledger](https://github.com/mattsp1290/crew/blob/37c596577b4998fba67b09451ddb16ac0695c08d/src/service/approvals.ts#L289-L309) before the workflow update and again if the update throws. A recorded matching choice can resolve an ambiguous update reply. This is inspected source evidence, not an executed decision-recovery result. A future integration must reconcile the original approval tuple and observed state, retaining uncertainty where no authoritative decision evidence exists. The SDK has no dedicated decision-status method.

`cancel()` records request-scoped intent. The service returns a stable cancellation receipt. `delivery: delivered` does not prove native termination. `nativeTermination: confirmed` does not assess prior effects. `effects` remains `not_assessed`. A committed reply can win a cancellation race. Closing or aborting observation only disconnects the observer. It does not cancel work.

## Exact extension boundary

The intended Crew extension uses only the public packed HTTP client and the public AG-UI observer. AgentUI's provider contract and host routing own registration, authorization, credential handles, existing-agent discovery, durable local admission, and AgentUI-created provenance. Crew owns SQL and Temporal admission, remote approval state, native execution, cancellation delivery, and authoritative recovery.

The current example is not a registered provider contribution. The host's current recorded `ProviderDriver` is not a remote Crew driver. Production delivery remains with `agentui-k4zj` for the public provider contract, `agentui-7s6y` for generic registration and routing, `agentui-s96x` for existing-agent registration, `agentui-ksx0` for lifecycle, and `agentui-osyo` for the Crew extension. This qualification adds no implementation to those owners' paths and copies no native adapter internals.

## Live and upstream blockers

The remaining qualification blockers are explicit:

- No deployed endpoint, installed service revision, owner token, or authorized member/profile was assessed. This lane neither reads credentials nor contacts a live service.
- PostgreSQL migration readiness, Temporal namespace and worker readiness, and actual model/provider access lack service evidence. A capabilities response or healthy frontend alone cannot establish them.
- Existing-agent pagination, two-installation identity isolation, real owner authorization, and secret redaction require installed-consumer and service evidence beyond these fixtures.
- AgentUI-created conversation admission, original-UUID recovery after a lost creation reply, and refusal to attach external history lack an implemented provider path.
- Snapshot plus live observation, reconnect after cursor expiry, disposal without cancellation, and AgentUI's pinned AG-UI compatibility were not executed.
- Real protected approvals, ambiguous decision reconciliation, cancellation races, native termination, and gateway/worker/client replacement recovery remain unqualified. Approval card discovery through observation was not exercised, and the root snapshot and status methods cannot supply the decision tuple. Existing Crew service tests are source evidence, not a run receipt for this assessment.
- Frontend tool definitions and correlated tool results remain blocked by `switchboard-r-3rkv` and then `crew-r-xndc`. Both request records were read with `bn request show --no-fetch` and are open as of this assessment. AgentUI gates are `agentui-9xfk` and `agentui-b3aj`. Creating a request is not owner acceptance or delivery.

The frontend dependency order is Switchboard interfaces and native adapters, then Crew durability and owner authorization, then AgentUI client handlers and lifecycle. Required delivery includes a usable pin and original-toolCallId continuation after replacement of the relevant processes. A warm control does not qualify cold recovery. Stored IDs, regenerated calls, or receipt text in a prompt do not prove native continuation. No reverse dependency on AgentUI or Crew is needed for standalone Switchboard fixtures.

## Executed verification

The existing artifact, example, and upstream client tests supply repeatable controlled evidence. No tests were added for prose. Commands ran from this AgentUI worktree with the pinned Node directory first in `PATH`:

```sh
npm ci
npm run build --workspace=@agentui/contracts --workspace=@agentui/example-crew
npm run check --workspace=@agentui/example-crew
node --test examples/crew/tests/*.test.mjs
git -C /home/punk1290/git/crew show 37c596577b4998fba67b09451ddb16ac0695c08d:tests/client/client.test.mts > .audit/mvp/crew/upstream-client.test.mts
node --test .audit/mvp/crew/upstream-client.test.mts
npm run verify
```

Build and type checks passed. The existing example suite passed 20 tests, including retained archive verification and a separately installed packed example. The unchanged upstream client suite passed 21 tests against AgentUI's installed retained SDK. Its extracted file SHA256 is `174360e7eec9b54de89b880198307cc5bfd93abb5c4b794471a21c0c8e627b24` and matches the exact Git source. Both suites use controlled local HTTP fixtures. Neither starts Crew PostgreSQL, Temporal, workers, or native engines.

The full `npm run verify` passed build, type checks, lint, and all 327 tests. Its local, untracked log is `.audit/mvp/verify.log`. Focused logs, extracted source files, and review evidence are local under `.audit/mvp/`. The `.audit/` directory is gitignored and is not retained by this branch. The committed receipt records the test counts and input digests, but it does not preserve these local logs. Dependency installation reported two high-severity audit findings and an uncovered esbuild install script. No dependency or lockfile changes were made to resolve them. Node 22, Apple clients, observation, and live Crew were not run. The bounded acceptance result is explicit blockers with controlled contract evidence.
