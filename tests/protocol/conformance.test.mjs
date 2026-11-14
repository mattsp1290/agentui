import { test } from 'node:test';
import { assertReportFresh } from './report.mjs';
import { evidenceKinds, evidenceTest, validateCoverage } from './evidence.mjs';

test('protocol evidence citations resolve', validateCoverage);
for (const [kind, { bodies }] of Object.entries(evidenceKinds)) {
  for (const [id, body] of Object.entries(bodies)) test(evidenceTest(kind, id), () => body());
}
test('versioned conformance report matches immutable inputs and every registered evidence ID', assertReportFresh);
