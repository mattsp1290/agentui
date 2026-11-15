# Switchboard host integration

AgentUI consumes Switchboard through the existing Node-only `@agentui/host`
package. The host uses a [verified immutable artifact](../../vendor/README.md).
Its [pin](../../vendor/switchboard.json) records the exact source and digest.
Private version `0.0.0` is an artifact identity, not a published release or a
compatibility promise. Node `>=24.22.3 <25` and npm 11.19.1 are required.

## Reuse the public core contracts

Switchboard owns adapter identity, registration and instance lifecycle contracts,
capability states, native session references, bounded event observation and
interaction continuation parsing. The host exposes only the core contracts used
by its current consumers. The SDK-backed Pi, Codex, and Claude drivers import
Switchboard public native adapters. The direct Codex app-server bridge remains
a separate driver with process and protocol handling in AgentUI. Clients and
extensions depend on AgentUI contracts rather than the Node host.

The installed consumer calls the upstream parser directly:

```ts
import { parseInteractionContinuation } from '@agentui/host';
import type { PendingInteraction } from '@agentui/host';

function validateReply(value: unknown, expected: PendingInteraction) {
	return parseInteractionContinuation({ value, expected });
}
```

This illustrates parser correspondence only. An operational host must obtain
`expected` from its authorized, server-owned pending state. The replying client
cannot provide both the reply and the trusted expectation.

The host now owns installation lookup, authorization, and durable pending state.
Those policies surround the current direct Codex bridge. The installed
Switchboard parser remains a correspondence-checking helper. It does not supply
that host policy.

## Preserve both identity domains

AgentUI's `RunIdentity` has one `RunAuthority`, including its `ProviderBinding`.
That binding names a provider namespace, installed provider and opaque session.
It does not contain Switchboard's engine, native version, account, authorized
scope or native format. The current host-owned installation record supplies
those fields when constructing a Switchboard `SessionReference`.
Do not infer an account from an installation ID or treat a namespace as an engine.

The native reference retains its envelope version and opaque session token.
Approval targets also retain the native approval ID and optional linked tool ID.
Host conversation, run and request IDs remain correlation values. They cannot
replace native target IDs or advertised native choice IDs.
The continuation parser checks binding, session, target, envelope version and
advertised choice correspondence against the supplied pending record.
Successful parsing does not prove current native state, authorization,
single consumption, dispatch, delivery or safe retry.

## Keep availability and outcomes explicit

`Capability<Api>` distinguishes supported APIs, unsupported operations and
configured-but-unavailable operations. The latter two carry reasons and no API.
An omitted capability is undeclared. It cannot be treated as supported.
The compiler fixtures require callers to narrow the capability before using its
API and preserve the reason for unsupported and unavailable branches.

Tool results, effects and delivery are separate facts. A tool can fail after an
effect occurred while delivery is still unknown. The installed consumer retains
that combination. It does not reinterpret parsing success as confirmed delivery.
Host withholding is local policy, not a fabricated native approval choice.

Switchboard owns bounded observation and library lifecycle semantics.
AgentUI owns host authorization, installation routing, durable intent and receipts,
pending-record ownership, event persistence, replay, uncertainty and retry policy.
Observer disposal does not cancel authoritative work. Only a separately qualified
native cancellation operation could establish a native cancellation result.
The current host has a SQLite store, an admission gate, and durable dispatch
receipts. Cancellation support belongs to each driver and its native operation.
Telemetry observation never establishes cancellation.

Crew remains a remote provider with its own execution and approval authority.
Its transport, authentication and replay belong to the Crew extension.
The Node host does not turn a remote Crew operation into a local native adapter.

## Distinguish available library code from native support

The current package exports core, `./agui`, `./testkit`, `./pi`, `./codex`,
`./claude`, and `./observability`. Its AG-UI projection descriptor is
`basic-values-messages-terminals-reasoning-and-subagents`, with `planned: none`.
The AG-UI entry needs the exact optional SDK peer.
`@agentui/host` declares that peer for its `./agui` entry.
Core imports no AG-UI or observability code.
The [protocol matrix](../protocol/README.md) distinguishes the current runtime
from historical canonical fixtures. AgentUI's existing reasoning and subagent
fixtures cover availability descriptions, message content, and owner attribution.
They do not exercise dedicated reasoning or subagent lifecycle output.
A schema or projection does not prove that a native provider emits an event.

The three native aliases and the core dependency use the same commit-named
artifact. Their pin files retain each adapter's native SDK version.
The development qualification alias remains a separate historical artifact.
Package imports and controlled fixtures do not establish broader live native,
LiteLLM, or integrated Apple qualification.

The optional observability entry uses exact peer `@opentelemetry/api@1.9.0`.
AgentUI exposes it through `@agentui/host/observability`.
The host owns providers, exporters, parent contexts, and flush deadlines.
The [observability guide](../development/observability.md) describes host setup
and the observed run lifecycle. Observations do not authorize dispatch,
retry native work, or change durable run outcomes.

Current package checks ran on Darwin arm64 from the immutable source archive.
The [vendor record](../../vendor/README.md) identifies their exact source,
artifact, commands, and logs. Those checks qualify package installation and
controlled behavior. No live native agent, Datadog backend, or Apple application
ran during that package update.

The original Linux package checks remain in the
[historical pin](../../vendor/historical/switchboard-58c7922d8fade3617cc86fedcf41677f897025ef.json).
The [historical Mac consumer record](../qualification/switchboard-macos/58c7922d8fade3617cc86fedcf41677f897025ef/54065e2/README.md)
qualifies installation, workspace compilation, and five controlled tests at
AgentUI source `54065e2`. Its artifact and eleven frozen inputs matched before
and after that run. Neither historical receipt qualifies the current artifact.
Broader Apple qualification remains `agentui-onxu`.
