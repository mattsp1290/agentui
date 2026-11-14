# AG-UI consumer conformance

AgentUI imports canonical wire types from `@agentui/protocol` and consumes the
installed Switchboard projection through `@agentui/host/agui`. The host core
entry remains independent of AG-UI imports. No mapper or SDK fields are copied.

The [versioned matrix](conformance.json) joins immutable upstream inventories to
AgentUI's owned fixture coverage. Its version identifies canonical protocol 1.0,
TypeScript SDK 1.0.4, Python SDK 1.0.0, the Switchboard artifact and the owned
coverage contract. Source bytes, digests and both MIT notices are retained under
[the test inputs](../../tests/protocol/fixtures/upstream/).

## Read the evidence

The matrix keeps these facts separate:

| Evidence | Meaning |
| --- | --- |
| Canonical schema | Closed wire shapes and their required fields, unions and enums |
| Published SDK results | Expected TypeScript and Python acceptance of indexed payloads |
| Mapping coverage | Facts represented by the pinned Switchboard projection |
| Installed fixtures | AgentUI tests of actual returned events through public exports |
| Native availability | A backend declaration, currently undeclared for the pinned native routes |
| Native qualification | Execution evidence, currently unqualified for all six native routes |
| Pending consumers | Product owners for provider admission, transport, reducers, replay and UI |

SDK acceptance does not establish canonical validity. The pinned TypeScript SDK
accepts eight canonically invalid indexed fixtures; Python accepts twenty-two.
The upstream verifier owns all 98 definitions, while the concrete index names
219 payloads. Those are upstream evidence inputs, not 219 AgentUI tests.

The owned fixtures validate every emitted event against the retained canonical
`Event` definition. They assert returned values and related IDs for text, tools,
state, activity, public extensions, message content and terminal observations.
Opaque reasoning-role messages and scoped owner references provide partial
representation. Reasoning and subagent lifecycle mapping remain planned.
Request and capability declarations are wire contracts, not emitted events.

Unknown or unimplemented facts produce an explicit error and fault the mapper.
They cannot become a successful empty batch. An explicit `not-observable` fact
acknowledges absent observation, returns an empty batch and leaves the actor
usable. Closing the actor creates no terminal outcome.

## Capability declarations

`BackendAvailability` distinguishes undeclared, supported, unsupported and
unavailable. The negative declarations require a reason. Compiler fixtures use
a local operation example, exhaust all four states and reject missing reasons,
unnarrowed access and treating undeclared as supported. This type neither
validates arbitrary JSON nor supplies a callable backend API.

Canonical `AgentCapabilities`, backend availability and native qualification
remain independent. A representable event is not evidence of an available or
qualified operation. An unsupported declaration cannot waive required native
qualification.

## Reproduce and update

From the repository root with the pinned toolchain:

```sh
npm ci
npm run build
npm run protocol:matrix
npm run protocol:check
npm run verify
```

The generator derives definitions, event discriminators and raw fixture paths
from the retained inventories. Owned fixture references resolve to the same
function map registered by the test runner. The freshness test rejects stale
committed output. Normal verification needs no upstream download or Python.
The earlier exact-source TS/Python comparison is retained with the
[Switchboard qualification](../../vendor/README.md); new installed-output
validation is a separate check.

Provider operation contracts and runtime admission remain `agentui-k4zj` and
`agentui-7s6y`. Complete native, transport/replay and UI conformance remains
`agentui-ckpw`. These controlled fixtures do not qualify providers, authorization,
durable consumption, delivery, retries or integrated Apple behavior.
The original [Mac package record](../qualification/switchboard-macos/58c7922d8fade3617cc86fedcf41677f897025ef/54065e2/README.md)
continues to describe its measured source `54065e2` and five focused tests.
