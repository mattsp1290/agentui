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
  const project = json('package.json');
  assert.equal(digest(readFileSync(new URL('node_modules/@mattsp1290/switchboard/LICENSE', root))), provenance.files['SWITCHBOARD-LICENSE'].sha256);
  for (const workspace of ['packages/protocol', 'packages/host']) {
    assert.equal(json(`${workspace}/package.json`).dependencies[sdk.package], sdk.version, workspace);
  }
  assert.equal(lock.packages['node_modules/@ag-ui/core'].version, sdk.version);
  assert.equal(lock.packages['node_modules/@ag-ui/core'].integrity, sdk.integrity);
  assert.equal(lock.packages['node_modules/ajv'].version, project.devDependencies.ajv);
  assert.equal(json('node_modules/@ag-ui/core/package.json').version, sdk.version);
  assert.equal(json('node_modules/ajv/package.json').version, project.devDependencies.ajv);
});
