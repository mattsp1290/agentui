import { protocolContract } from './contracts.mjs';

const contracts = [{ file: protocolContract.file, test: protocolContract.test }];

export const coverage = {
  envelope: {
    mapping: 'represented', scope: 'Common event envelope on actual projection output.',
    fixtures: ['lifecycle-text-tools'], pending: ['AgentUI transport and UI event consumption; agentui-ckpw'],
  },
  text: {
    mapping: 'represented', scope: 'Observed text boundaries and fragments, including empty deltas.',
    fixtures: ['lifecycle-text-tools'], pending: ['AgentUI streaming transport and text renderer; agentui-ckpw'],
  },
  tools: {
    mapping: 'represented', scope: 'Observed tool calls, argument fragments and results with scoped references.',
    fixtures: ['lifecycle-text-tools'], pending: ['AgentUI tool renderer and provider operations; agentui-k4zj and agentui-ckpw'],
  },
  state: {
    mapping: 'represented', scope: 'Snapshot and patch payload preservation; no patch reducer.',
    fixtures: ['state-activity-public-extensions'], pending: ['AgentUI durable state, replay and reducer; agentui-ckpw'],
  },
  messages: {
    mapping: 'represented', scope: 'Ordered message snapshots and content parts.',
    fixtures: ['messages-and-opaque-content'], pending: ['AgentUI materialized message store and UI; agentui-ckpw'],
  },
  activity: {
    mapping: 'represented', scope: 'Activity snapshot and delta payload preservation.',
    fixtures: ['state-activity-public-extensions'], pending: ['AgentUI activity reducer and renderer; agentui-ckpw'],
  },
  extensions: {
    mapping: 'represented', scope: 'Explicit versioned public raw and custom envelopes.',
    fixtures: ['state-activity-public-extensions'], pending: ['AgentUI host admission, redaction and extension consumers; agentui-ckpw'],
  },
  lifecycle: {
    mapping: 'represented', scope: 'Observed run and step boundaries and safe failures.',
    fixtures: ['lifecycle-text-tools', 'terminal-interrupts-usage', 'terminal-ordering-limit'], pending: ['AgentUI single-terminal run coordinator and lifecycle UI; agentui-7s6y and agentui-ckpw'],
  },
  reasoning: {
    mapping: 'partial', scope: 'Opaque reasoning-role message content only; reasoning lifecycle mapping planned.',
    fixtures: ['messages-and-opaque-content', 'acknowledged-absence-and-fault'], pending: ['Switchboard reasoning lifecycle mapping; AgentUI reasoning consumer; agentui-ckpw'],
  },
  subagents: {
    mapping: 'partial', scope: 'Scoped owner attribution only; subagent lifecycle mapping planned.',
    fixtures: ['lifecycle-text-tools', 'acknowledged-absence-and-fault'], pending: ['Switchboard subagent lifecycle mapping; AgentUI subagent consumer; agentui-ckpw'],
  },
  outcomes: {
    mapping: 'represented', scope: 'Observed nested terminal outcomes; no native termination proof.',
    fixtures: ['terminal-interrupts-usage', 'terminal-ordering-limit'], pending: ['AgentUI single-terminal enforcement, durable outcomes and reconciliation; agentui-7s6y and agentui-ckpw'],
  },
  interrupts: {
    mapping: 'represented', scope: 'Observed terminal interrupts and references; no native suspend or resume proof.',
    fixtures: ['terminal-interrupts-usage'], pending: ['Native interaction qualification and AgentUI continuation delivery; agentui-ckpw'],
  },
  usage: {
    mapping: 'represented', scope: 'Observed terminal accounting; omitted values remain distinct from explicit zero.',
    fixtures: ['terminal-interrupts-usage'], pending: ['AgentUI usage persistence and display; agentui-ckpw'],
  },
  multimodal: {
    mapping: 'represented', scope: 'Opaque ordered message and tool content; no provider media fetch.',
    fixtures: ['messages-and-opaque-content'], pending: ['AgentUI content admission, media policy and UI; agentui-ckpw'],
  },
  request: {
    mapping: 'wire-only', scope: 'Canonical request type and schema inventory; no host admission implementation.',
    fixtures: [], contracts, pending: ['AgentUI provider request contracts and admission; agentui-k4zj and agentui-7s6y'],
  },
  capabilities: {
    mapping: 'wire-only', scope: 'Canonical declarations, four-state availability contract and seven-family projection description.',
    fixtures: ['availability-description'], contracts, pending: ['AgentUI provider capability validation and operation admission; agentui-k4zj and agentui-7s6y'],
  },
};
