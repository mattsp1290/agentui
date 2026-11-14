import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertReportFresh } from '../../scripts/protocol-conformance.mjs';
import { evidenceFile, evidenceKinds, evidenceTest, validateCoverage } from './evidence.mjs';
import { canonicalControls } from './canonical.mjs';
import { installedFixtures } from './fixtures/installed.mjs';
import { publishedTypeContracts } from './fixtures/types.mjs';

const bodies = { installedFixtures, canonicalControls, publishedTypeContracts };
test('protocol evidence registrations match catalog IDs and registrar location', () => {
  validateCoverage();
  assert.equal(new URL(evidenceFile, new URL('../../', import.meta.url)).href, import.meta.url);
  assert.deepEqual(Object.keys(bodies), Object.keys(evidenceKinds));
  for (const [kind, { ids }] of Object.entries(evidenceKinds)) assert.deepEqual(Object.keys(bodies[kind]).sort(), [...ids].sort(), kind);
});
for (const [kind, { ids }] of Object.entries(evidenceKinds)) for (const id of ids) test(evidenceTest(kind, id), () => {
  assert.ok(Object.hasOwn(bodies[kind] ?? {}, id), `Missing ${kind} body: ${id}`);
  assert.equal(typeof bodies[kind][id], 'function', id);
  return bodies[kind][id]();
});
test('report generation imports metadata without executable evidence bodies', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./support/generator-imports.mjs', import.meta.url))], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
test('versioned conformance report matches immutable inputs and every owned fixture', assertReportFresh);
