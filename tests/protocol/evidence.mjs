import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { behaviorLimits, coverage } from './coverage.mjs';

export const evidenceKinds = {
  installedFixtures: { label: 'installed fixture', ids: [
    'lifecycle-text-tools', 'identity-run-source-scope', 'state-activity-public-extensions', 'messages-and-opaque-content',
    'terminal-interrupts-usage', 'availability-description', 'terminal-ordering-limit', 'acknowledged-absence-and-fault',
  ] },
  canonicalControls: { label: 'canonical control', ids: ['event-closed-shapes', 'request-capability-shapes'] },
  publishedTypeContracts: { label: 'published type contract', ids: ['published-sdk-availability', 'availability-family-alignment'] },
};
export const evidenceFile = 'tests/protocol/conformance.test.mjs';
export const evidenceTest = (kind, id) => `protocol ${evidenceKinds[kind].label}: ${id}`;

export function validateCoverage() {
  const entries = Object.entries(evidenceKinds).flatMap(([kind, { ids }]) => {
    assert.ok(ids.length > 0, kind);
    return ids.map((id) => [id, { id, kind, file: evidenceFile, test: evidenceTest(kind, id) }]);
  });
  assert.equal(new Set(entries.map(([id]) => id)).size, entries.length, 'Evidence IDs must be globally unique');
  const registry = Object.fromEntries(entries);
  assert.ok(existsSync(new URL(evidenceFile, new URL('../../', import.meta.url))), evidenceFile);
  for (const [name, row] of [...Object.entries(coverage), ...Object.entries(behaviorLimits)]) {
    assert.ok(row.evidence.length > 0, name);
    assert.equal(new Set(row.evidence).size, row.evidence.length, `Duplicate evidence citation: ${name}`);
    for (const id of row.evidence) assert.ok(Object.hasOwn(registry, id), `Unknown evidence: ${name}: ${id}`);
  }
  for (const [name, limit] of Object.entries(behaviorLimits)) assert.ok(limit.claim.length > 0, name);
  const cited = new Set(Object.values(coverage).flatMap((row) => row.evidence));
  for (const [id, entry] of entries) {
    assert.ok(entry.kind === 'canonicalControls' || cited.has(id), `Evidence has no category credit: ${id}`);
  }
  return registry;
}
