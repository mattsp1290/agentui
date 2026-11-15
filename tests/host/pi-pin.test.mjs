import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveHostDependency } from '../../packages/host/test-support/dependencies.mjs';

const root = new URL('../../', import.meta.url);
const json = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
test('Pi host consumes the pinned public Switchboard artifact with SDK-free declarations', () => {
  const pin = json('vendor/switchboard-pi.json');
  const artifact = json(`vendor/${pin.qualificationRecord}`);
  const host = json('packages/host/package.json');
  assert.equal(host.dependencies['@agentui/switchboard-pi'], `file:../../vendor/${artifact.artifact}`);
  assert.equal(createHash('sha256').update(readFileSync(new URL(`vendor/${artifact.artifact}`, root))).digest('hex'), artifact.sha256);
  assert.equal(host.dependencies['@earendil-works/pi-ai'], pin.nativeSdk);
  assert.equal(host.dependencies['@earendil-works/pi-coding-agent'], pin.nativeSdk);
  const entry = fileURLToPath(resolveHostDependency('@agentui/switchboard-pi/pi'));
  const declarations = readFileSync(entry.replace(/\.js$/, '.d.ts'), 'utf8');
  assert(!declarations.includes('@earendil-works/'), 'Public Pi types must not expose native SDK declarations');
  const lock = json('package-lock.json');
  assert.equal(lock.packages['packages/host'].dependencies['@agentui/switchboard-pi'], `file:../../vendor/${artifact.artifact}`);
  assert.equal(pin.provider, 'opencode-go');
  assert.equal(pin.model, 'glm-5.3');
});
