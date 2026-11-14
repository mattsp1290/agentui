export const protocolContract = {
  file: 'packages/adapter-tests/tests/protocol-types.test.mjs',
  test: 'published SDK types and availability contracts preserve declared limits',
  compiler: {
    config: 'packages/protocol/tsconfig.json',
    prefix: `import type { Event, RunAgentInput, AgentCapabilities, BackendAvailability } from '@agentui/protocol';
export type SdkTypes = [Event, RunAgentInput, AgentCapabilities];
export const sdkOnlyRequest: RunAgentInput = { threadId: 't', runId: 'r', messages: [], tools: [], context: [], state: null, forwardedProps: null };
export const sdkCapabilities: AgentCapabilities = { multiAgent: { supported: true } };
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
      ["export const canonicalMinimal: RunAgentInput = { threadId: 't', runId: 'r', messages: [] };", /missing.*tools, context/u],
      ["export const invalid: BackendAvailability = { kind: 'unsupported' };", /Property 'reason' is missing/u],
      ["export const invalid: BackendAvailability = { kind: 'unavailable' };", /Property 'reason' is missing/u],
      ['export const reason = (value: BackendAvailability) => value.reason;', /Property 'reason' does not exist/u],
      ['export const call = (value: BackendAvailability) => value.api();', /Property 'api' does not exist/u],
      ["export const assumed: Extract<BackendAvailability, { kind: 'supported' }> = operations.inspect;", /'"undeclared"' is not assignable to type '"supported"'/u],
    ],
  },
};
