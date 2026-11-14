import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildConformanceReport, reportFile, serializeConformanceReport } from '../../scripts/protocol-conformance.mjs';
import { installedFixture, installedFixtures } from './fixtures/installed.mjs';

for (const [id, run] of Object.entries(installedFixtures)) test(installedFixture.test(id), run);

test('versioned conformance report matches immutable inputs and every owned fixture', () => {
  const report = buildConformanceReport();
  assert.equal(readFileSync(reportFile, 'utf8'), serializeConformanceReport());
  assert.deepEqual(report.canonical.counts, {
    categories: 16, definitions: 98, eventDiscriminators: 31, fixtures: 219,
    valid: 135, invalid: 84, typescriptPermissiveInvalid: 8, pythonPermissiveInvalid: 22,
  });
  for (const row of report.categories) {
    assert.equal(row.nativeAvailability, 'undeclared');
    assert.equal(row.nativeQualification, 'unqualified');
  }
  assert.ok(Object.values(report.switchboard.nativeRoutes).every((route) => route.availability === 'undeclared' && route.qualification === 'unqualified'));
  assert.equal(report.categories.find((row) => row.category === 'reasoning').mapping, 'partial');
  assert.equal(report.categories.find((row) => row.category === 'subagents').mapping, 'partial');
  assert.equal(report.categories.find((row) => row.category === 'request').mapping, 'wire-only');
  assert.equal(report.categories.find((row) => row.category === 'capabilities').mapping, 'wire-only');
});
