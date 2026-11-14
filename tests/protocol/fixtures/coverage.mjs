import { protocolContract } from './contracts.mjs';

const contracts = [{ file: protocolContract.file, test: protocolContract.test }];
export const installedFixtureFile = 'tests/protocol/conformance.test.mjs';

export const coverageContract = {
  version: 1,
  projectionFamilies: ['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'usage'],
  plannedFamilies: ['reasoning', 'subagents'],
  authority: 'Retained closed canonical schema. SDK acceptance never changes canonical validity.',
  canonicalComparisonScope: 'Historical canonical schema and published SDK comparison; not native or installed AgentUI output.',
  validatorControlTest: 'canonical Event validator enforces closed shapes',
  requestControlTest: 'canonical request and capability shapes differ from SDK types',
  nativeAvailability: { kind: 'undeclared' },
  nativeDeclarationScope: 'No backend availability declaration input exists. Contracts belong to agentui-k4zj, admission to agentui-7s6y and qualification to agentui-ckpw.',
  behaviorLimits: {
    unknownOrUnimplementedFact: 'Explicit error and faulted actor; no successful empty batch.',
    notObservable: 'Acknowledged absence for an allowed family; empty batch and usable actor.',
    terminalOrdering: 'Per-event canonical validation only. The pinned projection maps failure after a finished terminal; single-terminal enforcement belongs to AgentUI run coordination (agentui-7s6y/agentui-ckpw).',
    nullTerminalResult: 'The pinned projection omits a null terminal result; non-null falsy values remain intact.',
    qualification: 'Fixture registration and retained evidence inventory are not current execution results or native qualification.',
    downstream: 'Provider operation contracts/admission: agentui-k4zj/agentui-7s6y. Full native, transport/replay and UI qualification: agentui-ckpw.',
  },
};

const canonicalContracts = [...contracts, { file: installedFixtureFile, test: coverageContract.requestControlTest }];

export const coverage = {
  envelope: {
    mapping: 'represented', scope: 'Common event envelope on actual projection output.',
    fixtures: ['lifecycle-text-tools'], contracts: [], pending: ['AgentUI transport and UI event consumption; agentui-ckpw'],
  },
  text: {
    mapping: 'represented', scope: 'Observed text boundaries and fragments, including empty deltas.',
    fixtures: ['lifecycle-text-tools'], contracts: [], pending: ['AgentUI streaming transport and text renderer; agentui-ckpw'],
  },
  tools: {
    mapping: 'represented', scope: 'Observed tool calls, argument fragments and results with scoped references.',
    fixtures: ['lifecycle-text-tools'], contracts: [], pending: ['AgentUI tool renderer and provider operations; agentui-k4zj and agentui-ckpw'],
  },
  state: {
    mapping: 'represented', scope: 'Snapshot and patch payload preservation; no patch reducer.',
    fixtures: ['state-activity-public-extensions'], contracts: [], pending: ['AgentUI durable state, replay and reducer; agentui-ckpw'],
  },
  messages: {
    mapping: 'represented', scope: 'Ordered message snapshots and content parts.',
    fixtures: ['messages-and-opaque-content'], contracts: [], pending: ['AgentUI materialized message store and UI; agentui-ckpw'],
  },
  activity: {
    mapping: 'represented', scope: 'Activity snapshot and delta payload preservation.',
    fixtures: ['state-activity-public-extensions'], contracts: [], pending: ['AgentUI activity reducer and renderer; agentui-ckpw'],
  },
  extensions: {
    mapping: 'represented', scope: 'Explicit versioned public raw and custom envelopes.',
    fixtures: ['state-activity-public-extensions'], contracts: [], pending: ['AgentUI host admission, redaction and extension consumers; agentui-ckpw'],
  },
  lifecycle: {
    mapping: 'represented', scope: 'Observed run and step boundaries and safe failures. The terminal-ordering-limit fixture records a stream-ordering gap.',
    fixtures: ['lifecycle-text-tools', 'terminal-interrupts-usage', 'terminal-ordering-limit'], contracts: [], pending: ['AgentUI single-terminal run coordinator and lifecycle UI; agentui-7s6y and agentui-ckpw'],
  },
  reasoning: {
    mapping: 'partial', scope: 'Opaque reasoning-role message content only; reasoning lifecycle mapping planned.',
    fixtures: ['messages-and-opaque-content', 'acknowledged-absence-and-fault'], contracts: [], pending: ['Switchboard reasoning lifecycle mapping; AgentUI reasoning consumer; agentui-ckpw'],
  },
  subagents: {
    mapping: 'partial', scope: 'Scoped owner attribution only; subagent lifecycle mapping planned.',
    fixtures: ['lifecycle-text-tools', 'acknowledged-absence-and-fault'], contracts: [], pending: ['Switchboard subagent lifecycle mapping; AgentUI subagent consumer; agentui-ckpw'],
  },
  outcomes: {
    mapping: 'represented', scope: 'Observed nested terminal outcomes without native termination proof. The terminal-ordering-limit fixture records a stream-ordering gap.',
    fixtures: ['terminal-interrupts-usage', 'terminal-ordering-limit'], contracts: [], pending: ['AgentUI single-terminal enforcement, durable outcomes and reconciliation; agentui-7s6y and agentui-ckpw'],
  },
  interrupts: {
    mapping: 'represented', scope: 'Observed terminal interrupts and references; no native suspend or resume proof.',
    fixtures: ['terminal-interrupts-usage'], contracts: [], pending: ['Native interaction qualification and AgentUI continuation delivery; agentui-ckpw'],
  },
  usage: {
    mapping: 'represented', scope: 'Observed terminal accounting; omitted values remain distinct from explicit zero.',
    fixtures: ['terminal-interrupts-usage'], contracts: [], pending: ['AgentUI usage persistence and display; agentui-ckpw'],
  },
  multimodal: {
    mapping: 'represented', scope: 'Opaque ordered message and tool content; no provider media fetch.',
    fixtures: ['messages-and-opaque-content'], contracts: [], pending: ['AgentUI content admission, media policy and UI; agentui-ckpw'],
  },
  request: {
    mapping: 'wire-only', scope: 'Published SDK RunAgentInput type and canonical schema controls, with different accepted shapes; no host admission implementation.',
    fixtures: [], contracts: canonicalContracts, pending: ['AgentUI provider request contracts and admission; agentui-k4zj and agentui-7s6y'],
  },
  capabilities: {
    mapping: 'wire-only', scope: 'Published SDK AgentCapabilities type, canonical schema controls, four-state availability contract and projection description.',
    fixtures: ['availability-description'], contracts: canonicalContracts, pending: ['AgentUI provider capability validation and operation admission; agentui-k4zj and agentui-7s6y'],
  },
};

export const installedFixtureTest = (id) => `protocol installed fixture: ${id}`;
export const installedFixtureIds = [...new Set(Object.values(coverage).flatMap((row) => row.fixtures))].sort();
