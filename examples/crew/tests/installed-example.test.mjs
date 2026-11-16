import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('installed Crew and example share the patched Zod runtime', () => {
  const exampleRequire = createRequire(new URL('../package.json', import.meta.url));
  const crewRequire = createRequire(exampleRequire.resolve('@birbcrew/client'));
  assert.equal(exampleRequire('zod/package.json').version, '4.6.6');
  assert.equal(crewRequire('zod/package.json').version, '4.6.6');
  assert.equal(crewRequire.resolve('zod'), exampleRequire.resolve('zod'));
});

test('packed Crew example imports all exports with the retained SDK archive', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-crew-consumer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const env = { ...process.env, npm_config_cache: join(directory, 'cache') };
  const archives = ['packages/contracts', 'packages/protocol', 'packages/sdk', 'examples/crew'].map(path => {
    const [packed] = JSON.parse(execFileSync('npm', ['pack', `./${path}`, '--pack-destination', directory, '--json', '--ignore-scripts'], { cwd: root, env, encoding: 'utf8' }));
    if (path === 'examples/crew') {
      const paths = packed.files.map(file => file.path);
      for (const name of ['index', 'file-intents', 'provider']) {
        assert.ok(paths.includes(`dist/${name}.js`), `packed ${name} runtime`);
        assert.ok(paths.includes(`dist/${name}.d.ts`), `packed ${name} declarations`);
      }
    }
    return join(directory, packed.filename);
  });
  const examplePackage = new URL('../package.json', import.meta.url);
  const example = JSON.parse(readFileSync(examplePackage, 'utf8'));
  const sdk = fileURLToPath(new URL(example.dependencies['@birbcrew/client'].slice('file:'.length), examplePackage));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const dependencies = ['zod', 'react', '@cfworker/json-schema', '@types/uuid', 'compare-versions', 'fast-json-patch',
    'rxjs', 'tslib', 'untruncate-json', 'uuid', '@bufbuild/protobuf', '@protobuf-ts/protoc'];
  const packedDependencies = JSON.parse(execFileSync('npm', ['pack', ...dependencies.map(name => join(root, 'node_modules', name)),
    '--pack-destination', directory, '--json', '--ignore-scripts'], { cwd: root, env, encoding: 'utf8' }));
  const local = Object.fromEntries(packedDependencies.map(packed => {
    assert.equal(packed.version, lock.packages[`node_modules/${packed.name}`].version);
    return [packed.name, `file:${join(directory, packed.filename)}`];
  }));
  const peers = Object.fromEntries(['client', 'core', 'encoder', 'proto'].map(name => [`@ag-ui/${name}`,
    `file:${join(root, 'vendor/ag-ui/ed2c1d5b63299d3f08676a1418cc2640bbe55fd1', `ag-ui-${name}-1.0.4.tgz`)}`]));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: { ...peers, ...local, '@birbcrew/client': `file:${sdk}` },
    overrides: { ...Object.fromEntries([...Object.keys(peers), ...Object.keys(local)].map(name => [name, `$${name}`])), '@birbcrew/client': '$@birbcrew/client' } }));
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', ...archives], { cwd: directory, env, stdio: 'pipe' });
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { join } from 'node:path';
    import { connectCrewConversation } from '@agentui/example-crew';
    import { fileIntents } from '@agentui/example-crew/file-intents';
    import { crewProvider } from '@agentui/example-crew/provider';
    import { CrewClient } from '@birbcrew/client';
    assert.equal(typeof connectCrewConversation, 'function');
    assert.equal(typeof fileIntents, 'function');
    assert.equal(typeof crewProvider, 'function');
    assert.equal(typeof CrewClient, 'function');
    assert.equal(typeof CrewClient.prototype.listGrants, 'function');
    assert.equal(typeof CrewClient.prototype.revokeGrant, 'function');
    const consumerRequire = createRequire(join(process.cwd(), 'package.json'));
    const exampleRequire = createRequire(consumerRequire.resolve('@agentui/example-crew'));
    const crewRequire = createRequire(exampleRequire.resolve('@birbcrew/client'));
    assert.equal(exampleRequire('zod/package.json').version, '4.6.6');
    assert.equal(crewRequire('zod/package.json').version, '4.6.6');
    assert.equal(crewRequire.resolve('zod'), exampleRequire.resolve('zod'));
  `], { cwd: directory, stdio: 'pipe' });
});
