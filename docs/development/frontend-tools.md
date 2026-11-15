# Frontend tool coordination

`frontendToolsFor(host)` from `@agentui/host/frontend-tools` coordinates frontend calls in the SQLite database of the supplied `openLocalHost` handle. The core `@agentui/host` entry does not load the AG-UI runtime. The explicit subpath uses the handle's existing connection, transactions and live authorization; it does not open a second database connection. Its producer port belongs to trusted provider and host-policy wiring. Its client port belongs to a transport that has already authenticated the executing device. These ports do not authenticate request payloads themselves.

```ts
import { openLocalHost } from '@agentui/host';
import { frontendToolsFor } from '@agentui/host/frontend-tools';

const host = openLocalHost(options);
const tools = frontendToolsFor(host);
const producer = tools.producer(scope);
const client = tools.client(scope, authenticatedActor);
```

`options`, `scope` and `authenticatedActor` come from trusted host wiring. Every port operation checks the host's current scope authorization. Closing the host invalidates existing ports. Fabricated or copied handles cannot attach to the coordinator. A trusted producer may register an AgentUI-hosted or remote-provider run; device and provider transports remain separate integrations.

## Run and activation identity

Each SDK tool activation has a unique `activationId`. A run pin exposes frozen `bindings` with each advertised tool's name and activation identity. `pin.invoke(name, arguments, activationId)` requires the captured identity. Missing or mismatched identities return `activation-mismatch` before a handler runs.

The producer registers the pin's run identity, AG-UI thread ID, platform, definitions and activation bindings. Re-registering the same identity and bindings is idempotent. Changing the bindings for an existing run fails. A generation label is diagnostic and cannot restore a lost activation.

## Stream and consent

The producer supplies consecutive cursors starting at one. The first event must be the matching `RUN_STARTED`. Exact event replay at the same cursor is idempotent. Conflicting replay, gaps and invalid event order fault the run.

Arguments accumulate until `TOOL_CALL_END`. Calls become eligible only after a matching successful `RUN_FINISHED`. An absent outcome means success. Missing or empty `pendingToolCallIds` derives unanswered calls from the stream. A nonempty list must agree with the streamed unanswered calls in order. Producer-answered calls do not become frontend work.

The host-policy owner records allow or deny against the exact call, activation identity and argument digest. Authentication and extension installation do not grant consent. Malformed JSON produces an `invalid-arguments` result without a handler invocation. Denial produces a `denied` result. Cancellation blocks further claims and continuation.

`TOOL_CALL_CHUNK` and subagent-attributed tool calls currently fault the run. Provider bindings must supply supported top-level start, arguments and end events. This coordinator does not advertise provider support.

## Client permit and receipt

The trusted service constructs `FrontendActor` with its authenticated device identity, platform and a live `authorized` callback. The callback receives the conversation scope, run key, action, call ID and activation identity. It must check current device authorization and eligibility. Client-supplied IDs and callbacks are not an authentication boundary.

A successful `claim` commits one execution permit before returning arguments to the client. The client invokes its original SDK pin only after receiving that permit. A repeated claim never returns another execution permit. An issued permit without a receipt appears as uncertain, including after reopening the host.

The client records the SDK outcome with its permit ID. Only the original authorized actor can record it. Exact receipt retries are idempotent. Changed receipts fail. A handler exception, disconnect, timeout or lost receipt may follow an effect. The client reports uncertainty and must not invoke again. A late receipt from the original authorized actor can resolve the call.

The database uses immediate transactions to arbitrate claims across host connections and processes. There is no claim expiry, reassignment or reset. A crash between committing a permit and executing the handler can leave a call uncertain even when no effect occurred.

## Results and downstream integration

`producer.results` returns a complete ordered batch only after every pending call has a conclusive result. The batch retains the original run identity, thread ID and tool call IDs. It carries SDK string outputs or explicit refusal codes. It does not flatten richer provider content into strings.

Provider bindings own encoding those results as correlated role-tool messages and submitting the next input through their public continuation API. They must persist submission identity and reconcile an unknown acknowledgement without repeating frontend effects. A returned batch does not acknowledge provider submission.

Desktop and iOS transport binding, service routes, provider capability advertisement and real-provider cold continuation qualification remain separate tasks. The generic coordinator does not execute handlers in the host process or restore JavaScript closures after a client process dies.

## Limits and verification

A run permits at most 128 registered tools and 128 streamed calls. Each event, argument buffer and output string has a 64,000-byte limit. Registration has a 128,000-byte limit. Stored run metadata and retained event payloads each have a 1,000,000-byte limit. Each conclusive result is stored independently in an immutable receipt, so output payloads do not consume the run metadata limit. Receipt and resolved state commit together. A run accepts at most 4,096 event cursors.

After building, run the public host regression suite with `node --test tests/host/frontend-tools/*.test.mjs`. It uses real SQLite databases, SDK pins, independent processes and an external effect file. The SDK contracts include a Chromium CSP execution check and packed TypeScript consumers.
