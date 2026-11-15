import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readArtifactBytes } from '../../../apps/host/build/tsc/artifact.js';
import { repository, buildCustom } from './support.mjs';

function fixture(t) {
  const value = repository();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  return value;
}
test('exact committed TSX/shared source produces a complete verified artifact and refuses overwrite', { timeout: 60_000 }, t => {
  const f = fixture(t), commit = f.commit(), out = join(f.directory, 'browser');
  f.write('shared/prompts.ts', "export const reviewPrompt = 'DIRTY PROMPT MUST NOT APPEAR';");
  f.write('untracked.js', 'UNTRACKED MUST NOT APPEAR');
  buildCustom(f, commit);
  const artifact = readArtifactBytes(out, 'browser-development');
  assert.equal(JSON.parse(readFileSync(join(out, 'customization-identity.json'))).commit, commit);
  assert.ok(artifact.files.has('browser.html'));
  const js = [...artifact.files].filter(([path]) => path.endsWith('.js')).map(([, bytes]) => bytes.toString()).join('\n');
  assert.match(js, /Review our current plan/);
  assert.doesNotMatch(js, /DIRTY PROMPT|UNTRACKED MUST/);
  assert.throws(() => buildCustom(f, commit), /EEXIST/);
  assert.equal(readArtifactBytes(out, 'browser-development').manifest.artifactId, artifact.manifest.artifactId);
  const asset = artifact.manifest.assets.find(asset => asset.path.endsWith('.js'));
  writeFileSync(join(out, asset.path), 'tampered');
  assert.throws(() => readArtifactBytes(out, 'browser-development'), /digest mismatch/);
  assert.deepEqual(readdirSync(f.directory).sort(), ['browser', 'source']);
});

const cases = [
  ['parent escape', "import '../../escape.js';", /contained customization source/],
  ['absolute import', "import '/etc/passwd';", /Unsupported customization import/],
  ['bare import', "import 'other-package';", /Unsupported customization import/],
  ['asset import', "import '../shared/prompts.ts?raw';", /Unsupported customization import/],
  ['missing source', "import './missing.js';", /contained customization source/],
  ['computed import', 'import(globalThis.moduleName);', /computed or ambient/],
  ['import meta', 'console.log(import.meta.glob("./*.tsx"));', /computed or ambient/],
  ['require', 'require("react");', /computed or ambient/],
  ['ambient reference', '/// <reference path="../../ambient.d.ts" />\nexport default {};', /ambient reference/],
];
for (const [label, source, error] of cases) test(`unsupported ${label} cleans owned output and staging`, { timeout: 30_000 }, t => {
  const f = fixture(t);
  f.write('desktop/index.tsx', source);
  assert.throws(() => buildCustom(f), error);
  assert.equal(existsSync(join(f.directory, 'browser')), false);
  assert.deepEqual(readdirSync(f.directory), ['source']);
});

test('nonempty dependency/workspace declarations and external references are refused; scripts/config never run', { timeout: 60_000 }, t => {
  const f = fixture(t), packagePath = join(f.repo, 'package.json');
  const input = JSON.parse(readFileSync(packagePath));
  for (const [name, value] of [['workspaces', ['packages/*']], ['imports', { '#escape': './escape.js' }]]) {
    f.write('package.json', JSON.stringify({ ...input, [name]: value }));
    assert.throws(() => buildCustom(f), new RegExp(name));
  }
  f.write('package.json', JSON.stringify({ ...input, dependencies: { x: '1.0.0' } }));
  assert.throws(() => buildCustom(f), /lockfile|dependencies|plain object/);
  f.write('package.json', JSON.stringify({ ...input, agentui: { ...input.agentui,
    extensions: [{ repository: '/tmp/external', commit: 'a'.repeat(40) }] } }));
  assert.throws(() => buildCustom(f), /External customization/);
  f.write('package.json', JSON.stringify({ ...input, scripts: { build: 'exit 72', prepare: 'exit 72' } }));
  f.write('vite.config.js', "throw new Error('REPOSITORY CONFIG EXECUTED')");
  f.write('tsconfig.json', JSON.stringify({ compilerOptions: { jsxImportSource: 'bad-jsx-package', paths: { react: ['bad.js'] } } }));
  buildCustom(f);
  assert.ok(readArtifactBytes(join(f.directory, 'browser'), 'browser-development'));
});

test('no desktop entry uses the ordinary app and an existing nonempty directory stays untouched', { timeout: 30_000 }, t => {
  const f = fixture(t);
  const input = JSON.parse(readFileSync(join(f.repo, 'package.json')));
  input.agentui.extension.entries[0].kind = 'ios';
  f.write('package.json', JSON.stringify(input));
  const commit = f.commit();
  buildCustom(f, commit);
  const identity = JSON.parse(readFileSync(join(f.directory, 'browser/customization-identity.json')));
  assert.equal(identity.namespace, null);
  const existing = join(f.directory, 'existing');
  mkdirSync(existing);
  writeFileSync(join(existing, 'sentinel'), 'keep');
  assert.throws(() => buildCustom(f, commit, existing), /EEXIST/);
  assert.equal(readFileSync(join(existing, 'sentinel'), 'utf8'), 'keep');
});


test('empty and unrelated repositories build the default app', { timeout: 30_000 }, t => {
  const f = fixture(t);
  f.write('package.json', JSON.stringify({ name: 'unrelated', dependencies: { unused: '1.0.0' } }));
  buildCustom(f, f.commit(), join(f.directory, 'unrelated'));
  for (const name of readdirSync(f.repo)) if (name !== '.git') rmSync(join(f.repo, name), { recursive: true, force: true });
  buildCustom(f, f.commit());
  for (const name of ['browser', 'unrelated']) {
    const identity = JSON.parse(readFileSync(join(f.directory, name, 'customization-identity.json')));
    assert.equal(identity.namespace, null);
    assert.ok(readArtifactBytes(join(f.directory, name), 'browser-development').files.has('browser.html'));
  }
});
