import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readArtifactBytes } from '../../../apps/host/build/tsc/artifact.js';
import { customizationPlugin } from '../../../scripts/local-customization.mjs';
import { buildCustom, repository } from './support.mjs';
import { fixture as lockedFixture, tarball, write } from './preparation-support.mjs';

function fixture(t) {
  const value = repository();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  return value;
}
const entry = (source, activation = '') => `${source}
export default { kind: 'desktop', sdkVersion: '0.1.0', async activate() {
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
    agentui: { extension: { namespace: 'worker-export', trust: 'full', sdkVersion: '0.1.0',
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
