import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveLockedFork } from '../../scripts/lib/agui-fork.mjs';
import { retained } from './inputs.mjs';

test('AG-UI SDK, validator and installed license match the retained pins', () => {
  const root = new URL('../../', import.meta.url);
  const json = (file) => JSON.parse(readFileSync(new URL(file, root), 'utf8'));
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const { pin, provenance } = retained;
  const sdk = pin.artifacts.find((artifact) => artifact.package === '@ag-ui/core');
  const lock = json('package-lock.json');
  const fork = resolveLockedFork(fileURLToPath(root));
  assert.equal(digest(readFileSync(join(fork.folder, fork.core.artifact))), fork.core.sha256, 'Installed SDK archive digest must match fork provenance');
  assert.equal(fork.core.version, sdk.version, 'Installed SDK version must match the historical pin');
  const project = json('package.json');
  assert.equal(digest(readFileSync(new URL('node_modules/@mattsp1290/switchboard/LICENSE', root))), provenance.files['SWITCHBOARD-LICENSE'].sha256, 'Installed Switchboard license must match the retained digest');
  assert.equal(lock.packages['node_modules/ajv'].version, project.devDependencies.ajv, 'Locked Ajv version must match the root manifest');
  assert.equal(json('node_modules/@ag-ui/core/package.json').version, sdk.version, 'Installed SDK version must match the retained pin');
  assert.equal(json('node_modules/ajv/package.json').version, project.devDependencies.ajv, 'Installed Ajv version must match the root manifest');
});
