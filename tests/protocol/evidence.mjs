import assert from 'node:assert/strict';
import { behaviorLimits, coverage } from './coverage.mjs';
import { canonicalControls } from './canonical.mjs';
import { installedFixtures } from './fixtures/installed.mjs';
import { publishedTypeContracts } from './fixtures/types.mjs';

export const evidenceKinds = {
  installedFixtures: { label: 'installed fixture', bodies: installedFixtures },
  canonicalControls: { label: 'canonical control', bodies: canonicalControls },
  publishedTypeContracts: { label: 'published type contract', bodies: publishedTypeContracts },
};
export const evidenceTest = (kind, id) => `protocol ${evidenceKinds[kind].label}: ${id}`;

export function validateCoverage() {
  const entries = Object.entries(evidenceKinds).flatMap(([kind, { bodies }]) => {
    const ids = Object.keys(bodies);
    assert.ok(ids.length > 0, kind);
    return ids.map((id) => {
      assert.equal(typeof bodies[id], 'function', `Evidence body is not callable: ${id}`);
      return [id, kind];
    });
  });
  assert.equal(new Set(entries.map(([id]) => id)).size, entries.length, 'Evidence IDs must be globally unique');
  const registry = Object.fromEntries(entries);
  for (const [name, row] of [...Object.entries(coverage), ...Object.entries(behaviorLimits)]) {
    assert.ok(row.evidence.length > 0, name);
    assert.equal(new Set(row.evidence).size, row.evidence.length, `Duplicate evidence citation: ${name}`);
    for (const id of row.evidence) assert.ok(Object.hasOwn(registry, id), `Unknown evidence: ${name}: ${id}`);
  }
  for (const [name, limit] of Object.entries(behaviorLimits)) assert.ok(limit.claim.length > 0, name);
  for (const [category, row] of Object.entries(coverage)) {
    assert.ok(['represented', 'partial', 'wire-only'].includes(row.mapping), category);
    assert.ok(row.pending.length > 0 && row.pending.every((owner) => owner.length > 0), category);
  }
  const cited = new Set(Object.values(coverage).flatMap((row) => row.evidence));
  for (const [id] of entries) {
    assert.ok(cited.has(id), `Evidence has no category credit: ${id}`);
  }
  return registry;
}
