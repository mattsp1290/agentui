import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { EXTENSION_SDK_VERSION, parseExtensionManifest } from '@agentui/sdk';
import { bundledPlan } from '../../../scripts/bundled-extensions.mjs';
import { customizationPlugin, mergePlans } from '../../../scripts/lib/customization-plugin.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));

test('every in-repo extension manifest parses and targets the current SDK', async () => {
  const names = (await readdir(join(root, 'extensions'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  assert.ok(names.length > 0);
  for (const name of names) {
    const metadata = JSON.parse(await readFile(join(root, 'extensions', name, 'package.json'), 'utf8'));
    const manifest = parseExtensionManifest(metadata.agentui.extension);
    assert.equal(manifest.sdkVersion, EXTENSION_SDK_VERSION, name);
    assert.equal(metadata.name.startsWith('@agentui/'), false, `${name} stays outside the @agentui/ scope`);
  }
});

test('bundledPlan lists desktop entries sorted by namespace with only extension directories as roots', async t => {
  const plan = bundledPlan(root);
  const namespaces = plan.entries.map(entry => entry.manifest.namespace);
  assert.deepEqual(namespaces, [...namespaces].sort());
  assert.ok(namespaces.length > 0);
  assert.ok(plan.roots.every(directory => directory.startsWith(join(root, 'extensions'))));
  assert.equal(plan.roots.includes(root.replace(/\/$/u, '')), false);
  const temp = await mkdtemp(join(tmpdir(), 'agentui-bundled-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const write = async (name, extension, sources) => {
    await mkdir(join(temp, 'extensions', name, 'src'), { recursive: true });
    await writeFile(join(temp, 'extensions', name, 'src', 'index.tsx'), 'export default {};');
    await writeFile(join(temp, 'extensions', name, 'package.json'), JSON.stringify({ name: `agentui-extension-${name}`, agentui: { extension, sources } }));
  };
  const manifest = namespace => ({ namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'desktop', module: './dist/desktop.js' }] });
  await write('zeta', manifest('zeta'), { './dist/desktop.js': './src/index.tsx' });
  await write('alpha', manifest('alpha'), { './dist/desktop.js': './src/index.tsx' });
  await write('server', { ...manifest('server'), entries: [{ kind: 'server', module: './dist/server.js' }] }, {});
  assert.deepEqual(bundledPlan(temp).entries.map(entry => entry.manifest.namespace), ['alpha', 'zeta']);
  await write('stale', { ...manifest('stale'), sdkVersion: '0.1.0' }, { './dist/desktop.js': './src/index.tsx' });
  assert.throws(() => bundledPlan(temp), /targets SDK/);
  await write('stale', manifest('stale'), { './dist/desktop.js': '../alpha/src/index.tsx' });
  assert.throws(() => bundledPlan(temp), /outside its package/);
  // A symlink inside the package that points outside it is refused by its real path.
  const outside = join(temp, 'outside.tsx');
  await writeFile(outside, 'export default {};');
  await symlink(outside, join(temp, 'extensions', 'stale', 'src', 'linked.tsx'));
  await write('stale', manifest('stale'), { './dist/desktop.js': './src/linked.tsx' });
  assert.throws(() => bundledPlan(temp), /outside its package/);
});

test('the shared plugin admits a bundled package by its real name and refuses reserved owners and outside imports', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'agentui-bundled-policy-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const good = join(temp, 'good'), reserved = join(temp, 'reserved');
  for (const [directory, name] of [[good, 'agentui-extension-good'], [reserved, '@agentui/reserved']]) {
    await mkdir(join(directory, 'src'), { recursive: true });
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name }));
    await writeFile(join(directory, 'src', 'index.tsx'), 'export const value = 1;\n');
  }
  const plugin = customizationPlugin({ roots: [good, reserved], entries: [], identity: null });
  await plugin.load(join(good, 'src', 'index.tsx'));
  await assert.rejects(plugin.load(join(reserved, 'src', 'index.tsx')), /Duplicate shared customization dependency/);
  const context = { resolve: async () => null };
  await assert.rejects(plugin.resolveId.call(context, 'node:fs', join(good, 'src', 'index.tsx'), { kind: 'import-statement' }), /Unsupported customization import/);
  await assert.rejects(plugin.resolveId.call(context, '@agentui/host', join(good, 'src', 'index.tsx'), { kind: 'import-statement' }), /Unsupported customization import/);
});

test('mergePlans keeps bundled entries first and refuses a namespace in both plans', () => {
  const entry = namespace => ({ manifest: { namespace }, source: `/x/${namespace}.tsx` });
  const bundled = { roots: ['/repo/extensions/a'], entries: [entry('a')], identity: null };
  const external = { roots: ['/external'], entries: [entry('b')], identity: { root: 'id' } };
  assert.equal(mergePlans(bundled, null), bundled);
  assert.deepEqual(mergePlans(bundled, external), { roots: ['/repo/extensions/a', '/external'], entries: [entry('a'), entry('b')], identity: { root: 'id' } });
  assert.throws(() => mergePlans(bundled, { ...external, entries: [entry('a')] }), /Customization namespace a is both bundled and external/);
});
