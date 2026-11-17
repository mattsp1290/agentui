import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { loadServerExtension } from '@agentui/host/extensions';
import { entry } from './fixtures.mjs';

for (const [name, mutate] of [
  ['unsupported manifest version', value => { value.manifest.sdkVersion = '99.0.0'; }],
  ['undeclared server entry', value => { value.manifest.entries[0].kind = 'desktop'; }],
  ['traversal syntax', value => { value.manifest.entries[0].module = './../server.mjs'; }],
  ['missing file', value => { value.manifest.entries[0].module = './missing.mjs'; }],
]) test(`loader rejects ${name} before module import`, async t => {
  const fixture = entry(t); mutate(fixture.value);
  await assert.rejects(loadServerExtension(fixture.value), /^Error: Server extension loading failed$/);
  assert.equal(fixture.calls.import, 0); assert.equal(fixture.calls.activate, 0);
});

test('loader requires a regular file within the real installation directory', async t => {
  const fixture = entry(t), outside = entry(t);
  fixture.mkdir('nested');
  fixture.value.manifest.entries[0].module = './nested';
  await assert.rejects(loadServerExtension(fixture.value), /loading failed/);
  symlinkSync(join(outside.directory, 'server.mjs'), join(fixture.directory, 'escape.mjs'));
  fixture.value.manifest.entries[0].module = './escape.mjs';
  await assert.rejects(loadServerExtension(fixture.value), /loading failed/);
  assert.equal(outside.calls.import, 0);
  symlinkSync(join(fixture.directory, 'server.mjs'), join(fixture.directory, 'contained.mjs'));
  fixture.value.manifest.entries[0].module = './contained.mjs';
  const loaded = await loadServerExtension(fixture.value);
  assert.equal(loaded.entry.kind, 'server'); assert.equal(fixture.calls.import, 1);
  assert.equal(fixture.calls.activate, 0);
});

for (const exported of ['{}', "{ kind: 'desktop', sdkVersion: '0.7.0', activate() {} }", "{ kind: 'server', sdkVersion: 'old', activate() {} }"]) {
  test(`loader rejects an incompatible imported export ${exported}`, async t => {
    const fixture = entry(t); fixture.write(`export default ${exported};`);
    await assert.rejects(loadServerExtension(fixture.value), /^Error: Server extension loading failed$/);
    assert.equal(fixture.calls.activate, 0);
  });
}
