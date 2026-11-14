import { test } from 'node:test';
import { assertCompileCases } from './support/compile.mjs';

test('host native contracts require narrowed capabilities and complete native identities', async () => {
  await assertCompileCases({
    compilerOptions: { types: ['node'] },
    prefix: `import type { Capability, InteractionContinuation, PendingInteraction, SessionBinding, SessionReference } from '@agentui/host';
export const binding: SessionBinding = { engine: 'fixture', nativeVersion: '1', account: 'account', authorizedScope: 'scope', nativeFormat: 'format' };
export const session: SessionReference = { kind: 'session', formatVersion: 1, binding, opaque: 'session' };
export const pending: PendingInteraction = { kind: 'approval', target: { kind: 'approval', session, nativeApprovalId: 'approval', tool: null }, nativePolicy: { namespace: 'fixture', schemaVersion: 1, data: null }, request: { namespace: 'fixture', schemaVersion: 1, data: null }, choices: [{ nativeChoiceId: 'once', label: 'Once' }] };
export const reply: InteractionContinuation = { formatVersion: 1, kind: 'approval', target: { kind: 'approval', session, nativeApprovalId: 'approval', tool: null }, nativeChoiceId: 'once' };
export function read(capability: Capability<() => number>) { return capability.kind === 'supported' ? capability.api() : capability.reason; }
`,
    cases: [
      ['', null],
      ["export const invalid: Capability<() => number> = { kind: 'unsupported' };", /Property 'reason' is missing/u],
      ["export const invalid: Capability<() => number> = { kind: 'unavailable' };", /Property 'reason' is missing/u],
      ['export function invalid(value: Capability<() => number>) { return value.api(); }', /Property 'api' does not exist/u],
      ["export const invalid: SessionReference = { kind: 'session', formatVersion: 1, opaque: 'session' };", /Property 'binding' is missing/u],
      ["export const invalid: InteractionContinuation = { formatVersion: 1, kind: 'approval', target: { kind: 'tool', session, nativeToolCallId: 'tool' }, nativeChoiceId: 'once' };", /not assignable/u],
    ],
  });
});
