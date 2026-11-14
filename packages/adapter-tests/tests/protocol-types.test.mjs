import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCompileCases } from './support/compile.mjs';
import { coverageContract } from '../../../tests/protocol/fixtures/coverage.mjs';
import { alignmentContract, protocolContract } from '../../../tests/protocol/fixtures/contracts.mjs';

for (const contract of [protocolContract, alignmentContract]) assert.equal(new URL(contract.file, new URL('../../../', import.meta.url)).href, import.meta.url);
test(protocolContract.test, () => assertCompileCases({
  config: 'packages/protocol/tsconfig.json',
  prefix: `import type { Event, RunAgentInput, AgentCapabilities, BackendAvailability } from '@agentui/protocol';
import { EventType } from '@ag-ui/core';
export const knownEvent: Event = { type: EventType.TEXT_MESSAGE_END, messageId: 'm' };
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
    ["export const unknownEvent: Event = { type: 'UNKNOWN_EVENT' };", /TS2322.*UNKNOWN_EVENT/u],
    ["export const fresh: AgentCapabilities = { multiAgent: { supported: true, unexpected: true } };", /TS2353.*unexpected/u],
    ["export const silent: BackendAvailability = { kind: 'unsupported' };", /Property 'reason' is missing/u],
    ["export const silent: BackendAvailability = { kind: 'unavailable' };", /Property 'reason' is missing/u],
    ["export function partial(value: BackendAvailability): string { switch (value.kind) { case 'supported': case 'unsupported': case 'unavailable': return ''; default: { const unhandled: never = value; return unhandled; } } }", /not assignable to type 'never'/u],
    ["export const canonicalMinimal: RunAgentInput = { threadId: 't', runId: 'r', messages: [] };", /missing.*tools, context/u],
    ['export const reason = (value: BackendAvailability) => value.reason;', /Property 'reason' does not exist/u],
    ["export const reason = (value: BackendAvailability) => value.kind === 'supported' ? value.reason : '';", /Property 'reason' does not exist/u],
    ["export const assumed: Extract<BackendAvailability, { kind: 'supported' }> = operations.inspect;", /'"undeclared"' is not assignable to type '"supported"'/u],
  ],
}));

test(alignmentContract.test, () => assertCompileCases({
  config: 'packages/adapter-tests/tsconfig.json',
  prefix: `import type { BackendAvailability } from '@agentui/protocol';
import type { Capability } from '@agentui/host';
import type { describeProjection } from '@agentui/host/agui';
export const publishedNative = ${JSON.stringify(coverageContract.nativeAvailability)} satisfies BackendAvailability;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Description = Extract<ReturnType<typeof describeProjection>, { kind: 'ok' }>['value'];
export const descriptorStates: Equal<BackendAvailability['kind'], Description['availability']> = true;
export const negativeStates: Equal<Extract<BackendAvailability, { kind: 'unsupported' | 'unavailable' }>, Exclude<Capability<never>, { kind: 'supported' }>> = true;
const families = ${JSON.stringify(coverageContract.projectionFamilies)} satisfies readonly Parameters<typeof describeProjection>[0][];
export const exhaustiveFamilies: Equal<Parameters<typeof describeProjection>[0], (typeof families)[number]> = true;
`,
  cases: [['', null]],
}));
