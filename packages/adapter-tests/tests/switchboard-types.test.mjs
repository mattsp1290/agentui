import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const compiler = fileURLToPath(new URL('node_modules/typescript/bin/tsc', root));

test('host native contracts require narrowed capabilities and complete native identities', async () => {
  await mkdir(new URL('.audit/', root), { recursive: true });
  const temporary = await mkdtemp(fileURLToPath(new URL('.audit/native-contracts-', root)));
  try {
    await writeFile(`${temporary}/tsconfig.json`, JSON.stringify({
      extends: fileURLToPath(new URL('tsconfig.base.json', root)),
      compilerOptions: { noEmit: true, types: ['node'] }, files: ['probe.ts'],
    }));
    const prefix = `import type { Capability, InteractionContinuation, PendingInteraction, SessionBinding, SessionReference } from '@agentui/host';
export const binding: SessionBinding = { engine: 'fixture', nativeVersion: '1', account: 'account', authorizedScope: 'scope', nativeFormat: 'format' };
export const session: SessionReference = { kind: 'session', formatVersion: 1, binding, opaque: 'session' };
export const pending: PendingInteraction = { kind: 'approval', target: { kind: 'approval', session, nativeApprovalId: 'approval', tool: null }, nativePolicy: { namespace: 'fixture', schemaVersion: 1, data: null }, request: { namespace: 'fixture', schemaVersion: 1, data: null }, choices: [{ nativeChoiceId: 'once', label: 'Once' }] };
export const reply: InteractionContinuation = { formatVersion: 1, kind: 'approval', target: { kind: 'approval', session, nativeApprovalId: 'approval', tool: null }, nativeChoiceId: 'once' };
export function read(capability: Capability<() => number>) { return capability.kind === 'supported' ? capability.api() : capability.reason; }
`;
    const cases = [
      ['', null],
      ["export const invalid: Capability<() => number> = { kind: 'unsupported' };", /Property 'reason' is missing/u],
      ["export const invalid: Capability<() => number> = { kind: 'unavailable' };", /Property 'reason' is missing/u],
      ['export function invalid(value: Capability<() => number>) { return value.api(); }', /Property 'api' does not exist/u],
      ["export const invalid: SessionReference = { kind: 'session', formatVersion: 1, opaque: 'session' };", /Property 'binding' is missing/u],
      ["export const invalid: InteractionContinuation = { formatVersion: 1, kind: 'approval', target: { kind: 'tool', session, nativeToolCallId: 'tool' }, nativeChoiceId: 'once' };", /not assignable/u],
    ];
    for (const [source, diagnostic] of cases) {
      await writeFile(`${temporary}/probe.ts`, prefix + source);
      const result = spawnSync(process.execPath, [compiler, '-p', `${temporary}/tsconfig.json`, '--pretty', 'false'], { encoding: 'utf8' });
      if (diagnostic === null) assert.equal(result.status, 0, result.stdout + result.stderr);
      else {
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, diagnostic);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
