import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertReportFresh } from '../../scripts/protocol-conformance.mjs';
import { evidenceFile, evidenceKinds, evidenceTest, validateCoverage } from './evidence.mjs';

test('protocol evidence citations resolve and the registrar matches report files', () => {
  validateCoverage();
  assert.equal(new URL(evidenceFile, new URL('../../', import.meta.url)).href, import.meta.url);
});
for (const [kind, { bodies }] of Object.entries(evidenceKinds)) {
  for (const [id, body] of Object.entries(bodies)) test(evidenceTest(kind, id), () => body());
}
test('versioned conformance report matches immutable inputs and every registered evidence ID', assertReportFresh);
