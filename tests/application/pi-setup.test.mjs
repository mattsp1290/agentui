import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';

const marker = 'test-only-opencode-go-marker-NEVER-PERSIST';
const capability = 'ab'.repeat(32);
async function fixture(t, preferred = 'pi') {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-pi-setup-'));
  const children = [];
  const f = { directory, origin: '', stderr: '' };
  f.start = async () => {
    const child = spawn(process.execPath, ['apps/host/dist/main.js', 'desktop', '--trusted', '--preferred', preferred,
      '--workspace', directory, '--data-dir', join(directory, 'data'), '--port', '0', ...(preferred === 'codex' ? ['--executable', '/nonexistent/codex'] : [])], {
      env: { ...process.env, OPENCODE_GO_API_KEY: '', AGENTUI_SETUP_CAPABILITY: capability }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', data => { f.stderr += data; });
    const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
    children.push({ child, exited });
    const lines = createInterface({ input: child.stdout });
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject);
      lines.once('line', line => { try { resolve(JSON.parse(line)); } catch (error) { reject(error); } });
      exited.then(() => reject(new Error(`Host stopped before readiness. ${f.stderr}`)));
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { Object.assign(f, await ready); } finally { clearTimeout(timeout); lines.close(); }
    f.stop = async () => { child.kill('SIGTERM'); assert.equal(await exited, 0, f.stderr); };
  };
  f.call = async (body, { path = '/setup/pi', headers = {}, raw = false } = {}) => new Promise((resolve, reject) => {
    const outgoing = request(`${f.origin}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}`, ...headers },
    }, response => {
      let text = '';
      response.setEncoding('utf8').on('data', part => { text += part; });
      response.once('end', () => resolve({ status: response.statusCode, headers: response.headers, text, body: JSON.parse(text) }));
    });
    outgoing.once('error', reject);
    outgoing.end(raw ? body : JSON.stringify(body));
  });
  f.metadata = async () => {
    const response = await fetch(`${f.origin}/api/v1`, { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'metadata' }) });
    return (await response.json()).value;
  };
  t.after(async () => {
    for (const { child, exited } of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      child.kill('SIGTERM');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timeout); }
    }
    await rm(directory, { recursive: true, force: true });
  });
  await f.start();
  return f;
}

async function files(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }))).flat();
}

test('managed Pi opens without credentials, activates through native authority and forgets the key at restart', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  let metadata = await f.metadata();
  const pi = metadata.agents.find(agent => agent.runtime.engine === 'pi');
  assert.equal(pi.availability.kind, 'unavailable');
  assert.match(pi.availability.reason, /OpenCode Go.*API key.*Settings/);
  assert.deepEqual((await f.call({ op: 'status' })).body, { ok: true, value: { kind: 'missing-key' } });
  const configured = await f.call({ op: 'configure', apiKey: marker });
  assert.equal(configured.status, 200, configured.text);
  assert.deepEqual(configured.body, { ok: true, value: { kind: 'ready', source: 'native-session' } });
  assert.equal(configured.headers['cache-control'], 'no-store');
  metadata = await f.metadata();
  assert.equal(metadata.agents.find(agent => agent.id === pi.id).availability.kind, 'ready');
  const create = await fetch(`${f.origin}/api/v1`, { method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 'create', scope: { hostId: f.hostId, conversationId: 'configured-pi' }, agentId: pi.id }) });
  assert.equal(create.status, 200);
  assert.equal((await f.call({ op: 'configure', apiKey: marker })).status, 200);
  const replacement = await f.call({ op: 'configure', apiKey: 'another-synthetic-key' });
  assert.equal(replacement.status, 409);
  assert.doesNotMatch(JSON.stringify(metadata) + f.stderr + configured.text + replacement.text, new RegExp(marker));
  await f.stop();
  for (const path of await files(join(f.directory, 'data'))) {
    assert.equal((await readFile(path)).includes(Buffer.from(marker)), false, path);
    assert.equal((await readFile(path)).includes(Buffer.from(capability)), false, path);
  }
  await f.start();
  assert.deepEqual((await f.call({ op: 'status' })).body.value, { kind: 'missing-key' });
  assert.equal((await f.metadata()).agents.find(agent => agent.id === pi.id).availability.kind, 'unavailable');
});

test('managed setup rejects browser, foreign authority and invalid requests without reflecting secrets', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  for (const headers of [
    { Origin: f.origin }, { Cookie: 'anything=browser' }, { Host: 'localhost' }, { Authorization: 'Bearer wrong' },
    { 'Content-Type': 'text/plain' }, { Authorization: '' },
  ]) {
    const result = await f.call({ op: 'configure', apiKey: marker }, { headers });
    assert.ok(result.status >= 400, result.text);
    assert.doesNotMatch(result.text, new RegExp(marker));
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  for (const body of [{ op: 'configure', apiKey: '' }, { op: 'configure', apiKey: 'a\nb' }, { op: 'configure', apiKey: 'x'.repeat(4097) },
    { op: 'configure', apiKey: marker, extra: true }, { op: 'status', apiKey: marker }, { op: 'unknown' }]) {
    const result = await f.call(body);
    assert.equal(result.status, 400, result.text);
    assert.doesNotMatch(result.text, new RegExp(marker));
  }
  assert.equal((await f.call('{', { raw: true })).status, 400);
  const oversized = await f.call('x'.repeat(8193), { raw: true }).catch(() => ({ status: 400 }));
  assert.equal(oversized.status, 400);
  assert.deepEqual((await f.call({ op: 'status' })).body.value, { kind: 'missing-key' });
});

test('default managed host advertises Pi even when Codex is unavailable', { timeout: 10_000 }, async t => {
  const f = await fixture(t, 'codex');
  const metadata = await f.metadata();
  assert.deepEqual(metadata.agents.map(agent => agent.runtime.engine).sort(), ['codex', 'pi']);
  assert.match(metadata.agents.find(agent => agent.runtime.engine === 'codex').availability.reason, /codex login/);
  assert.equal((await f.call({ op: 'configure', apiKey: marker })).body.value.kind, 'ready');
  assert.equal((await f.metadata()).agents.find(agent => agent.runtime.engine === 'pi').availability.kind, 'ready');
});


test('desktop setup requires startup authority before opening host data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-pi-authority-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, ['apps/host/dist/main.js', 'desktop', '--trusted', '--preferred', 'pi',
    '--workspace', directory, '--data-dir', join(directory, 'data'), '--port', '0'], {
    env: { ...process.env, AGENTUI_SETUP_CAPABILITY: '' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Launch desktop setup through/);
  assert.equal(result.stdout, '');
  assert.deepEqual(await readdir(directory), []);
});
