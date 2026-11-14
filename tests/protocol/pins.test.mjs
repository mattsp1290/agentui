import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { retained } from './inputs.mjs';

test('AG-UI SDK, validator and installed license match the retained pins', () => {
  const root = new URL('../../', import.meta.url);
  const json = (file) => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const { pin, provenance } = retained;
  const sdk = pin.artifacts.find((artifact) => artifact.package === '@ag-ui/core');
  const lock = json('package-lock.json');
  const locked = lock.packages['node_modules/@ag-ui/core'];
  assert.match(locked.resolved, /^file:vendor\/ag-ui\/[a-f0-9]{40}\/[^/]+\.tgz$/u, 'SDK must resolve to a local fork archive');
  const forkDirectory = locked.resolved.slice(5, locked.resolved.lastIndexOf('/') + 1);
  const fork = json(`${forkDirectory}provenance.json`);
  const installedSdk = fork.artifacts.find((artifact) => artifact.package === sdk.package);
  const archive = `${forkDirectory}${installedSdk.artifact}`;
  assert.equal(digest(readFileSync(new URL(archive, root))), installedSdk.sha256);
  assert.equal(installedSdk.version, sdk.version);
  const project = json('package.json');
  assert.equal(digest(readFileSync(new URL('node_modules/@mattsp1290/switchboard/LICENSE', root))), provenance.files['SWITCHBOARD-LICENSE'].sha256);
  for (const workspace of ['packages/protocol', 'packages/host']) {
    assert.equal(json(`${workspace}/package.json`).dependencies[sdk.package], `file:../../${archive}`, workspace);
  }
  assert.equal(lock.packages['node_modules/@ag-ui/core'].version, sdk.version);
  assert.equal(lock.packages['node_modules/@ag-ui/core'].resolved, `file:${archive}`);
  assert.equal(lock.packages['node_modules/@ag-ui/core'].integrity, installedSdk.npmIntegrity);
  assert.equal(lock.packages['node_modules/ajv'].version, project.devDependencies.ajv);
  assert.equal(json('node_modules/@ag-ui/core/package.json').version, sdk.version);
  assert.equal(json('node_modules/ajv/package.json').version, project.devDependencies.ajv);
});
