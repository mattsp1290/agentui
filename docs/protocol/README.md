# AG-UI consumer conformance

AgentUI imports published TypeScript SDK 1.0.4 types from `@agentui/protocol`.
TypeScript assignability and canonical wire validity differ.

| Value | Published SDK type | Canonical wire |
| --- | --- | --- |
| `RunAgentInput.state`, `forwardedProps` | `any`, admitting null | Non-null JSON |
| `RunAgentInput.tools`, `context` | Required | Optional |
| `Event.type` | `EventType` enum member | String literal |
| `Event.rawEvent` | Admits null | Non-null JSON |

`JSON.parse` returns `any` and bypasses TypeScript checking. Canonical schema
validation establishes wire validity. Compiler controls separately check the
plain discriminator value set and constructing an SDK event with enum members.
Producers import the enum directly from the pinned `@ag-ui/core` dependency;
`@agentui/protocol` deliberately exports types only.

AgentUI consumes the installed Switchboard projection through
`@agentui/host/agui`. The host core entry remains independent of AG-UI imports.
No mapper or SDK fields are copied.

The [versioned matrix](conformance.json) joins immutable upstream inventories to
AgentUI's owned fixture coverage. Its version identifies canonical protocol 1.0,
TypeScript SDK 1.0.4, Python SDK 1.0.0, the Switchboard artifact and the owned
coverage contract schema. `coverageContractVersion` versions that schema; coverage
content is reviewed with its Git revision. Source bytes, digests and both MIT
notices are retained under
[the test inputs](../../tests/protocol/fixtures/upstream/).

## Read the evidence

The matrix keeps these facts separate:

| Evidence | Meaning |
| --- | --- |
| Canonical schema | Closed wire shapes and their required fields, unions and enums |
| SDK runtime results | Historical upstream validator acceptance of indexed payloads |
| Mapping coverage | Facts represented by the pinned Switchboard projection |
| Canonical controls | Executed closed-schema checks on representative raw shapes |
| Published type contracts | Executed compiler probes of SDK assignability and package alignment |
| Installed fixtures | Actual public projection events, descriptors, absence and fault results |
| Native availability | One explicit undeclared scope because no backend declaration input exists |
| Native qualification | The pinned record's route assessments, currently unqualified for all six routes |
| Pending consumers | Product owners for provider admission, transport, reducers, replay and UI |

SDK acceptance does not establish canonical validity. The upstream runtime
validators accept eight canonically invalid indexed fixtures in TypeScript and
twenty-two in Python. Those results use zod 4.0.17 and pydantic 2.11.7, not the
published TypeScript types AgentUI imports. The AgentUI conformance suite runs no
SDK validator.
The upstream verifier owns all 98 definitions, while the concrete index names
219 payloads. Those are upstream evidence inputs, not 219 AgentUI tests.

The owned fixtures validate every emitted event against the retained canonical
`Event` definition. They assert returned values and related IDs for text, tools,
state, activity, public extensions, message content and terminal observations.
Opaque reasoning-role messages and scoped owner references provide partial
representation. Reasoning and subagent lifecycle mapping remain planned.
Compiler probes observe TypeScript assignment rules against published SDK types.
Excess-property checking rejects unknown `multiAgent` keys on fresh literals;
widened values can retain those keys. Both are language properties, and neither
validates runtime JSON. The SDK's optional runtime capability schemas use
`looseObject` and preserve unknown keys, consistent with the historical parser
results. Canonical validation rejects them. These controls validate representative
raw shapes without implementing host admission. Canonical discriminator lists
describe the wire inventory,
not emitted-event evidence. The pinned producer uses text and tool boundaries,
not chunk shorthands. Full consumer handling remains `agentui-ckpw`.

The report's [`behaviorLimits`](conformance.json) records the pinned observations
and their supporting evidence IDs. It covers explicit absence and faults,
terminal ordering, decoded ID samples, repeated IDs, owner attribution and null
terminal results. These limits remain separate from product qualification and
pending ownership. Consumers must consult them before implementing admission,
redaction, run coordination or replay in `agentui-7s6y` and `agentui-ckpw`.

## Capability declarations

`BackendAvailability` distinguishes undeclared, supported, unsupported and
unavailable. The negative declarations require a reason. Compiler fixtures use
a local operation example, exhaust all four states and reject missing reasons,
unnarrowed access and treating undeclared as supported. This type neither
validates arbitrary JSON nor supplies a callable backend API.

Switchboard's projection descriptor carries availability states without reasons.
A bridge into `BackendAvailability` needs a reason from the backend declaration,
owned by `agentui-k4zj`. The bridge must validate that reasons are nonempty;
`string` alone cannot enforce that. No such bridge is implemented here.
Projection types remain accessible through
public function signatures; named type re-exports will follow a concrete caller.

Capability wire data, backend availability and native qualification
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

`tests/protocol/report.mjs` derives definitions, event discriminators and raw
fixture paths from the retained inventories. It lists SDK divergences and
references hashed inputs instead of copying their complete rows. Evidence
identity comes directly from the named body maps in `tests/protocol/fixtures/`
and `tests/protocol/canonical.mjs`. `tests/protocol/evidence.mjs` associates each
map with its evidence kind and validates citations, callability and global ID
uniqueness. Every ID must have category credit.

The version 2 report has one `evidence.registrar` path and three literal evidence
fields. Each kind has sorted `ids` and a `testName` template. Replacing `<id>` in
that template with an ID gives the name registered in
`tests/protocol/conformance.test.mjs`. Category fields cite those same IDs by
kind. The registrar path is descriptive metadata; no self-referential location
assertion is retained. Compiler bodies use the shared adapter-test helper, which
requires a compiling positive control first.

Direct report generation checks retained input digests before importing evidence
modules. It imports body definitions without invoking fixture callbacks or
starting compiler processes. Loading the canonical module initializes Ajv against
the retained schema. The host import still precedes input verification, and the
suite statically imports evidence to register its named tests. Digest-first
ordering applies to direct report generation before evidence initialization.
A separate identity fixture checks cross-run, source and reference scoping.
Qualification scope and pending ownership remain separate from behavioral claims.
Named validator controls prove closed shapes. The freshness test rejects stale
committed output. `protocol:check` provides the same freshness comparison as a fast
read-only command; `verify` already includes the test. Normal verification needs
no upstream download or Python.
AgentUI uses Ajv 8.20.0 after a dependency advisory check. The historical upstream
verifier used 8.17.1. Both use the unchanged retained canonical schema.
The earlier exact-source TS/Python comparison is retained with the
[Switchboard qualification](../../vendor/README.md); new installed-output
validation is a separate check.

To recheck retained Switchboard files against a source checkout containing the
pinned revision, compare these results with `tests/protocol/fixtures/upstream/provenance.json`:

```sh
git -C /path/to/switchboard show 58c7922d8fade3617cc86fedcf41677f897025ef:docs/protocol/ag-ui-pin.json | sha256sum
git -C /path/to/switchboard show 58c7922d8fade3617cc86fedcf41677f897025ef:docs/protocol/ag-ui-matrix.tsv | sha256sum
git -C /path/to/switchboard show 58c7922d8fade3617cc86fedcf41677f897025ef:tests/agui/fixtures/upstream.tsv | sha256sum
```

The index's 219 payload digests refer to upstream files that are not copied here.
Checking those payload bytes requires the pinned upstream source and verifier.

Provider operation contracts and runtime admission remain `agentui-k4zj` and
`agentui-7s6y`. Complete native, transport/replay and UI conformance remains
`agentui-ckpw`. These controlled fixtures do not qualify providers, authorization,
durable consumption, delivery, retries or integrated Apple behavior.
The original [Mac package record](../qualification/switchboard-macos/58c7922d8fade3617cc86fedcf41677f897025ef/54065e2/README.md)
continues to describe its measured source `54065e2` and five focused tests.
