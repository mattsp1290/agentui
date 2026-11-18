import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extensionArguments } from '../../scripts/agentui-launch.mjs';

const configuration = { version: 2, ownership: 'transient', extensions: [
  { directory: '/repo/extensions/one', installations: [{ id: 'a', authentication: { kind: 'environment', variable: 'AGENTUI_EXTENSION_ONE_TOKEN', revision: '1' } }] },
  { directory: '/repo/extensions/two', installations: [{ id: 'b', authentication: { kind: 'environment', variable: 'AGENTUI_EXTENSION_TWO_TOKEN', revision: '1' } },
    { id: 'c', authentication: { kind: 'unauthenticated' } }] }] };

async function root(t, contents) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-launch-extensions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  if (contents !== undefined) await writeFile(join(directory, 'extensions.json'), typeof contents === 'string' ? contents : JSON.stringify(contents));
  return directory;
}
/** The shared configuration with its two extension directories created under the setup root. */
async function installed(t) {
  const directory = await root(t);
  const extensions = [];
  for (const [index, extension] of configuration.extensions.entries()) {
    const path = join(directory, `extension-${index}`);
    await mkdir(path);
    await writeFile(join(path, 'package.json'), '{}');
    extensions.push({ ...extension, directory: index === 0 ? path : `./extension-${index}` });
  }
  await writeFile(join(directory, 'extensions.json'), JSON.stringify({ ...configuration, extensions }));
  return directory;
}
function run(setupRoot, kind, env) {
  const lines = [];
  return { args: extensionArguments({ setupRoot, kind, env, warn: line => lines.push(line) }), lines };
}

test('no extensions.json passes nothing and prints nothing', async t => {
  assert.deepEqual(run(await root(t), 'local', {}), { args: [], lines: [] });
});

test('a file whose every token variable is set passes --extensions without printing values', async t => {
  const directory = await installed(t);
  const env = { AGENTUI_EXTENSION_ONE_TOKEN: 'secret-one', AGENTUI_EXTENSION_TWO_TOKEN: 'secret-two' };
  assert.deepEqual(run(directory, 'local', env), { args: ['--extensions', join(directory, 'extensions.json')], lines: [] });
});

test('a missing or blank variable starts without extensions and names only the variables', async t => {
  const directory = await installed(t);
  const result = run(directory, 'local', { AGENTUI_EXTENSION_ONE_TOKEN: 'secret-one', AGENTUI_EXTENSION_TWO_TOKEN: '  ' });
  assert.deepEqual(result.args, []);
  assert.deepEqual(result.lines, ['Set AGENTUI_EXTENSION_TWO_TOKEN to load server extensions. Starting without server extensions.']);
  assert.equal(result.lines.join('\n').includes('secret-one'), false);
  assert.deepEqual(run(directory, 'local', {}).lines, ['Set AGENTUI_EXTENSION_ONE_TOKEN, AGENTUI_EXTENSION_TWO_TOKEN to load server extensions. Starting without server extensions.']);
  assert.deepEqual(run(await root(t, '{not json'), 'local', {}).lines, ['extensions.json is not valid JSON. Starting without server extensions.']);
});

test('a remote profile ignores extensions.json and says so once', async t => {
  const directory = await root(t, configuration);
  const env = { AGENTUI_EXTENSION_ONE_TOKEN: 'x', AGENTUI_EXTENSION_TWO_TOKEN: 'y' };
  assert.deepEqual(run(directory, 'ssh', env), { args: [], lines: ['Server extensions run only with a local host. Ignoring extensions.json for this remote session.'] });
  assert.deepEqual(run(await root(t), 'ssh', env), { args: [], lines: [] });
});

test('a configuration the host would refuse starts without extensions and says so once', async t => {
  const env = { AGENTUI_EXTENSION_ONE_TOKEN: 'secret-one', AGENTUI_EXTENSION_TWO_TOKEN: 'secret-two' };
  const unusable = ['extensions.json is not a usable extension configuration (version 2 with existing extension directories). Starting without server extensions.'];
  // The shared configuration names directories that do not exist.
  assert.deepEqual(run(await root(t, configuration), 'local', env), { args: [], lines: unusable });
  assert.deepEqual(run(await root(t, { ...configuration, version: 1 }), 'local', env), { args: [], lines: unusable });
  assert.deepEqual(run(await root(t, { version: 2, ownership: 'transient' }), 'local', env), { args: [], lines: unusable });
  assert.deepEqual(run(await root(t, []), 'local', env), { args: [], lines: unusable });
  // A directory without package.json is an artifact directory only when the entry says so.
  const directory = await root(t);
  await mkdir(join(directory, 'built'));
  await writeFile(join(directory, 'extensions.json'), JSON.stringify({ version: 2, ownership: 'transient', extensions: [{ directory: './built', installations: [] }] }));
  assert.deepEqual(run(directory, 'local', env), { args: [], lines: unusable });
  await writeFile(join(directory, 'extensions.json'), JSON.stringify({ version: 2, ownership: 'transient', extensions: [{ kind: 'artifact', directory: './built', artifactId: 'a'.repeat(64), installations: [] }] }));
  assert.deepEqual(run(directory, 'local', env), { args: ['--extensions', join(directory, 'extensions.json')], lines: [] });
  // An empty selection is valid.
  assert.deepEqual(run(await root(t, { version: 2, ownership: 'transient', extensions: [] }), 'local', env).args.length, 2);
});
