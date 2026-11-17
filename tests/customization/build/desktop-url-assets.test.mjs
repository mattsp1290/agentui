import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { readArtifactBytes } from '../../../apps/host/build/tsc/artifact.js';
import { customizationPlugin } from '../../../scripts/local-customization.mjs';
import { customizationCssPolicy } from '../../../scripts/lib/customization-asset-policy.mjs';
import { buildCustom, repository } from './support.mjs';
import { fixture as lockedFixture, tarball, write } from './preparation-support.mjs';

function fixture(t) {
  const value = repository();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  return value;
}
const entry = (source, activation = '') => `${source}
export default { kind: 'desktop', sdkVersion: '0.7.0', async activate() {
  ${activation}
  return { modules: [], dispose() {} };
} };`;

for (const [label, source, css, cssFile = 'style.css'] of [
  ['static URL', "console.log(new URL('../../../../outside.txt', import.meta.url).href);"],
  ['emitted static URL', "console.log(new URL('../../../../outside.txt?no-inline#part', import.meta.url).href);"],
  ['query path traversal', "console.log(new URL('./asset.txt?x/../../../../../outside.txt', import.meta.url).href);"],
  ['typed static URL', "console.log(new (URL as any)('../../../../outside.txt' as string, import.meta.url!).href);"],
  ['computed URL template', "const name = 'outside'; console.log(new URL(`../../../../${name}.txt`, import.meta.url).href);"],
  ['CSS inline URL', "import './style.css';", "body { background: url('../../../../outside.txt'); }"],
  ['CSS emitted URL', "import './style.css';", "body { background: url('../../../../outside.txt?no-inline'); }"],
  ['CSS query path traversal', "import './style.css';", "body { background: url('./asset.txt?x/../../../../../outside.txt'); }"],
  ['CSS public lookup', "import './style.css';", "body { background: url('/outside.txt'); }"],
  ['CSS file URL', "import './style.css';", "body { background: url('file:///outside.txt'); }"],
  ['CSS computed URL', "import './style.css';", 'body { background: url(var(--asset)); }'],
  ['CSS image set', "import './style.css';", "body { background: image-set('../../../../outside.txt' 1x); }"],
  ['CSS escaped URL', "import './style.css';", "body { background: url('./as\\73 et.txt'); }"],
  ['CSS import', "import './style.css';", '@import "../../../../outside.css";'],
  ['CSS empty import', "import './style.css';", '@import "../../../../empty.css";'],
  ['CSS module value import', "import values from './style.module.css'; console.log(values.secret);", '@value secret from "../../../../outside.css";', 'style.module.css'],
  ['worker query', "import Worker from './worker.js?worker'; console.log(Worker);"],
  ['worker URL constructor', "console.log(() => new Worker(new URL('./worker.js', import.meta.url)));"],
  ['typed shared worker URL constructor', "console.log(() => new SharedWorker(new URL('./worker.js', import.meta.url) as URL));"],
]) test(`desktop rejects ambient ${label} and cleans owned output`, { timeout: 30_000 }, t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'outside.txt'), 'HARMLESS AMBIENT CANARY');
  writeFileSync(join(f.directory, 'outside.css'), '@value secret: HARMLESS_AMBIENT_CANARY;');
  writeFileSync(join(f.directory, 'empty.css'), '');
  if (css) f.write(`desktop/${cssFile}`, css);
  f.write('desktop/worker.js', "import value from '../../../../outside.txt?raw'; self.onmessage = () => self.postMessage(value);");
  f.write('desktop/index.tsx', entry(source));
  assert.throws(() => buildCustom(f), /customization (?:asset|CSS)|computedAssetUrl|unsupportedWorker/);
  assert.equal(existsSync(join(f.directory, 'browser')), false);
  assert.deepEqual(readdirSync(f.directory).sort(), ['empty.css', 'outside.css', 'outside.txt', 'source']);
});

test('contained URL and CSS assets fetch exact committed bytes during browser activation', { timeout: 30_000 }, t => {
  const f = fixture(t), bytes = 'COMMITTED ASSET BYTES\n'.repeat(300);
  f.write('desktop/asset.txt', bytes);
  f.write('desktop/style.css', 'body { background: url(asset.txt?no-inline#part); }');
  f.write('desktop/imported.css', '.committed { color: red; }');
  f.write('desktop/parent.css', '@import "./imported.css";');
  f.write('desktop/index.tsx', entry(`import style from './style.css?url';
import './parent.css';
const literal = new URL('./asset.txt?no-inline#part', import.meta.url);
const template = new URL(\`./asset.txt?no-inline\`, import.meta.url);`, `
  const expected = 'COMMITTED ASSET BYTES\\n'.repeat(300);
  for (const url of [literal, template]) {
    const response = await fetch(url);
    if (!response.ok || await response.text() !== expected) throw new Error('URL asset bytes differ');
  }
  const css = await (await fetch(style)).text();
  const cssAsset = css.match(/url\\(["']?([^"')]+)["']?\\)/)[1];
  if (await (await fetch(new URL(cssAsset, style))).text() !== expected) throw new Error('CSS asset bytes differ');`));
  const commit = f.commit();
  f.write('desktop/asset.txt', 'DIRTY ASSET MUST NOT APPEAR');
  buildCustom(f, commit);
  const artifact = readArtifactBytes(join(f.directory, 'browser'), 'browser-development');
  assert.ok([...artifact.files.values()].some(value => value.toString() === bytes));
  assert.ok([...artifact.files.values()].every(value => !value.toString().includes('DIRTY ASSET MUST NOT APPEAR')));
});

for (const [label, owner, css, reference, nested = false] of [
  ['inline browser mapping', '.', 'desktop/style.css', './asset.txt'],
  ['emitted browser mapping', '.', 'desktop/style.css', './asset.txt?no-inline'],
  ['parent browser mapping behind a nested manifest', '.', 'desktop/style.css', './asset.txt', true],
  ['target browser mapping', 'desktop/nested', 'desktop/style.css', './nested/asset.txt'],
  ['importer browser mapping', 'desktop/nested', 'desktop/nested/style.css', '../asset.txt'],
  ['unrelated browser mapping', '.', 'desktop/style.css', './asset.txt'],
]) test(`desktop rejects CSS ${label} and cleans owned output`, { timeout: 30_000 }, t => {
  const f = fixture(t), outside = join(f.directory, 'outside.txt');
  writeFileSync(outside, 'HARMLESS AMBIENT BROWSER MAP CANARY');
  mkdirSync(join(f.repo, 'desktop/nested'), { recursive: true });
  f.write('desktop/asset.txt', 'CONTAINED ASSET');
  f.write('desktop/nested/asset.txt', 'NESTED CONTAINED ASSET');
  if (nested) f.write('desktop/package.json', JSON.stringify({ name: 'nested' }));
  const manifest = owner === '.' ? JSON.parse(readFileSync(join(f.repo, 'package.json'), 'utf8')) : { name: 'nested' };
  const key = label === 'unrelated browser mapping' ? './unused.js' : owner === '.' ? './desktop/asset.txt' : './asset.txt';
  manifest.browser = { [key]: outside };
  f.write(`${owner}/package.json`, JSON.stringify(manifest));
  f.write(css, `body { background: url('${reference}'); }`);
  f.write('desktop/index.tsx', entry(`import './${css.slice('desktop/'.length)}';`));
  assert.throws(() => buildCustom(f), /Unsupported customization CSS browser mappings/);
  assert.deepEqual(readdirSync(f.directory).sort(), ['outside.txt', 'source']);
});

for (const reference of ['@vite/client', '@vite/env', '@%76ite/client']) {
  test(`desktop rejects reserved CSS alias ${reference}`, { timeout: 30_000 }, t => {
    const f = fixture(t);
    mkdirSync(join(f.repo, 'desktop/@vite'));
    f.write('desktop/@vite/client', 'CONTAINED CLIENT DECOY');
    f.write('desktop/@vite/env', 'CONTAINED ENV DECOY');
    f.write('desktop/style.css', `body { background: url('${reference}?no-inline'); }`);
    f.write('desktop/index.tsx', entry("import './style.css';"));
    assert.throws(() => buildCustom(f), /Unsupported customization CSS URL alias/);
    assert.deepEqual(readdirSync(f.directory), ['source']);
  });
}

test('CSS assets retain string browser entries and explicit local Vite-named assets', { timeout: 30_000 }, t => {
  const f = fixture(t), bytes = 'CONTAINED VITE-NAMED ASSET';
  const manifest = JSON.parse(readFileSync(join(f.repo, 'package.json'), 'utf8'));
  manifest.browser = './desktop/index.tsx';
  f.write('package.json', JSON.stringify(manifest));
  mkdirSync(join(f.repo, 'desktop/@vite'));
  f.write('desktop/@vite/client', bytes);
  f.write('desktop/style.css', "body { background: url('./@vite/client?no-inline'); }");
  f.write('desktop/index.tsx', entry("import './style.css';"));
  buildCustom(f);
  const artifact = readArtifactBytes(join(f.directory, 'browser'), 'browser-development');
  assert.ok([...artifact.files.values()].some(value => value.toString() === bytes));
});

test('JavaScript-only packages retain contained browser mappings', { timeout: 30_000 }, t => {
  const f = fixture(t), manifest = JSON.parse(readFileSync(join(f.repo, 'package.json'), 'utf8'));
  manifest.browser = { './desktop/value.js': './desktop/browser.js' };
  f.write('package.json', JSON.stringify(manifest));
  f.write('desktop/value.js', "export default 'UNMAPPED';");
  f.write('desktop/browser.js', "export default 'CONTAINED BROWSER MAPPING';");
  f.write('desktop/index.tsx', entry("import value from './value.js';", "if (value !== 'CONTAINED BROWSER MAPPING') throw new Error('Missing JavaScript browser mapping');"));
  buildCustom(f);
});

for (const query of ['', '?no-inline']) test(`a locked CSS package rejects browser asset mappings ${query || 'inline'}`, { timeout: 30_000 }, async t => {
  const f = await lockedFixture(t), repo = await f.repository('browser-assets');
  await write(f.root, 'outside.txt', 'HARMLESS AMBIENT LOCKED BROWSER MAP CANARY');
  const dependency = await tarball(f, repo, 'value', '1.0.0', {
    exports: './style.css', browser: { './asset.txt': join(f.root, 'outside.txt') },
  }, { 'style.css': `body { background: url('./asset.txt${query}'); }`, 'asset.txt': 'CONTAINED LOCKED ASSET' });
  const dependencies = { value: dependency.resolved };
  await write(repo.directory, 'package.json', {
    name: 'fixture', version: '1.0.0', type: 'module', packageManager: 'npm@11.19.1', dependencies,
    agentui: { extension: { namespace: 'browser-assets', trust: 'full', sdkVersion: '0.7.0',
      entries: [{ kind: 'desktop', module: './desktop.js' }] }, sources: { './desktop.js': './index.ts' } },
  });
  await write(repo.directory, 'package-lock.json', {
    name: 'fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.0.0', dependencies }, 'node_modules/value': dependency },
  });
  await write(repo.directory, 'index.ts', entry("import 'value';"));
  const commit = repo.commit(), before = readdirSync(f.root).sort();
  assert.throws(() => execFileSync(process.execPath, ['scripts/build-local-customization.mjs', '--repository', repo.directory,
    '--commit', commit, '--out', join(f.root, 'artifact')], { encoding: 'utf8', stdio: 'pipe' }), /Unsupported customization CSS browser mappings/);
  assert.deepEqual(readdirSync(f.root).sort(), before);
});

for (const kind of ['importer', 'target']) for (const owner of ['logical', 'canonical']) {
  test(`CSS asset browser mappings reject ${owner} ${kind} ancestry through symlinks`, async t => {
    const f = fixture(t);
    mkdirSync(join(f.directory, 'prepared'));
    const prepared = realpathSync(join(f.directory, 'prepared'));
    mkdirSync(join(prepared, 'logical'), { recursive: true });
    mkdirSync(join(prepared, 'canonical'));
    writeFileSync(join(prepared, owner, 'package.json'), JSON.stringify({ browser: { './unused.js': './other.js' } }));
    writeFileSync(join(prepared, 'canonical/style.css'), 'body {}');
    writeFileSync(join(prepared, 'canonical/asset.txt'), 'CONTAINED ASSET');
    writeFileSync(join(prepared, 'style.css'), 'body {}');
    symlinkSync(join(prepared, 'canonical/style.css'), join(prepared, 'logical/style.css'));
    if (kind === 'target') symlinkSync(join(prepared, 'canonical/asset.txt'), join(prepared, 'logical/asset.txt'));
    else writeFileSync(join(prepared, 'logical/asset.txt'), 'CONTAINED ASSET');
    const source = join(prepared, kind === 'importer' ? 'logical/style.css' : 'style.css');
    const reference = kind === 'importer' ? './asset.txt' : './logical/asset.txt';
    await assert.rejects(postcss([customizationCssPolicy([prepared])])
      .process(`body { background: url('${reference}'); }`, { from: source }), /Unsupported customization CSS browser mappings/);
  });
}

test('a prepared URL asset symlink cannot escape containment', async t => {
  const f = fixture(t);
  mkdirSync(join(f.directory, 'prepared'));
  const prepared = realpathSync(join(f.directory, 'prepared'));
  writeFileSync(join(f.directory, 'outside.txt'), 'HARMLESS AMBIENT CANARY');
  symlinkSync(join(f.directory, 'outside.txt'), join(prepared, 'asset.txt'));
  const source = join(prepared, 'entry.js');
  writeFileSync(source, "console.log(new URL('./asset.txt', import.meta.url));");
  const plugin = customizationPlugin({ roots: [prepared], entries: [] });
  await assert.rejects(plugin.load(source), /customization asset/);
});

test('node_modules hash filenames cannot hide an escaping URL asset symlink', async t => {
  const f = fixture(t);
  mkdirSync(join(f.directory, 'prepared/node_modules/example'), { recursive: true });
  const prepared = realpathSync(join(f.directory, 'prepared'));
  writeFileSync(join(f.directory, 'outside.txt'), 'HARMLESS AMBIENT CANARY');
  writeFileSync(join(prepared, 'node_modules/example/asset.txt'), 'CONTAINED ASSET');
  symlinkSync(join(f.directory, 'outside.txt'), join(prepared, 'node_modules/example/asset.txt#part'));
  const source = join(prepared, 'entry.js');
  writeFileSync(source, "console.log(new URL('./node_modules/example/asset.txt#part', import.meta.url));");
  const plugin = customizationPlugin({ roots: [prepared], entries: [] });
  await assert.rejects(plugin.load(source), /customization asset/);
});

for (const [target, contents, error] of [
  ['worker.js?worker', "import value from '../../../../../outside.txt?raw'; self.onmessage = () => self.postMessage(value);", /unsupportedWorker/],
  ['worker.js?sharedworker', "import value from '../../../../../outside.txt?raw'; self.onmessage = () => self.postMessage(value);", /unsupportedWorker/],
  ['style.module.css', '@value secret from "../../../../../outside.css";', /Unsupported customization CSS modules/],
]) test(`a locked package export cannot hide ${target} compilation`, { timeout: 30_000 }, async t => {
  const f = await lockedFixture(t), repo = await f.repository('worker-export');
  const dependency = await tarball(f, repo, 'value', '1.0.0', { exports: `./${target}` }, { [target.split('?')[0]]: contents });
  const dependencies = { value: dependency.resolved };
  await write(f.root, 'outside.txt', 'HARMLESS AMBIENT WORKER CANARY');
  await write(f.root, 'outside.css', '@value secret: HARMLESS_AMBIENT_MODULE_CANARY;');
  await write(repo.directory, 'package.json', {
    name: 'fixture', version: '1.0.0', type: 'module', packageManager: 'npm@11.19.1', dependencies,
    agentui: { extension: { namespace: 'worker-export', trust: 'full', sdkVersion: '0.7.0',
      entries: [{ kind: 'desktop', module: './desktop.js' }] }, sources: { './desktop.js': './index.ts' } },
  });
  await write(repo.directory, 'package-lock.json', {
    name: 'fixture', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'fixture', version: '1.0.0', dependencies }, 'node_modules/value': dependency },
  });
  await write(repo.directory, 'index.ts', entry("import Worker from 'value'; console.log(Worker);"));
  const commit = repo.commit(), before = readdirSync(f.root).sort();
  assert.throws(() => execFileSync(process.execPath, ['scripts/build-local-customization.mjs', '--repository', repo.directory,
    '--commit', commit, '--out', join(f.root, 'artifact')], { encoding: 'utf8', stdio: 'pipe' }), error);
  assert.deepEqual(readdirSync(f.root).sort(), before);
});
