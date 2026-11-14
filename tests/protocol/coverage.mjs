export const coverageContractVersion = 1;

export const projectionFacts = {
  families: ['state', 'activity', 'raw', 'custom', 'messages', 'interrupts', 'usage'],
  plannedFamilies: ['reasoning', 'subagents'],
  plannedDescriptor: 'reasoning-subagents',
  nativeAvailability: { kind: 'undeclared' },
};

export const canonicalDefinitions = { event: 'Event', contracts: { request: 'RunAgentInput', capabilities: 'AgentCapabilities' } };

export const reportText = {
  authority: 'Retained closed canonical schema. SDK acceptance never changes canonical validity.',
  canonicalComparisonScope: 'Historical canonical schema and SDK runtime validator comparison using zod/pydantic. It does not evaluate published TypeScript types, native behavior or installed AgentUI output.',
  sdkRuntimeEvidenceKind: 'historical-upstream-runtime-validators',
  publishedTypeEvidence: 'Acceptance flags do not evaluate published TypeScript types; see compiler contracts.',
  nativeDeclarationScope: 'No backend availability declaration input exists. Contracts belong to agentui-k4zj, admission to agentui-7s6y and qualification to agentui-ckpw.',
};

export const behaviorLimits = {
  unknownOrUnimplementedFact: { claim: 'Explicit error and faulted actor; no successful empty batch.', evidence: ['acknowledged-absence-and-fault'] },
  notObservable: { claim: 'Acknowledged absence for a family declared by describeProjection; empty batch and usable actor.', evidence: ['acknowledged-absence-and-fault'] },
  terminalOrdering: { claim: 'Per-event canonical validation only. The pinned projection maps RUN_ERROR after RUN_FINISHED and before any RUN_STARTED; it faults on finish with open streams. Single-terminal and start-first enforcement belongs to AgentUI run coordination (agentui-7s6y/agentui-ckpw).', evidence: ['terminal-ordering-limit'] },
  derivedIdentifiers: { claim: 'Decoded message, part and subagent-attribution ID samples expose [1, sourceKey, entity kind, native scope, native id] as JSON. Other identifier kinds are not decoded by these fixtures. This is a pinned observation, not a consumer decoding contract. Run scope, invocation identity and client exposure/redaction belong to agentui-7s6y/agentui-ckpw.', evidence: ['identity-run-source-scope', 'messages-and-opaque-content'] },
  repeatedEntityIds: { claim: 'Entity IDs can repeat across runs with the same sourceKey and native reference; run-scoped consumption and replay belong to agentui-7s6y/agentui-ckpw.', evidence: ['identity-run-source-scope'] },
  ownerAttribution: { claim: 'Owner attribution can reuse subagentRunId across runs without emitted lifecycle events; invocation reconciliation belongs to agentui-ckpw.', evidence: ['lifecycle-text-tools', 'identity-run-source-scope', 'acknowledged-absence-and-fault'] },
  nullTerminalResult: { claim: 'The pinned projection omits a null terminal result; non-null falsy values remain intact.', evidence: ['terminal-interrupts-usage'] },
};

export const coverage = {
  envelope: {
    mapping: 'represented', scope: 'Common event envelope on actual projection output.',
    evidence: ['lifecycle-text-tools', 'event-closed-shapes'], pending: ['AgentUI transport and UI event consumption; agentui-ckpw'],
  },
  text: {
    mapping: 'represented', scope: 'Observed text boundaries and fragments, including empty deltas.',
    evidence: ['lifecycle-text-tools', 'identity-run-source-scope'], pending: ['AgentUI streaming transport and text renderer; agentui-ckpw'],
  },
  tools: {
    mapping: 'represented', scope: 'Observed tool calls, argument fragments and results with scoped references.',
    evidence: ['lifecycle-text-tools', 'messages-and-opaque-content'], pending: ['AgentUI tool renderer and provider operations; agentui-k4zj and agentui-ckpw'],
  },
  state: {
    mapping: 'represented', scope: 'Snapshot and patch payload preservation; no patch reducer.',
    evidence: ['state-activity-public-extensions'], pending: ['AgentUI durable state, replay and reducer; agentui-ckpw'],
  },
  messages: {
    mapping: 'represented', scope: 'Ordered message snapshots and content parts.',
    evidence: ['messages-and-opaque-content'], pending: ['AgentUI materialized message store and UI; agentui-ckpw'],
  },
  activity: {
    mapping: 'represented', scope: 'Activity snapshot and delta payload preservation.',
    evidence: ['state-activity-public-extensions', 'messages-and-opaque-content'], pending: ['AgentUI activity reducer and renderer; agentui-ckpw'],
  },
  extensions: {
    mapping: 'represented', scope: 'Explicit versioned public raw and custom envelopes.',
    evidence: ['state-activity-public-extensions'], pending: ['AgentUI host admission, redaction and extension consumers; agentui-ckpw'],
  },
  lifecycle: {
    mapping: 'represented', scope: 'Observed run and step boundaries and safe failures. The terminal-ordering-limit fixture records a stream-ordering gap.',
    evidence: ['lifecycle-text-tools', 'terminal-interrupts-usage', 'terminal-ordering-limit'], pending: ['AgentUI single-terminal run coordinator and lifecycle UI; agentui-7s6y and agentui-ckpw'],
  },
  reasoning: {
    mapping: 'partial', scope: 'Opaque reasoning-role message content only; reasoning lifecycle mapping planned.',
    evidence: ['messages-and-opaque-content', 'acknowledged-absence-and-fault'], pending: ['Switchboard reasoning lifecycle mapping; AgentUI reasoning consumer; agentui-ckpw'],
  },
  subagents: {
    mapping: 'partial', scope: 'Scoped owner attribution only; subagent lifecycle mapping planned.',
    evidence: ['lifecycle-text-tools', 'identity-run-source-scope', 'acknowledged-absence-and-fault'], pending: ['Switchboard subagent lifecycle mapping; AgentUI subagent consumer; agentui-ckpw'],
  },
  outcomes: {
    mapping: 'represented', scope: 'Observed nested terminal outcomes without native termination proof. The terminal-ordering-limit fixture records a stream-ordering gap.',
    evidence: ['terminal-interrupts-usage', 'terminal-ordering-limit', 'event-closed-shapes'], pending: ['AgentUI single-terminal enforcement, durable outcomes and reconciliation; agentui-7s6y and agentui-ckpw'],
  },
  interrupts: {
    mapping: 'represented', scope: 'Observed terminal interrupts and references; no native suspend or resume proof.',
    evidence: ['terminal-interrupts-usage'], pending: ['Native interaction qualification and AgentUI continuation delivery; agentui-ckpw'],
  },
  usage: {
    mapping: 'represented', scope: 'Observed terminal accounting; omitted usage arrays remain absent and explicit zero counts are preserved.',
    evidence: ['terminal-interrupts-usage'], pending: ['AgentUI usage persistence and display; agentui-ckpw'],
  },
  multimodal: {
    mapping: 'represented', scope: 'Opaque ordered message and tool content; no provider media fetch.',
    evidence: ['messages-and-opaque-content'], pending: ['AgentUI content admission, media policy and UI; agentui-ckpw'],
  },
  request: {
    mapping: 'wire-only', scope: 'Published SDK RunAgentInput type and canonical schema controls, with different accepted shapes; no host admission implementation.',
    evidence: ['published-sdk-availability', 'request-capability-shapes'], pending: ['AgentUI provider request contracts and admission; agentui-k4zj and agentui-7s6y'],
  },
  capabilities: {
    mapping: 'wire-only', scope: 'Published SDK AgentCapabilities assignability under TypeScript; canonical capability-schema controls; independent backend availability alignment and projection description.',
    evidence: ['availability-description', 'published-sdk-availability', 'request-capability-shapes', 'availability-family-alignment'], pending: ['AgentUI provider capability validation and operation admission; agentui-k4zj and agentui-7s6y'],
  },
};
