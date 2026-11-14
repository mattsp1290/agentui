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
by its current consumers. It does not copy an adapter, parser or native agent loop.
Clients and extensions depend on AgentUI contracts rather than the Node host.

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

A new facade or mirrored contracts package would add a second import path
without hiding any implemented policy. An authority-aware facade can become useful
when it owns the real installation lookup, authorization and durable pending state.
Those systems are not implemented by this increment.

## Preserve both identity domains

AgentUI's `RunIdentity` has one `RunAuthority`, including its `ProviderBinding`.
That binding names a provider namespace, installed provider and opaque session.
It does not contain Switchboard's engine, native version, account, authorized
scope or native format. A future host-owned installation record must resolve
those fields before constructing a Switchboard `SessionReference`.
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
No database, admission gate or durable dispatch implementation is added here.

Crew remains a remote provider with its own execution and approval authority.
Its transport, authentication and replay belong to the Crew extension.
The Node host does not turn a remote Crew operation into a local native adapter.

## Distinguish available library code from native support

The selected package exports core and `./agui`. Its projection descriptor is
`basic-values-messages-and-terminals`; reasoning and subagent lifecycle mappings
remain planned. The AG-UI entry needs the exact optional SDK peer, declared by
AgentUI's explicit host AG-UI consumer. The [protocol matrix](../protocol/README.md)
names controlled installed fixtures and pending transport, replay and UI consumers.
A schema or projection does not prove that
a native provider emits the corresponding event.

There is no packaged Claude, Codex or Pi adapter in this artifact.
Upstream has bounded source-spike Codex inspection evidence and a conditional
app-server candidate. Its unknown-corrupt-session enumeration gap remains open.
That evidence does not qualify a live AgentUI provider. The six live direct and
LiteLLM combinations remain unqualified in the upstream protocol record.
The upstream README has stale statements about AG-UI and exports. The pinned
package exports and current protocol records define the library code described here.

Linux package checks and the [installed-consumer procedure](../../vendor/README.md#check-the-installed-consumer)
prove artifact installation, public contract consumption and controlled continuation
behavior. Mac package verification is a separate measurement of the same bytes.
Neither measurement qualifies live native operations or integrated Apple clients.
Broader Apple qualification remains `agentui-onxu`.

The [Mac consumer record](../qualification/switchboard-macos/58c7922d8fade3617cc86fedcf41677f897025ef/54065e2/README.md)
qualifies installation, workspace compilation and five controlled tests at AgentUI
source `54065e2`. The artifact and all eleven frozen inputs matched before and
after the run. This adds Mac package compatibility evidence within the limits above.
