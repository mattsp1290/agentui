import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readServerCustomizationArtifact } from '@agentui/host/customization';
import { createBuildManager } from '../../scripts/lib/customization-builds.mjs';
import { openStore, processStartTime } from '../../scripts/lib/customization-store.mjs';
import { customizationFixtureFiles, fixtureConnection } from '../support/customization-fixture.mjs';
import { checkout, world } from '../support/customization-worker-support.mjs';
import { committedTreeRepository, networkTests } from '../support/committed-tree.mjs';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const identity = (hostArtifactId = 'a'.repeat(64)) => ({ hostArtifactId, abiIdentity: 'b'.repeat(64), sdkVersion: '0.14.0', wireVersion: 17 });
const final = state => ['ready', 'failed', 'cancelled'].includes(state);

/** A stub builder: reports phases, records its PID, then sleeps or exits as told by `mode`. */
async function stubBuilder(w, mode) {
  const path = join(w.root, `builder-${mode}.mjs`);
  await writeFile(path, `import { writeFileSync, existsSync } from 'node:fs';
const out = process.argv[process.argv.indexOf('--out') + 1];
writeFileSync(${JSON.stringify(join(w.root, 'builder-out-existed'))}, String(existsSync(out + '/desktop') || existsSync(out + '/server')));
writeFileSync(${JSON.stringify(join(w.root, 'builder.pid'))}, String(process.pid));
console.log(JSON.stringify({ phase: 'resolving' }));
console.error('PRIVATE_BUILDER_OUTPUT');
${mode === 'sleep' ? "console.log(JSON.stringify({ phase: 'preparing' })); setInterval(() => {}, 1000);" : ''}
${mode === 'fail' ? "console.log(JSON.stringify({ phase: 'preparing' })); console.log(JSON.stringify({ failure: 'prepare-failed' })); process.exitCode = 1;" : ''}
${mode === 'ok' ? "console.log(JSON.stringify({ result: { desktopArtifactId: 'c'.repeat(64), serverArtifactId: 'd'.repeat(64), namespaces: ['alpha', 'beta'] } }));" : ''}
`);
  return path;
}
async function connected(t, options = {}) {
  const w = await world(t, { files: customizationFixtureFiles(options.files) });
  const worker = w.startWorker({ repositoryRoot: checkout, buildOptions: options.buildOptions ?? {}, environment: options.environment ?? {} });
  await w.online();
  assert.equal(await w.mutate('connect', fixtureConnection(w.remote)), 'ok');
  return { w, worker };
}
const build = async (w, predicate = status => status.build && final(status.build.state), label = 'final build', timeout = 300_000) =>
  (await w.until(async () => { const status = await w.status(); return predicate(status) ? status : null; }, label, timeout)).build;

test('the worker builds the fixture with the real builder, reaches ready, and the host accepts the server artifact', { timeout: 600_000 }, async t => {
  const { w } = await connected(t);
  const result = await build(w);
  assert.equal(result.state, 'ready', JSON.stringify(result));
  assert.deepEqual(result.namespaces, ['alpha', 'beta']);
  assert.deepEqual(result.grantVariables, ['AGENTUI_EXTENSION_ALPHA_TOKEN', 'AGENTUI_EXTENSION_BETA_TOKEN']);
  assert.deepEqual(result.ignoredGrants, []);
  const host = JSON.parse(await readFile(join(checkout, 'apps/host/dist/artifact.json'), 'utf8'));
  assert.equal(result.hostArtifactId, host.artifactId);
  const record = JSON.parse(await readFile(join(w.setupRoot, 'customization/builds', result.buildKey, 'build.json'), 'utf8'));
  assert.match(record.desktopArtifactId, /^[0-9a-f]{64}$/u);
  assert.match(record.serverArtifactId, /^[0-9a-f]{64}$/u);
  assert.deepEqual(record.grants.map(grant => grant.instance.namespace), ['alpha', 'beta']);
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE|secret/iu);
  for (const phase of ['resolve', 'prepare', 'desktop', 'server']) assert.ok(record.phases[phase]?.finishedAt >= record.phases[phase].startedAt, phase);
  const directory = join(w.setupRoot, 'customization/builds', result.buildKey, 'server');
  const manifest = JSON.parse(await readFile(join(directory, 'customization.json'), 'utf8'));
  await readServerCustomizationArtifact({ directory, expected: { artifactId: manifest.artifactId, sdkVersion: manifest.sdkVersion,
    nodeVersion: manifest.runtime.version, nodeModules: manifest.runtime.modules, abiIdentity: manifest.runtime.abiIdentity } });
  assert.ok(existsSync(join(w.setupRoot, 'customization/builds', result.buildKey, 'log.txt')));
  assert.deepEqual(await readdir(join(w.setupRoot, 'customization/scratch')).catch(() => []), []);
  // A settings commit keeps the inputs key and starts no build; the same request again reuses the ready build.
  const settings = { version: 1, appearance: 'dark', showExtensionViews: true };
  assert.equal(await w.mutate('settings', { settings, expectedHead: (await w.status()).head }), 'ok');
  assert.equal(await w.mutate('sync'), 'ok');
  await new Promise(resolve => setTimeout(resolve, 1_500));
  const after = (await w.status()).build;
  assert.deepEqual([after.buildKey, after.state, after.startedAt], [result.buildKey, 'ready', result.startedAt]);
});

test('a toggle changes the inputs key, cancels the running build and starts the new one; an all-disabled package needs no builder', { timeout: 300_000 }, async t => {
  const w = await world(t, { files: customizationFixtureFiles() });
  const sleeper = await stubBuilder(w, 'sleep');
  w.startWorker({ repositoryRoot: checkout, buildOptions: { readIdentity: async () => identity(), chromium: async () => true, script: sleeper } });
  await w.online();
  assert.equal(await w.mutate('connect', fixtureConnection(w.remote)), 'ok');
  const first = await build(w, status => status.build?.state === 'preparing', 'first build running');
  const pid = Number(await readFile(join(w.root, 'builder.pid'), 'utf8'));
  assert.equal(await w.mutate('toggle', { key: 'ext/beta', enabled: false, expectedHead: (await w.status()).head }), 'ok');
  const second = await build(w, status => status.build && status.build.buildKey !== first.buildKey && status.build.state === 'preparing', 'second build running');
  assert.notEqual(second.inputsKey, first.inputsKey);
  await w.until(() => !alive(pid), 'first builder killed');
  const cancelled = JSON.parse(await readFile(join(w.setupRoot, 'customization/builds', first.buildKey, 'build.json'), 'utf8'));
  assert.equal(cancelled.state, 'cancelled');
  assert.deepEqual(second.ignoredGrants, ['beta/personal']);
  await writeFile(join(w.root, 'builder.pid'), '');
  assert.equal(await w.mutate('toggle', { key: 'ext/alpha', enabled: false, expectedHead: (await w.status()).head }), 'ok');
  const empty = await build(w, status => status.build && final(status.build.state) && status.build.buildKey !== second.buildKey, 'all-disabled build');
  assert.deepEqual([empty.state, empty.namespaces], ['ready', []]);
  assert.equal(await readFile(join(w.root, 'builder.pid'), 'utf8'), '', 'no builder ran');
});

test('build keys follow inputs and builder identity; failures map to fixed values without builder output', { timeout: 120_000 }, async t => {
  const w = await world(t, { files: customizationFixtureFiles() });
  const store = openStore(w.setupRoot);
  w.git(w.root, 'clone', '--quiet', '--branch', 'customization', w.remote, store.paths.clone);
  const head = w.git(store.paths.clone, 'rev-parse', 'HEAD');
  const connection = fixtureConnection(w.remote);
  const changes = [];
  let builder = identity();
  const manager = (script, options = {}) => createBuildManager({ store, repositoryRoot: checkout, sessionId: `s-${Math.random()}`, readIdentity: async () => builder,
    chromium: async () => true, script, onChange: () => changes.push(Date.now()), ...options });
  // Failure mapping, and the builders' outputs do not exist before the child starts; the record survives the failure.
  let m = manager(await stubBuilder(w, 'fail'));
  let record = await m.start({ connection, head });
  await w.until(async () => final((await m.current()).state), 'failed build');
  record = m.current();
  assert.deepEqual([record.state, record.failure], ['failed', 'prepare-failed']);
  assert.equal(await readFile(join(w.root, 'builder-out-existed'), 'utf8'), 'false');
  assert.ok(existsSync(join(store.paths.builds, record.buildKey, 'build.json')));
  assert.doesNotMatch(JSON.stringify(m.status()), /PRIVATE_BUILDER_OUTPUT/u);
  assert.match(await readFile(join(store.paths.builds, record.buildKey, 'log.txt'), 'utf8'), /PRIVATE_BUILDER_OUTPUT/u);
  // A ready build is reused; a changed builder identity yields another key and a new build.
  m = manager(await stubBuilder(w, 'ok'));
  const ready = await m.start({ connection, head });
  await w.until(async () => final(m.current().state), 'ready build');
  assert.equal(m.current().state, 'ready');
  assert.equal(m.current().buildKey, ready.buildKey);
  const again = await m.start({ connection, head });
  assert.equal(again.state, 'ready');
  assert.equal(again.startedAt, m.current().startedAt);
  builder = identity('e'.repeat(64));
  const rebuilt = await m.start({ connection, head });
  assert.notEqual(rebuilt.buildKey, ready.buildKey);
  await w.until(async () => final(m.current().state), 'rebuilt');
  // A builder identity that changes during the build yields builder-changed.
  const sleeper = await stubBuilder(w, 'ok');
  let calls = 0;
  m = manager(sleeper, { readIdentity: async () => (++calls > 1 ? identity('f'.repeat(64)) : identity('1'.repeat(64))) });
  await m.start({ connection, head });
  await w.until(async () => final(m.current().state), 'identity change');
  assert.deepEqual([m.current().state, m.current().failure], ['failed', 'builder-changed']);
  // Missing Chromium: toolchain-missing and no child process.
  await writeFile(join(w.root, 'builder.pid'), '');
  builder = identity('2'.repeat(64));
  m = manager(await stubBuilder(w, 'ok'), { chromium: async () => false });
  const missing = await m.start({ connection, head });
  assert.deepEqual([missing.state, missing.failure], ['failed', 'toolchain-missing']);
  assert.equal(await readFile(join(w.root, 'builder.pid'), 'utf8'), '');
});

test('the overall limit kills the builder; abort interrupts it; a dead owner is recovered and a reused process ID is not killed', { timeout: 120_000 }, async t => {
  const w = await world(t, { files: customizationFixtureFiles() });
  const store = openStore(w.setupRoot);
  w.git(w.root, 'clone', '--quiet', '--branch', 'customization', w.remote, store.paths.clone);
  const head = w.git(store.paths.clone, 'rev-parse', 'HEAD');
  const connection = fixtureConnection(w.remote);
  const sleeper = await stubBuilder(w, 'sleep');
  let builder = identity('3'.repeat(64));
  const manager = (options = {}) => createBuildManager({ store, repositoryRoot: checkout, sessionId: options.sessionId ?? `s-${Math.random()}`, readIdentity: async () => builder,
    chromium: async () => true, script: sleeper, ...options });
  let m = manager({ limitMs: 1_500 });
  await m.start({ connection, head });
  await w.until(async () => existsSync(join(w.root, 'builder.pid')) && Number(await readFile(join(w.root, 'builder.pid'), 'utf8')), 'builder pid');
  let pid = Number(await readFile(join(w.root, 'builder.pid'), 'utf8'));
  await w.until(async () => final(m.current().state), 'timeout');
  assert.deepEqual([m.current().state, m.current().failure], ['failed', 'timeout']);
  await w.until(() => !alive(pid), 'killed builder');
  // Abort mid-build leaves no descendant and records interrupted.
  builder = identity('4'.repeat(64));
  await writeFile(join(w.root, 'builder.pid'), '');
  const controller = new AbortController();
  m = manager({ signal: controller.signal });
  await m.start({ connection, head });
  await w.until(async () => Number(await readFile(join(w.root, 'builder.pid'), 'utf8')), 'second builder pid');
  pid = Number(await readFile(join(w.root, 'builder.pid'), 'utf8'));
  controller.abort();
  await w.until(() => !alive(pid), 'aborted builder');
  await w.until(async () => final(JSON.parse(await readFile(join(store.paths.builds, m.current().buildKey, 'build.json'), 'utf8')).state), 'interrupted record');
  assert.equal(JSON.parse(await readFile(join(store.paths.builds, m.current().buildKey, 'build.json'), 'utf8')).failure, 'interrupted');
  // A live orphan whose owning worker is dead is killed and marked interrupted; a reused process ID is left alone.
  const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  t.after(() => { for (const child of [orphan, bystander]) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } } });
  await Promise.all([orphan, bystander].map(child => new Promise(resolve => child.once('spawn', resolve))));
  const deadOwner = { sessionId: 'dead', pid: 999_999, processStartTime: 'never', hostname: hostname() };
  const records = [['5'.repeat(64), { pgid: orphan.pid, startTime: processStartTime(orphan.pid) }], ['6'.repeat(64), { pgid: bystander.pid, startTime: 'Thu Jan  1 00:00:00 1970' }]];
  for (const [key, child] of records) {
    await mkdir(join(store.paths.builds, key), { recursive: true });
    await writeFile(join(store.paths.builds, key, 'build.json'), JSON.stringify({ version: 1, buildKey: key, inputsKey: key, commit: head, state: 'preparing', startedAt: Date.now(), phases: {}, namespaces: [], grants: [], ignoredGrants: [], owner: deadOwner, child }));
  }
  // A record owned by a live worker in another session is left alone.
  const liveKey = '7'.repeat(64);
  await mkdir(join(store.paths.builds, liveKey), { recursive: true });
  await writeFile(join(store.paths.builds, liveKey, 'build.json'), JSON.stringify({ version: 1, buildKey: liveKey, inputsKey: liveKey, commit: head, state: 'preparing', startedAt: Date.now(), phases: {}, namespaces: [], grants: [], ignoredGrants: [],
    owner: { sessionId: 'live', pid: process.pid, processStartTime: processStartTime(process.pid), hostname: hostname() } }));
  await manager().recover();
  const read = async key => JSON.parse(await readFile(join(store.paths.builds, key, 'build.json'), 'utf8'));
  await w.until(() => !alive(orphan.pid), 'orphan killed');
  assert.equal((await read(records[0][0])).failure, 'interrupted');
  assert.equal((await read(records[1][0])).failure, 'interrupted');
  assert.equal(alive(bystander.pid), true, 'a process whose start time differs is not the build');
  assert.equal((await read(liveKey)).state, 'preparing');
});

test('pruning keeps a build another profile references and the newest ready build', { timeout: 120_000 }, async t => {
  const w = await world(t, { files: customizationFixtureFiles() });
  const store = openStore(w.setupRoot);
  w.git(w.root, 'clone', '--quiet', '--branch', 'customization', w.remote, store.paths.clone);
  const head = w.git(store.paths.clone, 'rev-parse', 'HEAD');
  const write = async (key, state, finishedAt) => {
    await mkdir(join(store.paths.builds, key), { recursive: true });
    await writeFile(join(store.paths.builds, key, 'build.json'), JSON.stringify({ version: 1, buildKey: key, inputsKey: key, commit: head, state, finishedAt, startedAt: 1, phases: {}, namespaces: [], grants: [], ignoredGrants: [] }));
  };
  await write('8'.repeat(64), 'ready', 1);
  await write('9'.repeat(64), 'ready', 2);
  await write('a'.repeat(64), 'failed', 3);
  await mkdir(store.paths.profiles, { recursive: true });
  await writeFile(join(store.paths.profiles, 'other.json'), JSON.stringify({ current: '8'.repeat(64), next: null }));
  const m = createBuildManager({ store, repositoryRoot: checkout, sessionId: 'prune', readIdentity: async () => identity('b'.repeat(64)), chromium: async () => true, script: await stubBuilder(w, 'ok') });
  await m.start({ connection: fixtureConnection(w.remote), head });
  await w.until(async () => final(m.current().state), 'build');
  await w.until(async () => !existsSync(join(store.paths.builds, 'a'.repeat(64))), 'pruned failed build');
  assert.ok(existsSync(join(store.paths.builds, '8'.repeat(64))), 'referenced by another profile');
  assert.ok(existsSync(join(store.paths.builds, m.current().buildKey)), 'the newest ready build');
});

test('gate G2: the worker builds examples/customization from a fresh clone and records each phase', { skip: !networkTests && 'set AGENTUI_CUSTOMIZATION_NETWORK_TESTS=1', timeout: 3_600_000 }, async t => {
  const tree = await committedTreeRepository(t);
  tree.commit('example');
  const w = await world(t, { files: { 'README.md': 'seed\n' } });
  // Publish the committed tree as a new branch of the remote.
  w.git(tree.directory, 'push', '--quiet', w.remote, 'HEAD:refs/heads/example');
  w.startWorker({ repositoryRoot: checkout, environment: { ...process.env } });
  await w.online();
  assert.equal(await w.mutate('connect', { location: w.remote, branch: 'example', subdirectory: 'examples/customization' }), 'ok');
  const started = Date.now();
  const result = await build(w, status => status.build && final(status.build.state), 'example build', 3_500_000);
  const record = JSON.parse(await readFile(join(w.setupRoot, 'customization/builds', result.buildKey, 'build.json'), 'utf8'));
  for (const [phase, span] of Object.entries(record.phases)) t.diagnostic(`G2 phase ${phase}: ${span.finishedAt - span.startedAt} ms`);
  t.diagnostic(`G2 total: ${Date.now() - started} ms, state ${result.state}${result.failure ? ` (${result.failure})` : ''}`);
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.namespaces, ['coworkers', 'crew']);
  // The same flow with an empty Playwright browser cache reports toolchain-missing and starts no builder.
  const empty = join(w.root, 'no-browsers');
  await mkdir(empty);
  const w2 = await world(t, { files: { 'README.md': 'seed\n' } });
  w2.git(tree.directory, 'push', '--quiet', w2.remote, 'HEAD:refs/heads/example');
  w2.startWorker({ repositoryRoot: checkout, environment: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: empty } });
  await w2.online();
  assert.equal(await w2.mutate('connect', { location: w2.remote, branch: 'example', subdirectory: 'examples/customization' }), 'ok');
  const missing = await build(w2, status => status.build && final(status.build.state), 'toolchain check', 300_000);
  assert.deepEqual([missing.state, missing.failure], ['failed', 'toolchain-missing']);
});

test('the launcher sees a running build with a live owner and only then skips its own rebuild', async t => {
  const { activeCustomizationBuild } = await import('../../scripts/lib/customization-store.mjs');
  const w = await world(t, { files: { 'README.md': 'seed\n' } });
  const store = openStore(w.setupRoot);
  assert.equal(await activeCustomizationBuild(w.setupRoot), false);
  const key = 'c'.repeat(64);
  await mkdir(join(store.paths.builds, key), { recursive: true });
  const record = owner => JSON.stringify({ version: 1, buildKey: key, state: 'preparing', owner });
  await writeFile(join(store.paths.builds, key, 'build.json'), record({ sessionId: 'dead', pid: 999_999, processStartTime: 'never', hostname: hostname() }));
  assert.equal(await activeCustomizationBuild(w.setupRoot), false, 'a dead owner does not block the rebuild');
  await writeFile(join(store.paths.builds, key, 'build.json'), record({ sessionId: 'live', pid: process.pid, processStartTime: processStartTime(process.pid), hostname: hostname() }));
  assert.equal(await activeCustomizationBuild(w.setupRoot), true);
});
