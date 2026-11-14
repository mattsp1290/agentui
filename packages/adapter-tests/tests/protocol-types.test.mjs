import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCompileCases } from './support/compile.mjs';
import { coverageContract } from '../../../tests/protocol/fixtures/coverage.mjs';
import { alignmentContract, protocolContract } from '../../../tests/protocol/fixtures/contracts.mjs';

for (const contract of [protocolContract, alignmentContract]) assert.equal(new URL(contract.file, new URL('../../../', import.meta.url)).href, import.meta.url);
test(protocolContract.test, () => assertCompileCases(protocolContract.compiler));

test(alignmentContract.test, () => assertCompileCases({
  config: 'packages/adapter-tests/tsconfig.json',
  prefix: `import type { BackendAvailability } from '@agentui/protocol';
import type { Capability } from '@agentui/host';
import type { describeProjection } from '@agentui/host/agui';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Description = Extract<ReturnType<typeof describeProjection>, { kind: 'ok' }>['value'];
export const descriptorStates: Equal<BackendAvailability['kind'], Description['availability']> = true;
export const negativeStates: Equal<Extract<BackendAvailability, { kind: 'unsupported' | 'unavailable' }>, Exclude<Capability<never>, { kind: 'supported' }>> = true;
const families = ${JSON.stringify(coverageContract.projectionFamilies)} satisfies readonly Parameters<typeof describeProjection>[0][];
export const exhaustiveFamilies: Equal<Parameters<typeof describeProjection>[0], (typeof families)[number]> = true;
`,
  cases: [['', null]],
}));
