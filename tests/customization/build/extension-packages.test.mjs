import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { readServerCustomizationArtifact, resolveCustomizationSources } from '@agentui/host/customization';
import { loadServerArtifact } from '@agentui/host/extensions';
import { buildServerCustomization } from '../../../scripts/server-customization.mjs';
import { committedTreeRepository, networkTests } from '../../support/committed-tree.mjs';
import { expectation } from './server-support.mjs';

const packages = [
  { subdirectory: 'extensions/crew', namespace: 'crew', service: 'http://127.0.0.1:8080' },
  { subdirectory: 'extensions/coworkers', namespace: 'coworkers', service: 'http://127.0.0.1:8787' },
];

test('both in-repository extensions resolve as selected customization packages', async t => {
  const repo = await committedTreeRepository(t);
  const commit = repo.commit();
  for (const { subdirectory, namespace } of packages) {
    const resolved = await resolveCustomizationSources({ reference: { repository: repo.directory, commit, subdirectory }, scratchParent: repo.scratchParent });
    try {
      const local = resolved.root.customization?.local;
      assert.equal(local?.manifest.namespace, namespace);
      assert.deepEqual([...local.sources.keys()].sort(), ['./dist/desktop.js', './dist/server.js']);
    } finally { await resolved.dispose(); }
  }
});

test('both in-repository extensions build server artifacts that activate a provider', { skip: !networkTests && 'set AGENTUI_CUSTOMIZATION_NETWORK_TESTS=1' }, async t => {
  const repo = await committedTreeRepository(t);
  const commit = repo.commit();
  for (const { subdirectory, namespace, service } of packages) {
    const started = Date.now();
    const built = await buildServerCustomization({ reference: { repository: repo.directory, commit, subdirectory }, out: join(repo.root, `${namespace}-server`) });
    t.diagnostic(`${namespace} server artifact built in ${Date.now() - started} ms`);
    await access(join(built.directory, 'entries.mjs'));
    await access(join(built.directory, 'customization.json'));
    const verified = await readServerCustomizationArtifact({ directory: built.directory, expected: expectation(built.manifest) });
    const loaded = await loadServerArtifact(verified, import.meta.resolve('@agentui/sdk'));
    try {
      assert.equal(loaded.length, 1);
      assert.equal(loaded[0].entry.kind, 'server');
      const providers = [], operations = [];
      const instance = { namespace, installationId: 'personal', generation: '1', protocolVersion: '1' };
      const lifetime = await loaded[0].entry.activate({ namespace, installations: [{ id: 'personal', instance, service, expectedAuthority: 'remote-provider' }],
        providers: { add: id => providers.push(id), addAgui: id => providers.push(id) },
        operations: { add: id => operations.push(id) }, credentials: { use: () => { throw new Error('No credential use expected'); } } });
      assert.deepEqual(providers, ['personal']);
      await lifetime.dispose();
    } finally { for (const item of loaded) await item.dispose(); }
  }
});
