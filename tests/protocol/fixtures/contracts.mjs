export const protocolContract = {
  file: 'packages/adapter-tests/tests/protocol-types.test.mjs',
  test: 'published SDK types and availability contracts preserve declared limits',
  compiler: {
    config: 'packages/protocol/tsconfig.json',
    prefix: `import type { Event, RunAgentInput, AgentCapabilities, BackendAvailability } from '@agentui/protocol';
export type SdkTypes = [Event, RunAgentInput, AgentCapabilities];
export const sdkOnlyRequest: RunAgentInput = { threadId: 't', runId: 'r', messages: [], tools: [], context: [], state: null, forwardedProps: null };
const widenedCapabilities = { multiAgent: { supported: true, unexpected: true } };
export const structurallyAssignable: AgentCapabilities = widenedCapabilities;
export const operations = {
  inspect: { kind: 'undeclared' },
  submit: { kind: 'supported' },
  cancel: { kind: 'unsupported', reason: 'Fixture backend cannot cancel' },
  continue: { kind: 'unavailable', reason: 'Fixture backend is disconnected' },
} satisfies Record<string, BackendAvailability>;
export function describe(value: BackendAvailability): string {
  switch (value.kind) {
    case 'undeclared': return 'No declaration';
    case 'supported': return 'Declared support';
    case 'unsupported':
    case 'unavailable': return value.reason;
    default: { const unexpected: never = value; return unexpected; }
  }
}
`,
    cases: [
      ['', null],
      ["export const fresh: AgentCapabilities = { multiAgent: { supported: true, unexpected: true } };", /TS2353.*unexpected/u],
      ["export const silent: BackendAvailability = { kind: 'unsupported' };", /Property 'reason' is missing/u],
      ["export const silent: BackendAvailability = { kind: 'unavailable' };", /Property 'reason' is missing/u],
      ["export function partial(value: BackendAvailability): string { switch (value.kind) { case 'supported': case 'unsupported': case 'unavailable': return ''; default: { const unhandled: never = value; return unhandled; } } }", /not assignable to type 'never'/u],
      ["export const canonicalMinimal: RunAgentInput = { threadId: 't', runId: 'r', messages: [] };", /missing.*tools, context/u],
      ['export const reason = (value: BackendAvailability) => value.reason;', /Property 'reason' does not exist/u],
      ["export const reason = (value: BackendAvailability) => value.kind === 'supported' ? value.reason : '';", /Property 'reason' does not exist/u],
      ["export const assumed: Extract<BackendAvailability, { kind: 'supported' }> = operations.inspect;", /'"undeclared"' is not assignable to type '"supported"'/u],
    ],
  },
};

export const alignmentContract = {
  file: protocolContract.file,
  test: 'backend availability and projection families align across package boundaries',
};
