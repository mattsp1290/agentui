import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setReferenceEnabled } from '../../scripts/lib/customization-git.mjs';
import { openStore, processStartTime } from '../../scripts/lib/customization-store.mjs';
import { exampleConnection, world } from '../support/customization-worker-support.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('connect clones the branch and reports both references with namespaces and the settings', async t => {
  const w = await world(t);
  w.startWorker();
  await w.online();
  assert.equal(await w.mutate('connect', exampleConnection(w.remote)), 'ok');
  const status = await w.status();
  assert.deepEqual(status.connection, exampleConnection(w.remote));
  assert.equal(status.head, w.remoteLog()[0].split(' ')[0]);
  assert.deepEqual(status.extensions, [{ key: 'extensions/crew', enabled: true, namespace: 'crew' }, { key: 'extensions/coworkers', enabled: true, namespace: 'coworkers' }]);
  assert.deepEqual(status.settings, { version: 1, appearance: 'system', showExtensionViews: true });
  assert.ok(existsSync(join(w.setupRoot, 'customization/clone/.git')));
  assert.deepEqual(JSON.parse(await readFile(join(w.setupRoot, 'customization/connection.json'), 'utf8')), { version: 1, ...exampleConnection(w.remote) });
  assert.equal((await w.mutate('disconnect')), 'ok');
  assert.equal((await w.status()).connection, null);
  assert.equal(existsSync(join(w.setupRoot, 'customization/clone')), false);
});

test('an invalid package leaves no clone, and relative or credential-bearing locations are refused', async t => {
  const w = await world(t, { files: { 'examples/customization/package.json': '{"agentui":{"extensions":[{"repository":"/x"}]}}' } });
  w.startWorker();
  await w.online();
  assert.equal(await w.mutate('connect', exampleConnection(w.remote)), 'invalid-package');
  assert.equal(existsSync(join(w.setupRoot, 'customization/clone')), false);
  assert.equal((await w.status()).connection, null);
  for (const location of ['relative/remote.git', 'https://user:secret@example.invalid/repo.git']) {
    assert.equal(await w.mutate('connect', { ...exampleConnection(w.remote), location }), 'invalid-location', location);
  }
  assert.equal(await w.mutate('connect', { ...exampleConnection(w.remote), branch: 'bad..branch' }), 'invalid-location');
  assert.equal(await w.mutate('connect', { ...exampleConnection(w.remote), subdirectory: '../escape' }), 'invalid-location');
  assert.equal(await w.mutate('connect', { ...exampleConnection(w.remote), branch: 'missing' }), 'clone-failed');
});

test('a toggle makes one commit that changes only the enabled value, and stale or no-op toggles push nothing', async t => {
  const w = await world(t);
  w.startWorker();
  await w.online();
  await w.mutate('connect', exampleConnection(w.remote));
  const before = w.remoteLog();
  const { head } = await w.status();
  assert.equal(await w.mutate('toggle', { key: 'extensions/coworkers', enabled: false, expectedHead: 'f'.repeat(40) }), 'conflict');
  assert.equal(await w.mutate('toggle', { key: 'extensions/crew', enabled: true, expectedHead: head }), 'unchanged');
  assert.equal(await w.mutate('toggle', { key: 'extensions/missing', enabled: false, expectedHead: head }), 'unknown-extension');
  assert.deepEqual(w.remoteLog(), before);
  assert.equal(await w.mutate('toggle', { key: 'extensions/coworkers', enabled: false, expectedHead: head }), 'ok');
  const after = w.remoteLog();
  assert.equal(after.length, before.length + 1);
  assert.match(after[0], / Disable extensions\/coworkers extension$/u);
  const diff = w.git(w.remote, 'diff', '--unified=0', `${before[0].split(' ')[0]}`, 'customization');
  assert.deepEqual(diff.split('\n').filter(line => /^[+-](?![+-])/u.test(line)),
    ['-      { "subdirectory": "extensions/coworkers", "enabled": true }', '+      { "subdirectory": "extensions/coworkers", "enabled": false }']);
  assert.equal(w.git(w.remote, 'log', '-1', '--format=%b', 'customization'), 'Changed by AgentUI.');
  const status = await w.status();
  assert.equal(status.head, after[0].split(' ')[0]);
  assert.deepEqual(status.extensions.map(item => item.enabled), [true, false]);
});

test('the in-place edit handles common layouts and refuses what it cannot change safely', () => {
  const reference = { subdirectory: 'extensions/a' };
  const pkg = enabled => ({ name: 'x', agentui: { extensions: [{ ...reference, ...(enabled === undefined ? {} : { enabled }) }, { subdirectory: 'extensions/b', enabled: true }] } });
  for (const [label, text] of [['two spaces', JSON.stringify(pkg(true), null, 2)], ['four spaces', JSON.stringify(pkg(true), null, 4)],
    ['tabs', JSON.stringify(pkg(true), null, '\t')], ['minified', JSON.stringify(pkg(true))]]) {
    const edit = setReferenceEnabled(text, 0, false);
    assert.equal(edit.kind, 'changed', label);
    assert.equal(edit.text, text.replace('"enabled": true', '"enabled": false').replace('"enabled":true', '"enabled":false'), label);
    assert.deepEqual(setReferenceEnabled(text, 0, true), { kind: 'unchanged' }, label);
  }
  const missing = JSON.stringify(pkg(undefined), null, 2);
  const inserted = setReferenceEnabled(missing, 0, false);
  assert.equal(inserted.kind, 'changed');
  assert.deepEqual(JSON.parse(inserted.text), pkg(false));
  assert.equal(inserted.text.replace(', "enabled": false', ''), missing);
  assert.deepEqual(setReferenceEnabled(missing, 0, true), { kind: 'unchanged' });
  for (const text of ['{"agentui":{"extensions":[{"subdirectory":"a","enabled":"yes"}]}}', '{"agentui":{"extensions":[{"subdirectory":"a","enabled":true,"enabled":true}]}}',
    '{"agentui":{"extensions":[["a"]]}}', '{"agentui":{"extensions":[]}}', 'not json', '{"agentui":{},"agentui":{"extensions":[{"subdirectory":"a"}]}}']) {
    assert.deepEqual(setReferenceEnabled(text, 0, false), { kind: 'unsupported' }, text);
  }
});

test('a file the editor cannot change safely returns unsupported-format and creates no commit', async t => {
  const w = await world(t, { files: { 'examples/customization/package.json': '{"agentui":{"extensions":[{"subdirectory":"extensions/crew","enabled":true,"enabled":true}]}}',
    'extensions/crew/package.json': '{}' } });
  w.startWorker();
  await w.online();
  assert.equal(await w.mutate('connect', exampleConnection(w.remote)), 'ok');
  const before = w.remoteLog();
  assert.equal(await w.mutate('toggle', { key: 'extensions/crew', enabled: false, expectedHead: (await w.status()).head }), 'unsupported-format');
  assert.deepEqual(w.remoteLog(), before);
});

test('a rejected push returns push-rejected and leaves the clone equal to the remote', async t => {
  const w = await world(t);
  w.startWorker();
  await w.online();
  await w.mutate('connect', exampleConnection(w.remote));
  await writeFile(join(w.remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const { head } = await w.status();
  assert.equal(await w.mutate('toggle', { key: 'extensions/crew', enabled: false, expectedHead: head }), 'push-rejected');
  const clone = join(w.setupRoot, 'customization/clone');
  assert.equal(w.git(clone, 'rev-parse', 'HEAD'), w.git(w.remote, 'rev-parse', 'customization'));
  assert.equal(w.git(clone, 'status', '--porcelain'), '');
  assert.equal((await w.status()).head, head);
  assert.ok(existsSync(join(w.setupRoot, 'customization/git.log')));
});

test('a commit without a configured identity returns identity-missing, and a global hooks path never runs', async t => {
  const w = await world(t);
  const hooks = join(w.root, 'hooks');
  await mkdir(hooks);
  await writeFile(join(hooks, 'pre-commit'), `#!/bin/sh\ntouch ${JSON.stringify(join(w.root, 'hook-ran'))}\nexit 1\n`, { mode: 0o755 });
  await writeFile(w.gitconfig, `${await readFile(w.gitconfig, 'utf8')}[core]\n\thooksPath = ${hooks}\n`);
  let worker = w.startWorker();
  await w.online();
  await w.mutate('connect', exampleConnection(w.remote));
  assert.equal(await w.mutate('toggle', { key: 'extensions/crew', enabled: false, expectedHead: (await w.status()).head }), 'ok');
  assert.equal(existsSync(join(w.root, 'hook-ran')), false);
  await worker.stop();
  // No identity anywhere: an empty HOME, no system or global configuration and no identity variables.
  const empty = join(w.root, 'empty-home');
  await mkdir(empty);
  const environment = { ...w.gitEnvironment, HOME: empty, GIT_CONFIG_GLOBAL: '/dev/null' };
  for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete environment[name];
  worker = w.startWorker({ gitEnvironment: environment });
  await w.online();
  const before = w.remoteLog();
  assert.equal(await w.mutate('toggle', { key: 'extensions/coworkers', enabled: false, expectedHead: (await w.status()).head }), 'identity-missing');
  assert.deepEqual(w.remoteLog(), before);
});

test('a settings request writes the file byte-stably, commits, pushes and starts no build', async t => {
  const w = await world(t);
  const starts = [];
  w.startWorker({ builds: { start: request => starts.push(request), status: () => null } });
  await w.online();
  await w.mutate('connect', exampleConnection(w.remote));
  assert.equal(starts.length, 1, 'connect starts a build');
  const settings = { version: 1, appearance: 'dark', showExtensionViews: true, defaultAgent: { kind: 'native', harness: 'codex' } };
  assert.equal(await w.mutate('settings', { settings, expectedHead: (await w.status()).head }), 'ok');
  assert.match(w.remoteLog()[0], / Update AgentUI settings$/u);
  assert.equal(w.remoteFile('examples/customization/agentui-settings.json') + '\n',
    '{\n  "version": 1,\n  "appearance": "dark",\n  "showExtensionViews": true,\n  "defaultAgent": {\n    "kind": "native",\n    "harness": "codex"\n  }\n}\n');
  assert.deepEqual((await w.status()).settings, settings);
  assert.equal(await w.mutate('settings', { settings, expectedHead: (await w.status()).head }), 'unchanged');
  assert.equal(starts.length, 1, 'settings start no build');
  assert.equal(await w.mutate('toggle', { key: 'extensions/crew', enabled: false, expectedHead: (await w.status()).head }), 'ok');
  assert.equal(starts.length, 2, 'a toggle starts a build');
});

test('two live workers share one store: the second waits, then reports busy, without disturbing the first', async t => {
  const w = await world(t);
  w.startWorker();
  await w.online();
  await w.mutate('connect', exampleConnection(w.remote));
  // A live lock owner: this process, as another session.
  const store = openStore(w.setupRoot);
  const release = await store.lock({ sessionId: 'other-session' });
  try {
    const started = Date.now();
    assert.equal(await w.mutate('sync', {}, 60_000), 'busy');
    assert.ok(Date.now() - started >= 29_000);
    assert.equal((await store.readOwner()).sessionId, 'other-session');
  } finally { await release(); }
  assert.equal(await w.mutate('sync'), 'ok');
});

test('a lock left by a killed worker is taken over; a lock with a live owner never is', async t => {
  const w = await world(t);
  const store = openStore(w.setupRoot);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise(resolve => child.once('spawn', resolve));
  await mkdir(store.paths.lock);
  await writeFile(join(store.paths.lock, 'owner.json'), JSON.stringify({ pid: child.pid, processStartTime: processStartTime(child.pid), hostname: hostname(), sessionId: 'dead', heartbeatAt: Date.now() }));
  await assert.rejects(store.lock({ sessionId: 'live-check', waitMs: 1_000 }), 'a live owner keeps its lock');
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  const release = await store.lock({ sessionId: 'takeover', waitMs: 5_000 });
  assert.equal((await store.readOwner()).sessionId, 'takeover');
  await release();
  assert.equal(existsSync(store.paths.lock), false);
});

test('a git command slowed to 40 seconds does not make the host report worker-offline', { timeout: 120_000 }, async t => {
  const w = await world(t);
  const bin = join(w.root, 'bin');
  await mkdir(bin);
  const realGit = (await import('node:child_process')).execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  await writeFile(join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = fetch ]; then sleep 40; fi; done\nexec ${JSON.stringify(realGit)} "$@"\n`);
  await chmod(join(bin, 'git'), 0o755);
  w.startWorker({ gitEnvironment: { ...w.gitEnvironment, PATH: `${bin}:${process.env.PATH}` } });
  await w.online();
  await w.mutate('connect', exampleConnection(w.remote));
  const outcome = w.mutate('sync', {}, 100_000);
  const offline = [];
  const watcher = setInterval(async () => { if ((await w.status()).support !== 'supported') offline.push(Date.now()); }, 1_000);
  try { assert.equal(await outcome, 'ok'); } finally { clearInterval(watcher); }
  assert.deepEqual(offline, []);
});

test('aborting the worker mid-request leaves no child process and no held lock', { timeout: 60_000 }, async t => {
  const w = await world(t);
  const bin = join(w.root, 'bin');
  await mkdir(bin);
  const realGit = (await import('node:child_process')).execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  await writeFile(join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = fetch ]; then sleep 30; fi; done\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
  const worker = w.startWorker({ gitEnvironment: { ...w.gitEnvironment, PATH: `${bin}:${process.env.PATH}` } });
  await w.online();
  await w.mutate('connect', exampleConnection(w.remote));
  await w.call({ op: 'customization-sync', requestId: crypto.randomUUID() });
  const child = await w.until(() => [...worker.children][0], 'running git child');
  await w.until(() => existsSync(join(w.setupRoot, 'customization/lock')), 'held lock');
  await worker.stop();
  assert.equal(alive(child.pid), false);
  assert.equal(worker.children.size, 0);
  assert.equal(existsSync(join(w.setupRoot, 'customization/lock')), false);
});

test('no status or result carries git output or a path other than the connection location', async t => {
  const w = await world(t);
  w.startWorker({ environment: { AGENTUI_EXTENSION_CREW_TOKEN: 'PRIVATE_TOKEN_VALUE', AGENTUI_EXTENSION_BLANK: ' ', HOME: '/nowhere' } });
  await w.online();
  await w.mutate('connect', { ...exampleConnection(w.remote), branch: 'missing' });
  await w.mutate('connect', exampleConnection(w.remote));
  await writeFile(join(w.remote, 'hooks/pre-receive'), '#!/bin/sh\necho REMOTE_HOOK_OUTPUT >&2\nexit 1\n', { mode: 0o755 });
  await w.mutate('toggle', { key: 'extensions/crew', enabled: false, expectedHead: (await w.status()).head });
  const pushed = await w.until(async () => {
    const response = await w.call({ op: 'customization-status' });
    return response.results.length >= 3 ? response : null;
  }, 'three results');
  const text = JSON.stringify(pushed);
  for (const forbidden of ['REMOTE_HOOK_OUTPUT', 'fatal', 'error:', 'PRIVATE_TOKEN_VALUE', w.setupRoot, w.home]) assert.equal(text.includes(forbidden), false, forbidden);
  assert.deepEqual(pushed.extensions.length, 2);
  assert.ok(text.includes(w.remote), 'the connection location is the one path reported');
});
