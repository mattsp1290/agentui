import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson, JSON_MAX_NODES, JsonLimitError } from '@agentui/contracts';
import { parseServerCustomizationArtifact, readServerCustomizationArtifact, serverCustomizationArtifactId } from '@agentui/host/customization';
import { treeIdentity } from '../../packages/host/dist/customization/repository.js';
import { packageIdentity } from '../../packages/host/dist/customization/sources.js';
import { REFRESH_SELECTION_PREFIX, RECEIPT_LIMIT } from '../../apps/host/build/tsc/selection-protocol.js';
import { expectation } from '../customization/build/server-support.mjs';
import { rows } from './refresh-support.mjs';

export function nodes(value) {
  return 1 + (value && typeof value === 'object' ? Object.values(value).reduce((sum, child) => sum + nodes(child), 0) : 0);
}
function metadata(seed, fileCount, edges) {
  const root = structuredClone(seed.packages[0]);
  const child = { ...structuredClone(root), subdirectory: '', inputs: { files: [], identity: '' }, local: null, extensions: [] };
  for (let i = 0; i < fileCount; i++) {
    const pkg = i < 13000 ? root : child;
    pkg.inputs.files.push({ path: `synthetic/${String(i).padStart(5, '0')}`, sha256: 'a'.repeat(64), executable: false });
  }
  for (const pkg of [root, child]) {
    pkg.inputs.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    pkg.inputs.identity = treeIdentity(pkg.inputs.files);
    pkg.identity = packageIdentity(pkg.inputs.identity, pkg.subdirectory);
  }
  root.extensions = Array.from({ length: edges }, () => ({ packageIdentity: child.identity, commit: child.commit }));
  const { artifactId: _, ...body } = { ...seed, packages: [root, child], root: root.identity,
    entries: seed.entries.map(entry => ({ ...entry, packageIdentity: root.identity })) };
  return parseServerCustomizationArtifact({ ...body, artifactId: serverCustomizationArtifactId(body) });
}
export async function syntheticResult(f, command, { files = 13000, jobNodes } = {}) {
  const admitted = JSON.parse(rows(f.database).find(row => row.id === command.requestId).body);
  const envelope = manifest => {
    const pin = { directory: command.directory, artifactId: manifest.artifactId };
    return { ...admitted, build: { kind: 'built', command, pin, manifest }, promotion: { kind: 'unconfirmed',
      command: { id: REFRESH_SELECTION_PREFIX + command.id, expectedRevision: admitted.request.expectedSelectionRevision, selection: { version: 1, artifacts: [pin] } } } };
  };
  let manifest;
  if (jobNodes === undefined) manifest = metadata(f.seed.manifest, files, 1);
  else {
    for (let edges = 1; edges <= 4; edges++) {
      const remaining = jobNodes - nodes(envelope(metadata(f.seed.manifest, 0, edges)));
      if (remaining >= 0 && remaining % 4 === 0) { manifest = metadata(f.seed.manifest, remaining / 4, edges); break; }
    }
    assert.ok(manifest, 'valid input-file and dependency-edge counts reach the exact job node budget');
  }
  const job = envelope(manifest);
  assert.ok(Buffer.byteLength(JSON.stringify(manifest)) < RECEIPT_LIMIT);
  if (jobNodes !== undefined) assert.equal(nodes(job), jobNodes);
  await fs.cp(f.seed.directory, command.directory, { recursive: true });
  await fs.writeFile(join(command.directory, 'customization.json'), JSON.stringify(manifest));
  const verified = await readServerCustomizationArtifact({ directory: command.directory, expected: expectation(manifest) });
  assert.deepEqual(verified.manifest, manifest);
  return { result: { kind: 'built', pin: job.build.pin, manifest }, job };
}
export function assertFits(value) {
  assert.ok(Buffer.byteLength(canonicalJson(value)) <= RECEIPT_LIMIT);
}
export function assertExceeds(value) {
  assert.throws(() => canonicalJson(value), JsonLimitError);
}
export { JSON_MAX_NODES };
