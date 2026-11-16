import assert from 'node:assert/strict';
import test from 'node:test';
import { desktopCustomizationIdentity, planCustomizationCatalog, planServerCatalog, serverCatalog } from '@agentui/host/customization';
import { desktopPlan } from '../../../scripts/local-customization.mjs';

function node(identity, extensions = [], kinds = ['desktop', 'server']) {
  const entries = kinds.map((kind, index) => ({ kind, module: `./${index}.js` }));
  return { identity, commit: `${identity}-commit`, subdirectory: 'package', inputs: { identity: `${identity}-tree`, files: [] }, npm: { kind: 'absent' },
    directory: `/prepared/${identity}/package`, repositoryDirectory: `/prepared/${identity}`, extensions,
    customization: { shared: './shared.ts', local: { manifest: { namespace: identity, sdkVersion: '0.5.0', trust: 'full', entries },
      sources: new Map(entries.map(entry => [entry.module, entry.module.replace('.js', '.ts')])) } } };
}
test('desktop and server share diamond preorder, source paths and exact provenance projection', () => {
  const leaf = node('leaf'), left = node('left', [leaf]), right = node('right', [leaf]), root = node('root', [left, right]);
  const desktop = desktopPlan(root), server = planServerCatalog(root, '0.5.0');
  assert.equal(desktop.identity.schemaVersion, 1);
  assert.equal(desktop.identity.root, 'root');
  assert.deepEqual(desktop.identity.entries, ['root', 'left', 'leaf', 'right'].map(packageIdentity => ({ packageIdentity, module: './0.js' })));
  assert.deepEqual(desktop.identity.packages, server.catalog.packages);
  assert.deepEqual(desktop.identity.packages.map(pkg => pkg.identity), ['root', 'left', 'leaf', 'right']);
  assert.deepEqual(desktop.entries.map(entry => entry.source), ['root', 'left', 'leaf', 'right'].map(id => `/prepared/${id}/package/0.ts`));
  assert.deepEqual(server.sources, ['root', 'left', 'leaf', 'right'].map(id => `/prepared/${id}/package/1.ts`));
  assert.deepEqual(desktop.identity.packages[0], { identity: 'root', commit: 'root-commit', subdirectory: 'package', inputs: root.inputs, npm: { kind: 'absent' },
    local: { manifest: root.customization.local.manifest, sources: [{ module: './0.js', source: './0.ts' }, { module: './1.js', source: './1.ts' }] },
    shared: './shared.ts', extensions: [{ packageIdentity: 'left', commit: 'left-commit' }, { packageIdentity: 'right', commit: 'right-commit' }] });
  assert.equal(JSON.stringify(desktop.identity).includes('/prepared/'), false);
  assert.deepEqual(server.catalog.entries.map(entry => entry.index), [0, 1, 2, 3]);
});
test('desktop identity stores one manifest per package even with several selected entries', () => {
  const root = node('root', [], ['desktop', 'desktop']);
  const plan = planCustomizationCatalog(root, '0.5.0', 'desktop');
  const identity = desktopCustomizationIdentity(plan);
  assert.deepEqual(JSON.parse(JSON.stringify(identity)), { schemaVersion: 1, root: 'root', packages: plan.packages,
    entries: [{ packageIdentity: 'root', module: './0.js' }, { packageIdentity: 'root', module: './1.js' }] });
  assert.deepEqual(desktopPlan(root).entries.map(entry => entry.manifest), [root.customization.local.manifest, root.customization.local.manifest]);
  assert.throws(() => desktopCustomizationIdentity({ packages: [], entries: [] }), { code: 'invalid-graph' });
});
test('shared projection retains every pinned edge and excludes locked installation directories', () => {
  const child = node('child'), root = node('root', [child, { ...child, commit: 'later-commit' }]);
  root.npm = { kind: 'locked', identity: 'lock', directory: '/installed/private', packageManager: 'npm@11.19.1' };
  const desktop = desktopPlan(root), server = planServerCatalog(root, '0.5.0');
  assert.deepEqual(desktop.identity.packages, server.catalog.packages);
  assert.equal(desktop.identity.packages.length, 2);
  assert.deepEqual(desktop.identity.packages[0].extensions.map(edge => edge.commit), ['child-commit', 'later-commit']);
  assert.deepEqual(desktop.identity.packages[0].npm, { kind: 'locked', identity: 'lock', packageManager: 'npm@11.19.1' });
});
test('desktop accepts zero entries while server retains its entry limits', () => {
  const root = node('root', [], []);
  assert.deepEqual(desktopPlan(root).entries, []);
  assert.throws(() => planServerCatalog(root, '0.5.0'), { code: 'invalid-graph' });
  assert.equal(planServerCatalog(node('root', [], Array(64).fill('server')), '0.5.0').catalog.entries.length, 64);
  assert.throws(() => planServerCatalog(node('root', [], Array(65).fill('server')), '0.5.0'), { code: 'invalid-graph' });
});
test('both planners reject cycles, namespace conflicts, SDK mismatches and missing selected sources', () => {
  const cycle = node('cycle'); cycle.extensions.push(cycle);
  const duplicate = node('root', [node('child')]); duplicate.extensions[0].customization.local.manifest.namespace = 'root';
  const incompatible = node('incompatible'); incompatible.customization.local.manifest.sdkVersion = 'wrong';
  const missing = node('missing'); missing.customization.local.sources.clear();
  for (const root of [cycle, duplicate, incompatible, missing]) {
    assert.throws(() => desktopPlan(root), { code: 'invalid-graph' });
    assert.throws(() => planServerCatalog(root, '0.5.0'), { code: 'invalid-graph' });
  }
});
test('server reader catalog still rejects unreachable packages and wrong first-visit commits', () => {
  const root = node('root', [node('child')]);
  const plan = planCustomizationCatalog(root, '0.5.0', 'server');
  assert.throws(() => serverCatalog([...plan.packages, { ...plan.packages[1], identity: 'unreachable' }], '0.5.0'), { code: 'invalid-graph' });
  assert.throws(() => serverCatalog([{ ...plan.packages[0], extensions: [{ packageIdentity: 'child', commit: 'wrong' }] }, plan.packages[1]], '0.5.0'), { code: 'invalid-graph' });
});
