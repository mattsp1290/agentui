import { describeAgent } from '../../apps/host/build/tsc/agents.js';
import { recordedInstallation } from '@agentui/host/recorded';
const recordedAgentId = describeAgent(recordedInstallation, { kind: 'ready' }).id;
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-native-'));
  const children = [];
  const launch = (args, ipc = false) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const result = { child, exited, get stderr() { return stderr; } };
    children.push(result);
    return result;
  };
  t.after(async () => {
    await Promise.all(children.map(async ({ child, exited }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }));
    rmSync(directory, { recursive: true, force: true });
  });
  const cli = args => launch(['apps/host/dist/main.js', ...args, '--data-dir', directory]);
  const host = cli(['browser-dev', '--port', '0']);
  const lines = createInterface({ input: host.child.stdout });
  const ready = await Promise.race([
    new Promise(resolve => lines.once('line', line => resolve(JSON.parse(line)))),
    host.exited.then(() => { throw new Error(`Host failed to start ${host.stderr}`); }),
  ]);
  lines.close();
  const control = async (op, id) => {
    const child = cli([op, ...(id ? ['--id', id] : [])]);
    let stdout = '';
    child.child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    assert.equal((await child.exited).code, 0, child.stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    return result.value;
  };
  const call = (path, body, headers = {}, method = 'POST') => new Promise((resolve, reject) => {
    const outgoing = request(`${ready.origin}${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers } }, incoming => {
      let text = '';
      incoming.setEncoding('utf8').on('data', value => { text += value; });
      incoming.once('error', reject);
      incoming.once('end', () => resolve({ status: incoming.statusCode, headers: incoming.headers, body: JSON.parse(text) }));
    });
    outgoing.once('error', reject);
    outgoing.setTimeout(12_000, () => outgoing.destroy(new Error('Native HTTP timeout')));
    outgoing.end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  return { ...ready, directory, host, launch, control, call };
}
function denied(response, status = 400) {
  assert.equal(response.status, status);
  assert.equal(response.body.ok, false);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['set-cookie'], undefined);
}
const pairRequest = (f, code) => ({ version: 1, hostId: f.hostId, code });
const bearer = secret => ({ Authorization: `Bearer ${secret}` });

test('native loopback routes reject ambiguous credentials, class substitution and noncanonical requests', { timeout: 20_000 }, async t => {
  const f = await fixture(t), invitation = await f.control('invite-native');
  assert.equal(invitation.hostId, f.hostId);
  assert.match(invitation.code, /^[A-Za-z0-9_-]{32}$/);
  const pairing = pairRequest(f, invitation.code);
  for (const [body, headers, method] of [
    [{ ...pairing, hostId: 'another-host' }, {}, 'POST'],
    [{ ...pairing, extra: true }, {}, 'POST'],
    [pairing, { Origin: f.origin }, 'POST'], [pairing, { Cookie: '' }, 'POST'],
    [pairing, bearer('a'.repeat(43)), 'POST'], [pairing, {}, 'PUT'],
    [pairing, { Host: 'localhost' }, 'POST'], [pairing, { 'Content-Type': 'text/plain' }, 'POST'],
  ]) denied(await f.call('/native/v1/pair', body, headers, method), body.hostId === 'another-host' ? 403 : 400);
  denied(await f.call('/api/v1', { op: 'pair', code: invitation.code }, { Origin: f.origin }), 401);
  const paired = await f.call('/native/v1/pair', pairing);
  assert.equal(paired.status, 200);
  assert.equal(paired.headers['set-cookie'], undefined);
  assert.equal(paired.headers['cache-control'], 'no-store');
  assert.deepEqual(Object.keys(paired.body).sort(), ['ok', 'value']);
  assert.deepEqual(Object.keys(paired.body.value).sort(), ['hostId', 'principalId', 'secret']);
  const device = paired.body.value, auth = bearer(device.secret);
  assert.equal(device.hostId, f.hostId);
  assert.match(device.secret, /^[A-Za-z0-9_-]{43}$/);
  denied(await f.call('/native/v1/pair', pairing), 401);
  const browserInvitation = await f.control('invite');
  denied(await f.call('/native/v1/pair', pairRequest(f, browserInvitation.code)), 401);
  const browser = await f.call('/api/v1', { op: 'pair', code: browserInvitation.code }, { Origin: f.origin });
  assert.equal(browser.status, 200);
  const cookie = browser.headers['set-cookie'][0].split(';')[0], browserSecret = cookie.slice(cookie.indexOf('=') + 1);
  for (const [headers, status] of [
    [{}, 401], [bearer(browserSecret), 401], [{ Cookie: cookie }, 400],
    [{ ...auth, Origin: '' }, 400], [{ ...auth, Cookie: '' }, 400],
    [{ Authorization: [auth.Authorization, auth.Authorization] }, 401],
    [{ Authorization: `${auth.Authorization}, ${auth.Authorization}` }, 401],
    [{ ...auth, Host: 'foreign.example' }, 400], [{ ...auth, 'Content-Type': 'application/json; charset=utf-8' }, 400],
  ]) denied(await f.call('/native/v1', { op: 'metadata' }, headers), status);
  denied(await f.call('/api/v1', { op: 'metadata' }, { Origin: f.origin, ...auth }), 401);
  denied(await f.call('/api/v1', { op: 'metadata' }, { Origin: f.origin, Cookie: `agentui_device_${f.hostId}=${device.secret}` }), 401);
  const scope = { hostId: f.hostId, conversationId: 'native-boundary' };
  for (const body of [
    { op: 'pair', code: invitation.code }, { op: 'metadata', secret: 'rejected' },
    { op: 'create', agentId: recordedAgentId, scope: { ...scope, extra: true } },
    { op: 'submit', command: { version: 1, scope, clientCommandId: 'invalid', body: { kind: 'send', text: 'hello', extra: true } } },
    `${' '.repeat(410_000)}{"op":"metadata"}`, '{',
  ]) denied(await f.call('/native/v1', body, auth));
  denied(await f.call('/native/v1?secret=not-reflected', { op: 'metadata' }, auth));
  denied(await f.call('/native/v1', { op: 'create', agentId: recordedAgentId, scope: { ...scope, hostId: 'wrong' } }, auth), 403);
  assert.equal((await f.call('/native/v1', { op: 'metadata' }, auth)).body.value.principalId, device.principalId);
  const devices = await f.control('devices');
  const expires = devices.find(value => value.id === device.principalId).expires;
  assert.ok(expires > Date.now() + 30 * 24 * 3_600_000 - 100_000 && expires <= Date.now() + 30 * 24 * 3_600_000);
  assert.equal((await f.call('/native/v1', { op: 'create', agentId: recordedAgentId, scope }, auth)).status, 200);
  const { feedId } = (await f.call('/native/v1', { op: 'watch', scope, after: null, projectionVersion: 4 }, auth)).body.value;
  denied(await f.call('/api/v1', { op: 'pull', feedId, ack: null }, { Origin: f.origin, Cookie: cookie }));
  const page = (await f.call('/native/v1', { op: 'pull', feedId, ack: null }, auth)).body.value;
  let settled = false;
  const pending = f.call('/native/v1', { op: 'pull', feedId, ack: page.page }, auth);
  void pending.then(() => { settled = true; });
  await f.call('/native/v1', { op: 'metadata' }, auth);
  assert.equal(settled, false);
  await f.control('revoke', device.principalId);
  denied(await pending, 401);
  denied(await f.call('/native/v1', { op: 'metadata' }, auth), 401);
  assert.equal((await f.control('devices')).find(value => value.id === device.principalId).revoked, true);
});

test('separate native engine processes recover one original command after client exit while the bundled host lives', { timeout: 20_000 }, async t => {
  const f = await fixture(t), invitation = await f.control('invite-native');
  const run = input => {
    const child = f.launch([fileURLToPath(new URL('./support/native-client.mjs', import.meta.url))], true);
    child.child.send({ origin: f.origin, hostId: f.hostId, ...input });
    return child;
  };
  const acceptedPath = join(f.directory, 'recorded.jsonl');
  let watcher;
  const acceptance = new Promise(resolve => {
    watcher = watch(f.directory, () => { if (existsSync(acceptedPath) && readFileSync(acceptedPath, 'utf8').trim()) resolve(); });
  });
  t.after(() => watcher.close());
  const first = run({ code: invitation.code });
  const paired = await Promise.race([new Promise(resolve => first.child.once('message', resolve)),
    first.exited.then(() => { throw new Error(`Native client exited before pairing ${first.stderr}`); })]);
  assert.equal(paired.kind, 'paired');
  await acceptance;
  watcher.close();
  first.child.kill('SIGKILL');
  assert.equal((await first.exited).signal, 'SIGKILL');
  assert.equal(f.host.child.exitCode, null);
  const auth = bearer(paired.credential.secret);
  const scope = { hostId: f.hostId, conversationId: 'native-process-lifetime' };
  let receipt;
  for (let attempt = 0; attempt < 100; attempt++) {
    receipt = (await f.call('/native/v1', { op: 'receipt', scope, id: 'same-original-id' }, auth)).body.value;
    if (receipt?.state.kind === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(receipt.state.kind, 'completed');
  const second = run({ credential: paired.credential });
  const recovered = new Promise(resolve => second.child.once('message', resolve));
  assert.equal((await second.exited).code, 0, second.stderr);
  assert.deepEqual(await recovered, { kind: 'recovered', hostOperationId: receipt.hostOperationId });
  assert.equal(f.host.child.exitCode, null);
  const accepted = readFileSync(acceptedPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].evidence.identity.hostOperationId, receipt.hostOperationId);
});


test('native invitations and credentials retain exact expiry and durable revocation policy', async t => {
  const { Access } = await import('../../apps/host/build/tsc/access.js');
  const { openAccessDatabase } = await import('../../apps/host/build/tsc/access-database.js');
  const directory = mkdtempSync(join(tmpdir(), 'agentui-native-policy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'host.sqlite');
  let access = new Access(openAccessDatabase(path));
  const expired = access.invite('native', 1000);
  assert.throws(() => access.pair(expired, 'native', 301000));
  const { principal, secret } = access.pair(access.invite('native', 1000), 'native', 1000);
  assert.deepEqual(access.authenticate(secret, 'native', 1000 + 30 * 24 * 3_600_000 - 1), principal);
  assert.equal(access.authenticate(secret, 'native', 1000 + 30 * 24 * 3_600_000), null);
  access.revoke(principal.id);
  access.close();
  access = new Access(openAccessDatabase(path));
  try { assert.equal(access.authenticate(secret, 'native', 1001), null); }
  finally { access.close(); }
});
