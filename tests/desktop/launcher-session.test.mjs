import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CODEX_RUNTIME } from '@agentui/contracts/compatibility';
import { parseLaunchArgs, assertPortAvailable } from '../../scripts/agentui-launch.mjs';
import { bootstrapScript, distribution, profileFor, shellQuote } from '../../scripts/agentui-runtime.mjs';

const helper = fileURLToPath(new URL('../../scripts/agentui-launch-session.mjs', import.meta.url));

test('local and SSH configurations retain their workspace and provider choices', () => {
  assert.deepEqual(parseLaunchArgs(['--agent', 'pi', '--no-open', '--skip-build'], '/work/project'),
    { kind: 'local', workspace: '/work/project', agent: 'pi', port: null, open: false, build: false });
  assert.deepEqual(parseLaunchArgs(['--ssh', 'lunus@100.102.195.3', '--workspace', '~/git/project', '--port', '18714']),
    { kind: 'ssh', destination: 'lunus@100.102.195.3', workspace: '~/git/project', agent: 'codex', port: 18714, open: true, build: true });
  for (const args of [['--ssh', '-oProxyCommand=bad'], ['--ssh', 'host;touch /tmp/bad'], ['--agent', 'other'], ['--port', '0'], ['--port', '65536'], ['--workspace'], ['--unknown']]) {
    assert.throws(() => parseLaunchArgs(args));
  }
});

test('server provisioning recognizes the supplied Mac ARM and Linux x64 targets', () => {
  assert.equal(distribution('Darwin', 'arm64'), 'darwin-arm64');
  assert.equal(distribution('Linux', 'x86_64'), 'linux-x64');
  assert.equal(distribution('Linux', 'aarch64'), 'linux-arm64');
  assert.throws(() => distribution('Linux', 'mips'));
});

test('workspace profiles are stable across restart and separate machines and providers', () => {
  const local = profileFor('local', '/work/project', 'pi');
  assert.deepEqual(local, profileFor('local', '/work/project', 'pi'));
  assert.notDeepEqual(local, profileFor('local', '/work/another', 'pi'));
  assert.notDeepEqual(local, profileFor('lunus@100.102.195.3', '/work/project', 'pi'));
  assert.notDeepEqual(local, profileFor('local', '/work/project', 'codex'));
  assert.ok(local.port >= 18000 && local.port < 40000);
});

test('shell paths remain literal including quotes and substitution syntax', () => {
  const value = "some path/'quoted' $(printf injected) `printf injected`";
  const result = spawnSync('/bin/sh', ['-c', `printf '%s' ${shellQuote(value)}`], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, value);
});

test('Pi provisioning does not install Codex or require its login', () => {
  const script = bootstrapScript('24.22.3', 'pi', CODEX_RUNTIME.version);
  assert.doesNotMatch(script, /npm install|login status/);
  assert.ok(bootstrapScript('24.22.3', 'codex', CODEX_RUNTIME.version).includes(`@openai/codex@${CODEX_RUNTIME.version}`));
});

test('Codex provisioning leaves login readiness to the host so Pi setup can open', () => {
  const script = bootstrapScript('24.22.3', 'codex', CODEX_RUNTIME.version);
  assert.doesNotMatch(script, /login status/);
  assert.ok(script.includes(`@openai/codex@${CODEX_RUNTIME.version}`));
});

test('launcher refuses an occupied local port without affecting the listener', async t => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(assertPortAvailable(server.address().port), /in use/);
  assert.equal(server.listening, true);
});

function kill(pid, signal = 'SIGKILL') {
  if (!pid) return;
  try { process.kill(pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), 'Owned process cleanup did not complete');
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function session(t, { ownKey, descendant = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-lease-'));
  const main = join(directory, 'host.mjs');
  await writeFile(main, `import {spawn} from 'node:child_process';
const report = extra => process.stdout.write(JSON.stringify({pid:process.pid,key:process.env.OPENCODE_GO_API_KEY,...extra})+'\\n');
${descendant ? `const child=spawn(process.execPath,['-e', 'process.on("SIGINT",()=>{});process.send("ready");setInterval(()=>{},1000);'],{stdio:['ignore','inherit','inherit','ipc']});
child.once('message',()=>report({descendant:child.pid}));` : 'report({});'}
process.on('SIGINT',()=>process.exit(0));
setInterval(()=>{},1000);
`);
  const child = spawn(process.execPath, [helper, process.execPath, main], { env: { ...process.env, OPENCODE_GO_API_KEY: ownKey ?? '' }, stdio: ['pipe', 'pipe', 'pipe'] });
  let reported;
  t.after(async () => {
    kill(reported?.descendant);
    kill(reported?.pid);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  let errors = '';
  child.stderr.on('data', data => { errors += data; });
  let stdout = '';
  const output = new Promise(resolve => child.stdout.on('data', data => { stdout += data; if (stdout.includes('\n')) { reported = JSON.parse(stdout.split('\n')[0]); resolve(reported); } }));
  child.stdin.write(`${JSON.stringify({ OPENCODE_GO_API_KEY: 'forwarded-key' })}\n`);
  return { child, closed, output, errors: () => errors };
}

test('session closes its host when the SSH input lease ends', { timeout: 5000 }, async t => {
  const running = await session(t);
  const host = await running.output;
  assert.equal(host.key, 'forwarded-key');
  process.kill(host.pid, 0);
  running.child.stdin.end();
  assert.deepEqual(await running.closed, { code: 0, signal: null }, running.errors());
  assert.throws(() => process.kill(host.pid, 0), { code: 'ESRCH' });
});

test('server environment takes precedence and SIGTERM closes its owned host', { timeout: 5000 }, async t => {
  const running = await session(t, { ownKey: 'server-key' });
  const host = await running.output;
  assert.equal(host.key, 'server-key');
  running.child.kill('SIGTERM');
  assert.deepEqual(await running.closed, { code: 0, signal: null }, running.errors());
  assert.throws(() => process.kill(host.pid, 0), { code: 'ESRCH' });
});

test('session cleanup closes inherited stdio and stops a surviving host descendant', { timeout: 5000 }, async t => {
  const running = await session(t, { descendant: true });
  const host = await running.output;
  let closed = false;
  running.closed.then(() => { closed = true; });
  running.child.stdin.end();
  await until(() => closed && !alive(host.descendant));
  assert.deepEqual(await running.closed, { code: 0, signal: null }, running.errors());
  assert.equal(alive(host.pid), false);
});

for (const signal of ['SIGTERM', 'SIGHUP']) test(`${signal} during SSH setup ends owned processes and never starts a host`, { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fakeSsh = join(directory, 'ssh');
  await writeFile(fakeSsh, `#!/bin/sh\nexec ${shellQuote(process.execPath)} -e 'process.stderr.write("SETUP_PID="+process.pid+"\\n"); setInterval(()=>{},1000);'\n`, { mode: 0o755 });
  const entry = fileURLToPath(new URL('../../scripts/agentui-launch.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry, '--skip-build', '--no-open', '--agent', 'pi', '--ssh', 'test-only'],
    { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let pid;
  t.after(() => {
    kill(pid ? -pid : undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  let errors = '';
  const started = new Promise(resolve => child.stderr.on('data', data => {
    errors += data;
    const found = /SETUP_PID=(\d+)/.exec(errors);
    if (found) resolve(Number(found[1]));
  }));
  const closed = new Promise(resolve => child.once('close', resolve));
  pid = await started;
  child.kill(signal);
  await closed;
  assert.doesNotMatch(output, /"event":"ready"/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('cancellation cleans an exited setup leader and its inherited-stdio descendant', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-exited-setup-'));
  const main = join(directory, 'setup.mjs');
  await writeFile(main, `import {spawn} from 'node:child_process';
const child=spawn(process.execPath,['-e','process.send("ready");setInterval(()=>{},1000);'],{stdio:['ignore','inherit','inherit','ipc']});
child.once('message',()=>{process.stderr.write('SETUP_TREE='+JSON.stringify({leader:process.pid,descendant:child.pid})+'\\n');process.exit(0);});
`);
  await writeFile(join(directory, 'ssh'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(main)}\n`, { mode: 0o755 });
  const entry = fileURLToPath(new URL('../../scripts/agentui-launch.mjs', import.meta.url));
  const child = spawn(process.execPath, [entry, '--skip-build', '--no-open', '--agent', 'pi', '--ssh', 'test-only'],
    { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let tree;
  t.after(async () => {
    kill(tree?.descendant);
    kill(tree?.leader);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(directory, { recursive: true, force: true });
  });
  let errors = '', output = '', closed = false;
  child.stdout.on('data', data => { output += data; });
  const started = new Promise(resolve => child.stderr.on('data', data => {
    errors += data;
    const found = /SETUP_TREE=(\{[^\n]+\})/.exec(errors);
    if (found) { tree = JSON.parse(found[1]); resolve(); }
  }));
  child.once('close', () => { closed = true; });
  await started;
  await until(() => !alive(tree.leader));
  child.kill('SIGTERM');
  await until(() => closed && !alive(tree.descendant));
  assert.doesNotMatch(output, /"event":"ready"/);
});
