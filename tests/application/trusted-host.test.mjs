import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import test from 'node:test';

const root = new URL('../../', import.meta.url);

async function fixture(t, trusted) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-trusted-'));
  const processes = [];
  const f = { directory, origin: '', hostId: '' };
  f.start = async () => {
    const child = spawn(process.execPath, ['apps/host/dist/main.js', 'browser-dev', '--data-dir', directory, '--port', '0',
      ...(trusted ? ['--trusted'] : [])], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('ordinary host startup still requires pairing unless trusted access is selected', { timeout: 10_000 }, async t => {
  const f = await fixture(t, false);
  const response = await f.call({ op: 'metadata' });
  assert.equal(response.status, 401);
  assert.equal(response.body.error.kind, 'unauthorized');
});

test('trusted host creates and resumes a chat without an invitation, cookie or credential record', { timeout: 20_000 }, async t => {
  const f = await fixture(t, true);
  assert.equal((await fetch(`${f.origin}/browser.html`)).status, 200);
  const metadata = await f.ok({ op: 'metadata' });
  const staleCookie = await f.call({ op: 'metadata' }, { Cookie: `agentui_device_${metadata.hostId}=expired-pairing` });
  assert.equal(staleCookie.status, 200);
  assert.equal(staleCookie.body.value.principalId, metadata.principalId);
  const { stdout } = await promisify(execFile)(process.execPath, ['apps/host/dist/main.js', 'devices', '--data-dir', f.directory], { cwd: root });
  assert.deepEqual(JSON.parse(stdout).value, []);
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
