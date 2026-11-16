import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, posix } from 'node:path';
import { readArtifactBytes } from '../../../apps/host/build/tsc/artifact.js';
import { repository, buildCustom } from './support.mjs';
import { desktopPlan } from '../../../scripts/local-customization.mjs';

function fixture(t) {
  const value = repository();
  t.after(() => rmSync(value.directory, { recursive: true, force: true }));
  return value;
}
test('catalog sources have locale-independent code-unit order', () => {
  const node = { identity: 'root', commit: 'commit', subdirectory: '', inputs: [], npm: {}, repositoryDirectory: '/tmp/root', directory: '/tmp/root', extensions: [],
    customization: { local: { manifest: { sdkVersion: '0.3.0', namespace: 'example', entries: [] }, sources: new Map([['./z.js', 'z'], ['./t.js', 't'], ['./s.js', 's'], ['./B.js', 'B']]) } } };
  assert.deepEqual(desktopPlan(node).identity.packages[0].local.sources.map(source => source.module), ['./B.js', './s.js', './t.js', './z.js']);
});

test('an ambient installed package outside prepared roots is rejected', { timeout: 30_000 }, t => {
  const f = fixture(t), ambient = join(f.directory, 'node_modules/ambient-example');
  mkdirSync(ambient, { recursive: true });
  writeFileSync(join(ambient, 'package.json'), JSON.stringify({ name: 'ambient-example', main: 'index.js' }));
  writeFileSync(join(ambient, 'index.js'), "export default 'ambient';");
  f.write('desktop/index.tsx', "import 'ambient-example';");
  assert.throws(() => buildCustom(f), /contained customization source|Unsupported customization import/);
  assert.equal(existsSync(join(f.directory, 'browser')), false);
});
test('exact committed TSX/shared source produces a complete verified artifact and refuses overwrite', { timeout: 60_000 }, t => {
  const f = fixture(t), commit = f.commit(), out = join(f.directory, 'browser');
  f.write('shared/prompts.ts', "export const reviewPrompt = 'DIRTY PROMPT MUST NOT APPEAR';");
  f.write('untracked.js', 'UNTRACKED MUST NOT APPEAR');
  buildCustom(f, commit);
  const artifact = readArtifactBytes(out, 'browser-development');
  assert.equal(JSON.parse(readFileSync(join(out, 'customization-identity.json'))).packages[0].commit, commit);
  assert.ok(artifact.files.has('browser.html'));
  assert.ok(artifact.files.has('index.html'));
  function graph(entry, visited = new Set()) {
    if (visited.has(entry)) return '';
    visited.add(entry);
    const code = artifact.files.get(entry).toString();
    return code + [...code.matchAll(/["'`](\.\/[^"'`]+\.js)["'`]/gu)].map(([, specifier]) => {
      const path = posix.join(posix.dirname(entry), specifier);
      return artifact.files.has(path) ? graph(path, visited) : '';
    }).join('\n');
  }
  for (const entry of ['index.html', 'browser.html']) {
    assert.ok(graph(entry).includes('Review our current plan'), `${entry} must reach the committed module`);
  }
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

test('symlinked output parent builds committed JSX with the installed ABI and ignores repository JSX config', { timeout: 30_000 }, t => {
  const f = fixture(t), linked = join(f.directory, 'linked');
  symlinkSync(f.directory, linked, 'dir');
  f.write('desktop/index.tsx', `import { useState } from 'react';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { UiExtensionEntry } from '@agentui/sdk/react';
import { Surface } from '@agentui/ui-primitives/desktop';
import { reviewPrompt } from '../shared/prompts.js';
function Plan() { const [prompt] = useState(reviewPrompt); return <Surface>Committed JSX {prompt}</Surface>; }
export default { kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION,
  activate() { return { modules: [{ id: 'plan-review', label: 'Plan review', component: Plan }], dispose() {} }; }
} satisfies UiExtensionEntry<'desktop'>;`);
  f.write('tsconfig.json', JSON.stringify({ compilerOptions: { jsxImportSource: 'bad-jsx-package' } }));
  buildCustom(f, f.commit(), join(linked, 'browser'));
  const artifact = readArtifactBytes(join(linked, 'browser'), 'browser-development');
  const js = [...artifact.files].filter(([path]) => path.endsWith('.js')).map(([, bytes]) => bytes.toString()).join('\n');
  assert.match(js, /Committed JSX/);
  assert.match(js, /Review our current plan/);
  assert.doesNotMatch(js, /bad-jsx-package/);
  assert.deepEqual(readdirSync(f.directory).sort(), ['browser', 'linked', 'source']);
});

for (const [label, source, error] of [
  ['outside source', "import '../../../../outside.js';", /contained customization source/],
  ['outside raw text', "import value from '../../../../outside.txt?raw'; console.log(value);", /contained customization source/],
  ['undeclared package', "import 'other-package';", /Unsupported customization import/],
]) test(`symlinked output parent rejects ${label} and cleans owned output and staging`, { timeout: 30_000 }, t => {
  const f = fixture(t), linked = join(f.directory, 'linked');
  symlinkSync(f.directory, linked, 'dir');
  writeFileSync(join(f.directory, 'outside.js'), "console.log('BENIGN OUTSIDE SOURCE');");
  writeFileSync(join(f.directory, 'outside.txt'), 'BENIGN OUTSIDE TEXT');
  f.write('desktop/index.tsx', source);
  assert.throws(() => buildCustom(f, f.commit(), join(linked, 'browser')), error);
  assert.equal(existsSync(join(linked, 'browser')), false);
  assert.deepEqual(readdirSync(f.directory).sort(), ['linked', 'outside.js', 'outside.txt', 'source']);
});

const cases = [
  ['parent escape', "import '../../escape.js';", /Unsupported customization import/],
  ['absolute import', "import '/etc/passwd';", /Unsupported customization import/],
  ['bare import', "import 'other-package';", /Unsupported customization import/],
  ['native UI package', "import '@agentui/ui-primitives/native';", /Unsupported customization import/],
  ['UI stylesheet entry', "import '@agentui/ui-primitives/styles.css';", /Unsupported customization import/],
  ['require member', "require.resolve('./value.js');", /requireMember/],
  ['unlisted AgentUI package', "import '@agentui/host';", /Unsupported customization import/],
  ['missing source', "import './missing.js';", /Unsupported customization import/],
  ['computed import', 'import(globalThis.moduleName);', /computed or ambient/],
  ['import meta', 'console.log(import.meta.glob("./*.tsx"));', /computed or ambient/],
  ['require', 'require(globalThis.moduleName);', /computed or ambient/],
  ['ambient reference', '/// <reference path="../../ambient.d.ts" />\nexport default {};', /ambient reference/],
];
for (const [label, source, error] of cases) test(`unsupported ${label} cleans owned output and staging`, { timeout: 30_000 }, t => {
  const f = fixture(t);
  f.write('desktop/index.tsx', source);
  assert.throws(() => buildCustom(f), error);
  assert.equal(existsSync(join(f.directory, 'browser')), false);
  assert.deepEqual(readdirSync(f.directory), ['source']);
});

test('author scripts and compiler configuration do not execute', { timeout: 60_000 }, t => {
  const f = fixture(t), packagePath = join(f.repo, 'package.json');
  const input = JSON.parse(readFileSync(packagePath));
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
  assert.deepEqual(identity.entries, []);
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
    assert.deepEqual(identity.entries, []);
    assert.ok(readArtifactBytes(join(f.directory, name), 'browser-development').files.has('browser.html'));
  }
});

test('builds every committed desktop entry in graph order and changes identity with a descendant', { timeout: 60_000 }, t => {
  const f = fixture(t), child = fixture(t);
  const childPackage = JSON.parse(readFileSync(join(child.repo, 'package.json')));
  childPackage.agentui.extension.namespace = 'child';
  child.write('package.json', JSON.stringify(childPackage));
  const first = child.commit();
  const rootPackage = JSON.parse(readFileSync(join(f.repo, 'package.json')));
  rootPackage.agentui.extensions = [{ repository: child.repo, commit: first }];
  f.write('package.json', JSON.stringify(rootPackage));
  buildCustom(f);
  const artifact = readArtifactBytes(join(f.directory, 'browser'), 'browser-development');
  const identity = JSON.parse(artifact.files.get('customization-identity.json'));
  assert.deepEqual(identity.entries.map(entry => identity.packages.find(pkg => pkg.identity === entry.packageIdentity).local.manifest.namespace), [rootPackage.agentui.extension.namespace, 'child']);
  assert.deepEqual(identity.packages.map(pkg => pkg.commit), [identity.packages[0].commit, first]);
  assert.ok(!JSON.stringify(identity).includes(child.repo));
  child.write('shared/prompts.ts', "export const reviewPrompt = 'Child updated';");
  rootPackage.agentui.extensions[0].commit = child.commit();
  f.write('package.json', JSON.stringify(rootPackage));
  buildCustom(f, f.commit(), join(f.directory, 'updated'));
  const updated = readArtifactBytes(join(f.directory, 'updated'), 'browser-development');
  assert.notEqual(updated.manifest.artifactId, artifact.manifest.artifactId);
  assert.match([...updated.files.values()].map(bytes => bytes.toString()).join('\n'), /Child updated/);
});

for (const [name, source] of [
  ['missing default', 'export const value = 1;'],
  ['wrong kind', "export default { kind: 'server', sdkVersion: '0.3.0', activate() {} };"],
  ['wrong SDK', "export default { kind: 'desktop', sdkVersion: 'wrong', activate() {} };"],
  ['import exception', "throw new Error('entry failed'); export default {};"],
]) test(`browser qualification rejects ${name} without publishing`, { timeout: 30_000 }, t => {
  const f = fixture(t);
  f.write('desktop/index.tsx', source);
  assert.throws(() => buildCustom(f));
  assert.equal(existsSync(join(f.directory, 'browser')), false);
  assert.deepEqual(readdirSync(f.directory), ['source']);
});

test('normal Vite raw assets remain available to prepared modules', { timeout: 30_000 }, t => {
  const f = fixture(t);
  f.write('desktop/index.tsx', `import prompt from '../shared/prompts.ts?raw';
    export default { kind: 'desktop', sdkVersion: '0.3.0', activate() { return { modules: [], dispose() {}, prompt }; } };`);
  buildCustom(f);
  const artifact = readArtifactBytes(join(f.directory, 'browser'), 'browser-development');
  assert.match([...artifact.files.values()].map(bytes => bytes.toString()).join('\n'), /Review our current plan/);
});

test('literal dynamic imports and CSS URLs build from contained sources', { timeout: 30_000 }, t => {
  const f = fixture(t);
  f.write('desktop/lazy.js', "export default 'lazy loaded marker';");
  f.write('desktop/style.css', 'body { color: rgb(1, 2, 3); }');
  f.write('desktop/index.tsx', `import style from './style.css?url';
    const lazy = () => import('./lazy.js');
    if (new URL(style).pathname.endsWith('.css') === false) throw new Error('asset failed');
    export default { kind: 'desktop', sdkVersion: '0.3.0', async activate() {
      const loaded = await lazy();
      const response = await fetch(style);
      if (loaded.default !== 'lazy loaded marker' || !response.ok || !(await response.text()).includes('#010203')) throw new Error('asset loading failed');
      return { modules: [], dispose() {} };
    } };`);
  buildCustom(f);
  const artifact = readArtifactBytes(join(f.directory, 'browser'), 'browser-development');
  assert.match([...artifact.files.values()].map(bytes => bytes.toString()).join('\n'), /lazy loaded marker/);
  assert.ok([...artifact.files.keys()].some(path => /assets\/style-.*\.css$/u.test(path)));
});

test('equal child trees compile once while each pinned commit remains in provenance', { timeout: 30_000 }, t => {
  const f = fixture(t), child = fixture(t);
  const childPackage = JSON.parse(readFileSync(join(child.repo, 'package.json')));
  childPackage.agentui.extension.namespace = 'child';
  child.write('package.json', JSON.stringify(childPackage));
  const first = child.commit(), second = child.commit();
  const rootPackage = JSON.parse(readFileSync(join(f.repo, 'package.json')));
  rootPackage.agentui.extensions = [first, second].map(commit => ({ repository: child.repo, commit }));
  f.write('package.json', JSON.stringify(rootPackage));
  buildCustom(f);
  const artifact = readArtifactBytes(join(f.directory, 'browser'), 'browser-development');
  const identity = JSON.parse(artifact.files.get('customization-identity.json'));
  assert.equal(identity.entries.length, 2);
  assert.equal(identity.packages.length, 2);
  assert.deepEqual(identity.packages[0].extensions.map(edge => edge.commit), [first, second]);
  assert.equal(identity.packages[0].extensions[0].packageIdentity, identity.packages[0].extensions[1].packageIdentity);
});
