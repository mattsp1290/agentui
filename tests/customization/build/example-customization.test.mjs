import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { resolveCustomizationSources, serverCatalog } from '@agentui/host/customization';
import { buildServerCustomization } from '../../../scripts/server-customization.mjs';
import { checkout, committedTreeRepository, networkTests } from '../../support/committed-tree.mjs';

const subdirectory = 'examples/customization';
const namespaces = root => root.extensions.map(child => child.customization.local.manifest.namespace);

test('the example customization resolves both in-repository extensions and both grants from one acquisition', async t => {
  const repo = await committedTreeRepository(t);
  const commit = repo.commit();
  const resolved = await resolveCustomizationSources({ reference: { repository: repo.directory, commit, subdirectory }, scratchParent: repo.scratchParent });
  try {
    assert.deepEqual(resolved.root.extensions.map(child => child.subdirectory), ['extensions/crew', 'extensions/coworkers']);
    assert.deepEqual(namespaces(resolved.root), ['crew', 'coworkers']);
    assert.ok(resolved.root.extensions.every(child => child.repositoryDirectory === resolved.root.repositoryDirectory && child.commit === commit));
    assert.deepEqual(resolved.installations.map(grant => [grant.instance.namespace, grant.authentication.variable]),
      [['crew', 'AGENTUI_EXTENSION_CREW_TOKEN'], ['coworkers', 'AGENTUI_EXTENSION_COWORKERS_TOKEN']]);
    assert.deepEqual(resolved.root.npm, { kind: 'absent' });
  } finally { await resolved.dispose(); }
});

test('the example customization builds desktop and server artifacts and a disabled extension leaves both', { skip: !networkTests && 'set AGENTUI_CUSTOMIZATION_NETWORK_TESTS=1', timeout: 3_600_000 }, async t => {
  const repo = await committedTreeRepository(t);
  const build = async (commit, name) => {
    const reference = { repository: repo.directory, commit, subdirectory };
    let started = Date.now();
    const desktop = JSON.parse(execFileSync(process.execPath, [join(checkout, 'scripts/build-local-customization.mjs'), '--repository', repo.directory,
      '--commit', commit, '--subdirectory', subdirectory, '--out', join(repo.root, `${name}-desktop`)], { cwd: checkout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split('\n').at(-1));
    t.diagnostic(`${name} desktop build ${Date.now() - started} ms`);
    started = Date.now();
    const server = await buildServerCustomization({ reference, out: join(repo.root, `${name}-server`) });
    t.diagnostic(`${name} server build ${Date.now() - started} ms`);
    const identity = JSON.parse(await readFile(join(desktop.directory, 'customization-identity.json'), 'utf8'));
    const desktopNamespaces = identity.entries.map(entry => identity.packages.find(pkg => pkg.identity === entry.packageIdentity).local.manifest.namespace);
    return { desktop: desktopNamespaces.sort(), server: serverCatalog(server.manifest.packages, server.manifest.sdkVersion).manifests.map(item => item.namespace).sort() };
  };
  assert.deepEqual(await build(repo.commit(), 'both'), { desktop: ['coworkers', 'crew'], server: ['coworkers', 'crew'] });
  const path = join(repo.directory, subdirectory, 'package.json');
  const text = await readFile(path, 'utf8');
  const changed = text.replace('{ "subdirectory": "extensions/coworkers", "enabled": true }', '{ "subdirectory": "extensions/coworkers", "enabled": false }');
  assert.notEqual(changed, text);
  await writeFile(path, changed);
  assert.deepEqual(await build(repo.commit('disable coworkers'), 'crew-only'), { desktop: ['crew'], server: ['crew'] });
});
