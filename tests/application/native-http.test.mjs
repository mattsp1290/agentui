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
test('native loopback route admits the owner directly and rejects noncanonical requests', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  const metadata = await f.call('/native/v1', { op: 'metadata' });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers['set-cookie'], undefined);
  assert.equal(metadata.headers['cache-control'], 'no-store');
  assert.equal(metadata.body.value.hostId, f.hostId);
  assert.equal(metadata.body.value.principalId, 'trusted-owner');
  for (const headers of [
    { Cookie: 'agentui=1' }, { Origin: '' }, { Origin: f.origin }, { Cookie: '' },
    { Host: 'foreign.example' }, { Host: 'localhost' }, { 'Content-Type': 'application/json; charset=utf-8' }, { 'Content-Type': 'text/plain' },
  ]) denied(await f.call('/native/v1', { op: 'metadata' }, headers));
  denied(await f.call('/native/v1', { op: 'metadata' }, {}, 'PUT'));
  denied(await f.call('/api/v1', { op: 'metadata' }, {}));
  const scope = { hostId: f.hostId, conversationId: 'native-boundary' };
  for (const body of [
    { op: 'pair', code: 'a'.repeat(32) }, { op: 'metadata', secret: 'rejected' },
    { op: 'create', agentId: recordedAgentId, scope: { ...scope, extra: true } },
    { op: 'submit', command: { version: 1, scope, clientCommandId: 'invalid', body: { kind: 'send', text: 'hello', extra: true } } },
    `${' '.repeat(410_000)}{"op":"metadata"}`, '{',
  ]) denied(await f.call('/native/v1', body));
  denied(await f.call('/native/v1?secret=not-reflected', { op: 'metadata' }));
  denied(await f.call('/native/v1', { op: 'create', agentId: recordedAgentId, scope: { ...scope, hostId: 'wrong' } }), 403);
  assert.equal((await f.call('/native/v1', { op: 'create', agentId: recordedAgentId, scope })).status, 200);
  const { feedId } = (await f.call('/native/v1', { op: 'watch', scope, after: null, projectionVersion: 4 })).body.value;
  const page = (await f.call('/native/v1', { op: 'pull', feedId, ack: null })).body.value;
  assert.equal(page.item.kind, 'snapshot');
  assert.deepEqual(await f.control('devices'), []);
});

test('separate native engine processes recover one original command after client exit while the bundled host lives', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
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
  const first = run({ recover: false });
  await Promise.race([acceptance, first.exited.then(() => { throw new Error(`Native client exited before acceptance ${first.stderr}`); })]);
  watcher.close();
  first.child.kill('SIGKILL');
  assert.equal((await first.exited).signal, 'SIGKILL');
  assert.equal(f.host.child.exitCode, null);
  const scope = { hostId: f.hostId, conversationId: 'native-process-lifetime' };
  let receipt;
  for (let attempt = 0; attempt < 100; attempt++) {
    receipt = (await f.call('/native/v1', { op: 'receipt', scope, id: 'same-original-id' })).body.value;
    if (receipt?.state.kind === 'completed') break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(receipt.state.kind, 'completed');
  const second = run({ recover: true });
  const recovered = new Promise(resolve => second.child.once('message', resolve));
  assert.equal((await second.exited).code, 0, second.stderr);
  assert.deepEqual(await recovered, { kind: 'recovered', hostOperationId: receipt.hostOperationId });
  assert.equal(f.host.child.exitCode, null);
  const accepted = readFileSync(acceptedPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].evidence.identity.hostOperationId, receipt.hostOperationId);
});
