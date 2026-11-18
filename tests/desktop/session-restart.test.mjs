import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { waitForHost } from '../../scripts/agentui-launch.mjs';
import { deliverBuild } from '../../scripts/lib/customization-delivery.mjs';

const wrapper = fileURLToPath(new URL('../../scripts/agentui-launch-session.mjs', import.meta.url));
const HOST_ARTIFACT = 'a'.repeat(64);
const key = character => character.repeat(64);
const grant = (namespace, variable) => ({ id: 'personal', instance: { namespace, installationId: 'personal', generation: '1', protocolVersion: '1' },
  service: 'http://127.0.0.1:9', expectedAuthority: 'remote-provider', authentication: { kind: 'environment', variable, revision: '1' } });
const ALPHA = 'AGENTUI_EXTENSION_ALPHA_TOKEN', BETA = 'AGENTUI_EXTENSION_BETA_TOKEN';
const CAPABILITY = 'c'.repeat(64);

/**
 * A stub host: it logs its arguments and the names of the variables it got, then announces a ready line and answers
 * `metadata` like the real host. An `--assets` path containing `crash` exits before ready; one containing `hang` never
 * gets ready. SIGUSR2 makes it exit with code 75.
 */
const STUB = `import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const extensions = value('--extensions');
appendFileSync(process.env.STUB_LOG, JSON.stringify({ pid: process.pid, args, capability: process.env.AGENTUI_SETUP_CAPABILITY ?? null,
  alpha: process.env.${ALPHA} ?? null, beta: process.env.${BETA} ?? null, extensions: extensions ? JSON.parse(readFileSync(extensions, 'utf8')) : null }) + '\\n');
process.on('SIGINT', () => process.exit(0));
process.on('SIGUSR2', () => process.exit(75));
const assets = value('--assets') ?? '';
if (assets.includes('crash')) process.exit(3);
setInterval(() => {}, 1000);
if (!assets.includes('hang')) {
  const port = Number(value('--port') ?? 0);
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ok: true, value: { compatibility: { appliedArtifact: { artifactId: '${HOST_ARTIFACT}' } } } }));
  });
  server.listen(port, '127.0.0.1', () => process.stdout.write(JSON.stringify({ mode: 'desktop', origin: 'http://127.0.0.1:' + server.address().port, hostId: 'stub-host' }) + '\\n'));
}
`;

async function freePort() {
  return new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
}
async function world(t, { wrapperPath = wrapper } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'agentui-session-'));
  // Stub hosts are killed by the PIDs they logged before the directory that holds the log goes away.
  t.after(async () => {
    const lines = (await readFile(join(root, 'stub.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
    for (const line of lines) { try { process.kill(JSON.parse(line).pid, 'SIGKILL'); } catch { /* gone */ } }
    await rm(root, { recursive: true, force: true });
  });
  const release = join(root, 'release');
  await mkdir(join(release, 'host'), { recursive: true });
  await writeFile(join(release, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(release, 'host/main.js'), STUB);
  await writeFile(join(release, 'host/artifact.json'), JSON.stringify({ artifactId: HOST_ARTIFACT }));
  const data = join(root, 'data');
  await mkdir(join(data, 'customization'), { recursive: true });
  const log = join(root, 'stub.log');
  await writeFile(log, '');
  const port = await freePort();
  return { root, release, data, log, port, wrapperPath, entries: async () => (await readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    launch: value => writeFile(join(data, 'customization/launch.json'), JSON.stringify({ version: 1, ...value })),
    result: async () => JSON.parse(await readFile(join(data, 'customization/launch-result.json'), 'utf8')) };
}
function start(t, w, { secrets = { OPENCODE_GO_API_KEY: null, AGENTUI_SETUP_CAPABILITY: CAPABILITY, extensionVariables: { [ALPHA]: 'alpha-value' } }, readyMs = 1_500, env = {} } = {}) {
  const args = ['desktop', '--data-dir', w.data, '--assets', join(w.release, 'browser'), '--port', String(w.port)];
  const child = spawn(process.execPath, [w.wrapperPath, process.execPath, join(w.release, 'host/main.js'), ...args],
    { cwd: w.root, env: { ...process.env, [ALPHA]: '', [BETA]: '', STUB_LOG: w.log, AGENTUI_SESSION_READY_TIMEOUT_MS: String(readyMs), ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { errors += data; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); child.kill('SIGKILL'); } });
  child.stdin.write(`${typeof secrets === 'string' ? secrets : JSON.stringify(secrets)}\n`);
  return { child, exited, output: () => output, errors: () => errors, origin: `http://127.0.0.1:${w.port}` };
}
async function until(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
const readyCount = session => session.output().split('\n').filter(line => line.includes('"hostId"')).length;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const flagCount = (args, flag) => args.filter(item => item === flag).length;
const target = (buildKey, root, extra = {}) => ({ buildKey, inputsKey: key('i'), hostArtifactId: HOST_ARTIFACT, assets: join(root, buildKey.slice(0, 4), 'desktop'),
  server: { directory: join(root, buildKey.slice(0, 4), 'server'), artifactId: key('d') }, grants: [grant('alpha', ALPHA), grant('beta', BETA)], ...extra });

test('exit code 75 restarts the host with --assets replaced and the generated --extensions file; a missing token omits only its grant', { timeout: 30_000 }, async t => {
  const w = await world(t);
  const session = start(t, w);
  await until(() => readyCount(session) === 1, 'first ready');
  const [first] = await w.entries();
  assert.equal(flagCount(first.args, '--extensions'), 0, 'defaults first');
  assert.deepEqual((await w.result()).outcome, 'defaults');
  const next = target(key('1'), w.root);
  await w.launch({ current: null, next });
  process.kill(first.pid, 'SIGUSR2');
  await until(() => readyCount(session) === 2, 'restart ready');
  const second = (await w.entries())[1];
  assert.equal(flagCount(second.args, '--assets'), 1, 'exactly one --assets');
  assert.equal(second.args[second.args.indexOf('--assets') + 1], next.assets);
  const generated = second.args[second.args.indexOf('--extensions') + 1];
  assert.equal(generated, join(w.data, 'customization/extensions.generated.json'));
  assert.deepEqual(second.extensions, { version: 2, ownership: 'transient', extensions: [{ kind: 'artifact', directory: next.server.directory, artifactId: key('d'), installations: [grant('alpha', ALPHA)] }] });
  const result = await w.result();
  assert.deepEqual({ ...result, hostPid: undefined }, { version: 1, hostPid: undefined, attempted: key('1'), started: key('1'), outcome: 'ok', failed: [], omittedGrants: [BETA] });
  assert.equal(result.hostPid, second.pid);
  for (const file of ['extensions.generated.json', 'launch-result.json']) assert.doesNotMatch(await readFile(join(w.data, 'customization', file), 'utf8'), /alpha-value/u, 'names only');
  // Every start receives the same environment, including the setup capability and the supplied extension variable.
  assert.deepEqual([first, second].map(entry => [entry.capability, entry.alpha, entry.beta]), [[CAPABILITY, 'alpha-value', ''], [CAPABILITY, 'alpha-value', '']]);
  assert.deepEqual(session.output().split('\n').filter(Boolean), [1, 2].map(() => JSON.stringify({ mode: 'desktop', origin: session.origin, hostId: 'stub-host' })),
    'every ready line is forwarded unchanged');
  // The lease still works after the restart: closing standard input stops the host and ends the session cleanly.
  session.child.stdin.end();
  assert.deepEqual(await session.exited, { code: 0, signal: null }, session.errors());
  assert.equal(alive(second.pid), false);
});

test('the launcher’s real waitForHost succeeds through the wrapper', { timeout: 30_000 }, async t => {
  const w = await world(t);
  const session = start(t, w);
  const handle = { exited: session.exited.then(({ code }) => { if (code !== 0) throw new Error(`exited ${code}`); }), output: session.output };
  await waitForHost(handle, session.origin, HOST_ARTIFACT);
  session.child.stdin.end();
  await session.exited;
});

test('a next that exits before ready and a current that never gets ready both fall back, ending on the defaults', { timeout: 30_000 }, async t => {
  const w = await world(t);
  await w.launch({ current: target(key('1'), w.root, { assets: join(w.root, 'hang', 'desktop') }), next: target(key('2'), w.root, { assets: join(w.root, 'crash', 'desktop') }) });
  const session = start(t, w);
  await until(() => readyCount(session) === 1, 'ready on defaults');
  const entries = await w.entries();
  assert.deepEqual(entries.map(entry => entry.args[entry.args.indexOf('--assets') + 1]), [join(w.root, 'crash', 'desktop'), join(w.root, 'hang', 'desktop'), join(w.release, 'browser')]);
  assert.equal(alive(entries[1].pid), false, 'the target that never got ready was killed');
  const result = await w.result();
  assert.deepEqual([result.attempted, result.started, result.outcome, result.failed], [key('2'), null, 'start-failed', [key('2'), key('1')]]);
  session.child.stdin.end();
  await session.exited;
});

test('a next that exits before ready falls back to current, which starts; the result names the failed key', { timeout: 30_000 }, async t => {
  const w = await world(t);
  const current = target(key('1'), w.root);
  await w.launch({ current, next: target(key('2'), w.root, { assets: join(w.root, 'crash', 'desktop') }) });
  const session = start(t, w);
  await until(() => readyCount(session) === 1, 'ready on current');
  const entries = await w.entries();
  assert.equal(entries.at(-1).args[entries.at(-1).args.indexOf('--assets') + 1], current.assets);
  const result = await w.result();
  assert.deepEqual([result.started, result.outcome, result.failed], [key('1'), 'start-failed', [key('2')]]);
  session.child.stdin.end();
  await session.exited;
});

test('a target made by another host build is not started and the start is recorded as stale', { timeout: 30_000 }, async t => {
  const w = await world(t);
  await w.launch({ current: target(key('1'), w.root, { hostArtifactId: key('e') }), next: null });
  const session = start(t, w);
  await until(() => readyCount(session) === 1, 'ready');
  const [entry] = await w.entries();
  assert.equal(entry.args.includes('--extensions'), false);
  assert.deepEqual([(await w.result()).outcome, (await w.result()).started], ['stale', null]);
  session.child.stdin.end();
  await session.exited;
});

test('extensionVariables with a bad name or a non-string value is rejected and nothing starts', { timeout: 15_000 }, async t => {
  for (const variables of [{ OTHER_TOKEN: 'x' }, { [ALPHA]: 7 }, ['x']]) {
    const w = await world(t);
    const session = start(t, w, { secrets: { OPENCODE_GO_API_KEY: null, extensionVariables: variables } });
    assert.equal((await session.exited).code, 1);
    assert.match(session.errors(), /Invalid AgentUI session environment/u);
    assert.deepEqual(await w.entries(), []);
  }
});

test('the wrapper copied alone into an empty release with a bare package.json runs: it has no local imports', { timeout: 30_000 }, async t => {
  const w = await world(t);
  const alone = join(w.release, 'session.mjs');
  await copyFile(wrapper, alone);
  const session = start(t, { ...w, wrapperPath: alone });
  await until(() => readyCount(session) === 1, 'ready from the copied wrapper');
  session.child.stdin.end();
  assert.equal((await session.exited).code, 0);
});

/** Runs the remote command an ssh invocation would run, locally: the last argument is `sh -c '<script>'`. */
function localRunner(calls) {
  return args => {
    calls.push(args.at(-1));
    const child = spawn('/bin/sh', ['-c', args.at(-1)], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    const exited = new Promise((resolve, reject) => child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`exit ${code}`))));
    return { child, exited };
  };
}
async function localBuild(root, buildKey, ids) {
  const directory = join(root, 'local/customization/builds', buildKey);
  await mkdir(join(directory, 'desktop'), { recursive: true });
  await mkdir(join(directory, 'server'), { recursive: true });
  await writeFile(join(directory, 'desktop/index.html'), ids.desktop);
  await writeFile(join(directory, 'server/entries.mjs'), ids.server);
  await writeFile(join(directory, 'build.json'), JSON.stringify({ version: 1, buildKey, state: 'ready', desktopArtifactId: ids.desktop, serverArtifactId: ids.server,
    grants: [grant('alpha', ALPHA)] }));
  return join(root, 'local/customization/builds');
}

test('SSH delivery uploads a build, skips an identical remote copy, replaces a different one, and the copied wrapper starts it', { timeout: 60_000 }, async t => {
  const w = await world(t);
  const remoteSetupRoot = join(w.root, 'remote-setup');
  const buildKey = key('7');
  const buildsRoot = await localBuild(w.root, buildKey, { desktop: key('d'), server: key('5') });
  const stale = join(remoteSetupRoot, 'customization/builds', key('9'));
  await mkdir(stale, { recursive: true });
  // Another profile on the same remote machine runs this build; its copy stays.
  const shared = join(remoteSetupRoot, 'customization/builds', key('8'));
  await mkdir(shared, { recursive: true });
  await mkdir(join(remoteSetupRoot, 'data/other-profile/customization'), { recursive: true });
  await writeFile(join(remoteSetupRoot, 'data/other-profile/customization/launch.json'), JSON.stringify({ version: 1, current: { buildKey: key('8') }, next: null }, null, 2));
  const calls = [];
  const target = { kind: 'ssh', destination: 'test-only', remoteSetupRoot };
  const delivered = await deliverBuild({ buildsRoot, buildKey, target, runner: localRunner(calls) });
  const remote = join(remoteSetupRoot, 'customization/builds', buildKey);
  assert.deepEqual(delivered, { assets: join(remote, 'desktop'), server: { directory: join(remote, 'server'), artifactId: key('5') }, grants: [grant('alpha', ALPHA)] });
  assert.equal(await readFile(join(remote, 'desktop/index.html'), 'utf8'), key('d'));
  assert.equal(existsSync(stale), false, 'remote builds no host uses are removed');
  assert.equal(existsSync(shared), true, 'a build another profile uses is kept');
  // Same artifact IDs: no upload. A marker in the remote copy survives.
  await writeFile(join(remote, 'marker'), 'kept');
  const before = calls.length;
  await deliverBuild({ buildsRoot, buildKey, target, runner: localRunner(calls) });
  assert.equal(await readFile(join(remote, 'marker'), 'utf8'), 'kept');
  assert.equal(calls.slice(before).some(script => script.includes('tar -xzf')), false);
  // The same key rebuilt with other artifacts: the remote copy is replaced.
  await localBuild(w.root, buildKey, { desktop: key('6'), server: key('8') });
  await deliverBuild({ buildsRoot, buildKey, target, runner: localRunner(calls) });
  assert.equal(existsSync(join(remote, 'marker')), false);
  assert.equal(await readFile(join(remote, 'desktop/index.html'), 'utf8'), key('6'));
  // The release's own wrapper starts the host with the delivered build.
  const alone = join(w.release, 'session.mjs');
  await copyFile(wrapper, alone);
  const delivery = await deliverBuild({ buildsRoot, buildKey, target, runner: localRunner(calls) });
  await w.launch({ current: null, next: { buildKey, inputsKey: key('i'), hostArtifactId: HOST_ARTIFACT, ...delivery } });
  const session = start(t, { ...w, wrapperPath: alone }, { env: { [ALPHA]: 'remote-alpha' } });
  await until(() => readyCount(session) === 1, 'ready with the delivered build');
  const [entry] = await w.entries();
  assert.equal(entry.args[entry.args.indexOf('--assets') + 1], join(remote, 'desktop'));
  assert.equal(entry.extensions.extensions[0].directory, join(remote, 'server'));
  assert.equal((await w.result()).started, buildKey);
  session.child.stdin.end();
  await session.exited;
});
