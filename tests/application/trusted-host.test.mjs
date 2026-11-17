import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import test from 'node:test';
import { hostRequest } from './support/host-process.mjs';

const root = new URL('../../', import.meta.url);

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-trusted-'));
  const processes = [];
  const f = { directory, origin: '', hostId: '' };
  f.start = async () => {
    const child = spawn(process.execPath, ['apps/host/dist/main.js', 'browser-dev', '--data-dir', directory, '--port', '0'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const lines = createInterface({ input: child.stdout });
    const ready = new Promise((resolve, reject) => {
      child.once('error', reject);
      lines.once('line', line => {
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      });
      void exited.then(result => reject(new Error(`Host exited before startup ${JSON.stringify(result)} ${stderr}`)));
    });
    const running = { child, exited };
    processes.push(running);
    const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { Object.assign(f, await ready); }
    finally { clearTimeout(deadline); lines.close(); }
    f.stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { assert.equal((await exited).code, 0, stderr); }
      finally { clearTimeout(timer); }
    };
  };
  t.after(async () => {
    await Promise.all(processes.map(async ({ child, exited }) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }));
    rmSync(directory, { recursive: true, force: true });
  });
  f.call = async (body, headers = {}) => {
    const response = await fetch(`${f.origin}/api/v1`, {
      method: 'POST', headers: { Origin: f.origin, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.headers.get('set-cookie'), null);
    return { status: response.status, body: await response.json() };
  };
  f.ok = async body => {
    const response = await f.call(body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    return response.body.value;
  };
  await f.start();
  return f;
}

test('default host startup admits browser and native requests directly without pairing', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const browser = await f.call({ op: 'metadata' });
  assert.equal(browser.status, 200, JSON.stringify(browser.body));
  assert.equal(browser.body.value.hostId, f.hostId);
  assert.equal(browser.body.value.principalId, 'trusted-owner');
  const native = await hostRequest(f.origin, '/native/v1', { op: 'metadata' });
  assert.equal(native.status, 200, JSON.stringify(native.body));
  assert.equal(native.body.value.principalId, 'trusted-owner');
  assert.equal(native.headers['set-cookie'], undefined);
  const staleBearer = await hostRequest(f.origin, '/native/v1', { op: 'metadata' }, { Authorization: 'Bearer stale-device-secret' });
  assert.equal(staleBearer.status, 200, JSON.stringify(staleBearer.body));
});

test('direct access still rejects foreign Host, Origin, content type and native cookies', { timeout: 10_000 }, async t => {
  const f = await fixture(t);
  const port = new URL(f.origin).port;
  const rejected = async (path, headers) => {
    const response = await hostRequest(f.origin, path, { op: 'metadata' }, headers);
    assert.equal(response.status, 400, `${path} ${JSON.stringify(headers)} ${JSON.stringify(response.body)}`);
    assert.equal(response.body.ok, false);
  };
  await rejected('/api/v1', { Origin: 'http://evil.example' });
  await rejected('/api/v1', {});
  await rejected('/api/v1', { Origin: f.origin, Host: `localhost:${port}` });
  await rejected('/api/v1', { Origin: f.origin, 'Content-Type': 'text/plain' });
  await rejected('/native/v1', { Host: `evil.example:${port}` });
  await rejected('/native/v1', { Origin: f.origin });
  await rejected('/native/v1', { Cookie: 'agentui=1' });
  await rejected('/native/v1', { 'Content-Type': 'text/plain' });
});

test('default host creates and resumes a chat without an invitation, cookie or credential record', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.origin}/browser.html`)).status, 200);
  const metadata = await f.ok({ op: 'metadata' });
  const staleCookie = await f.call({ op: 'metadata' }, { Cookie: `agentui_device_${metadata.hostId}=expired-pairing` });
  assert.equal(staleCookie.status, 200);
  assert.equal(staleCookie.body.value.principalId, metadata.principalId);
  for (const command of ['invite', 'invite-native', 'devices', 'revoke']) {
    await assert.rejects(promisify(execFile)(process.execPath, ['apps/host/dist/main.js', command, '--data-dir', f.directory], { cwd: root }), /Use serve/);
  }
  const scope = { hostId: metadata.hostId, conversationId: 'trusted-conversation' };
  const catalog = { op: 'catalog', after: null, limit: 100 };
  assert.equal(metadata.hostId, f.hostId);
  assert.deepEqual(await f.ok(catalog), []);
  const foreign = await f.call({ op: 'create', agentId: metadata.defaultAgentId, scope: { ...scope, hostId: 'another-host' } });
  assert.equal(foreign.status, 403);
  assert.deepEqual(await f.ok({ op: 'create', agentId: metadata.defaultAgentId, scope }), scope);
  const submitted = await f.ok({ op: 'submit', command: { version: 1, scope, clientCommandId: 'trusted-send',
    body: { kind: 'send', text: 'Keep this chat across host restarts.' } } });
  assert.equal(submitted.kind, 'receipt');
  assert.equal(submitted.receipt.state.kind, 'completed');
  const { feedId } = await f.ok({ op: 'watch', scope, after: null, projectionVersion: 4 });
  const page = await f.ok({ op: 'pull', feedId, ack: null });
  assert.equal(page.item.kind, 'snapshot');
  assert.ok(page.item.snapshot.document.domain.messages.some(message => message.role === 'user' && message.text === 'Keep this chat across host restarts.'));
  await f.ok({ op: 'close', feedId });
  assert.deepEqual((await f.ok(catalog)).map(entry => entry.scope), [scope]);
  await f.stop();
  await f.start();
  const reopened = await f.ok({ op: 'metadata' });
  assert.equal(reopened.hostId, metadata.hostId);
  assert.equal(reopened.principalId, metadata.principalId);
  assert.deepEqual((await f.ok(catalog)).map(entry => entry.scope), [scope]);
  const receipt = await f.ok({ op: 'receipt', scope, id: 'trusted-send' });
  assert.equal(receipt.hostOperationId, submitted.receipt.hostOperationId);
  assert.equal(receipt.state.kind, 'completed');
  assert.equal(readFileSync(join(f.directory, 'recorded.jsonl'), 'utf8').trim().split('\n').length, 1);
});
