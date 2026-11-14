import { test } from 'node:test';
import { assertReportFresh } from './report.mjs';
import { evidenceKinds, evidenceTest, buildEvidenceRegistry } from './evidence.mjs';
import { loadConformanceInputs } from './coherence.mjs';

test('protocol evidence citations resolve', buildEvidenceRegistry);
for (const [kind, { bodies }] of Object.entries(evidenceKinds)) {
  for (const [id, body] of Object.entries(bodies)) test(evidenceTest(kind, id), () => body());
}
test('retained protocol inputs and installed descriptor are coherent', () => { loadConformanceInputs(); });
test('versioned conformance report matches immutable inputs and every registered evidence ID', assertReportFresh);
