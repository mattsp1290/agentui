import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { digest, parseJson, readJson } from './bytes.mjs';

export function resolveLockedFork(root) {
  assert.ok(typeof root === 'string' && isAbsolute(root), 'fork root must be an absolute filesystem path');
  const locked = readJson(join(root, 'package-lock.json')).packages?.['node_modules/@ag-ui/core'];
  assert.ok(locked, 'root lock must contain @ag-ui/core');
  const match = /^file:(vendor\/ag-ui\/([a-f0-9]{40})\/)([^/]+\.tgz)$/u.exec(locked.resolved);
  assert.ok(match, 'SDK must resolve to a local fork archive');
  const [, directory, revision, archive] = match;
  const provenancePath = `${directory}provenance.json`;
  const bytes = readFileSync(join(root, provenancePath));
  const metadata = parseJson(bytes);
  assert.ok(metadata && Array.isArray(metadata.artifacts) && Array.isArray(metadata.evidence)
    && metadata.qualification && typeof metadata.qualification === 'object' && !Array.isArray(metadata.qualification),
    'fork metadata must declare artifacts and evidence arrays and a qualification object');
  assert.equal(metadata.sourceRevision, revision, 'fork source revision must match its directory');
  assert.equal(metadata.sourceRepository, 'https://github.com/mattsp1290/ag-ui', 'fork source repository');
  assert.equal(metadata.sourceBranch, 'matt.spurlin/typescript-sdks', 'fork source branch');
  assert.equal(metadata.sourcePullRequest, 'https://github.com/mattsp1290/ag-ui/pull/49', 'fork pull request');
  const core = metadata.artifacts.find((artifact) => artifact.package === '@ag-ui/core');
  assert.ok(core, 'fork metadata must contain @ag-ui/core');
  assert.equal(core.artifact, archive, 'fork core archive');
  assert.equal(locked.integrity, core.npmIntegrity, 'fork lock integrity');
  assert.equal(locked.version, core.version, 'fork lock version');
  for (const workspace of ['packages/protocol', 'packages/host']) {
    assert.equal(readJson(join(root, workspace, 'package.json')).dependencies?.['@ag-ui/core'],
      `file:../../${directory}${archive}`, `${workspace}: fork dependency`);
  }
  return {
    folder: join(root, directory), provenancePath, metadata, core,
    provenanceSha256: digest(bytes),
  };
}
