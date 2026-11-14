import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildConformanceReport, reportFile, serializeConformanceReport } from '../../scripts/protocol-conformance.mjs';
import { coverageContract, installedFixtureIds, installedFixtureTest } from './fixtures/coverage.mjs';
import { installedFixtures, validateDefinition, validateEvent } from './fixtures/installed.mjs';

test(coverageContract.validatorControlTest, () => {
  assert.equal(validateEvent({ type: 'UNKNOWN_EVENT' }), false);
  assert.equal(validateEvent({ type: 'TEXT_MESSAGE_END', messageId: 'm' }), true);
  assert.equal(validateEvent({ type: 'TEXT_MESSAGE_END', messageId: 'm', unexpected: true }), false);
  assert.equal(validateEvent({ type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'cancelled' } }), true);
  assert.equal(validateEvent({ type: 'RUN_FINISHED', threadId: 't', runId: 'r', outcome: { type: 'cancelled', interrupts: [] } }), false);
});

test(coverageContract.requestControlTest, () => {
  const request = validateDefinition('RunAgentInput');
  const minimal = { threadId: 't', runId: 'r', messages: [] };
  assert.equal(request(minimal), true);
  for (const extra of [{ state: null }, { forwardedProps: null }, { unexpected: 1 }]) assert.equal(request({ ...minimal, ...extra }), false);
  const capabilities = validateDefinition('AgentCapabilities');
  assert.equal(capabilities({ multiAgent: { supported: true } }), true);
  assert.equal(capabilities({ multiAgent: { supported: true, unexpected: true } }), false);
});

test('installed fixture registrations match coverage-owned IDs', () => {
  assert.ok(installedFixtureIds.length > 0);
  assert.deepEqual(Object.keys(installedFixtures).sort(), installedFixtureIds);
});

for (const [id, run] of Object.entries(installedFixtures)) test(installedFixtureTest(id), run);

test('versioned conformance report matches immutable inputs and every owned fixture', () => {
  const report = buildConformanceReport();
  assert.equal(readFileSync(reportFile, 'utf8'), serializeConformanceReport(report));
  assert.deepEqual(report.canonical.counts, {
    categories: 16, definitions: 98, eventDiscriminators: 31, fixtures: 219,
    valid: 135, invalid: 84, typescriptPermissiveInvalid: 8, pythonPermissiveInvalid: 22,
  });
  assert.ok(report.categories.every((row) => !('nativeAvailability' in row) && !('nativeQualification' in row)));
  assert.equal(report.categories.find((row) => row.category === 'reasoning').mapping, 'partial');
  assert.equal(report.categories.find((row) => row.category === 'subagents').mapping, 'partial');
  assert.equal(report.categories.find((row) => row.category === 'request').mapping, 'wire-only');
  assert.equal(report.categories.find((row) => row.category === 'capabilities').mapping, 'wire-only');
});
