import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { createBrowserConnection } from '@agentui/client/service';

const root = new URL('../../', import.meta.url);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const command = (scope, id = 'send-once') => ({ version: 1, scope, clientCommandId: id,
  body: { kind: 'send', text: 'Keep this exact command through a lost reply.' } });

function childProcess(args) {
  const child = spawn(process.execPath, ['apps/host/dist/main.js', ...args], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, exited, get stderr() { return stderr; } };
}
async function stop(process) {
  if (process.child.exitCode !== null || process.child.signalCode !== null) return;
  process.child.kill('SIGTERM');
  const timer = setTimeout(() => process.child.kill('SIGKILL'), 1000);
  try { await process.exited; } finally { clearTimeout(timer); }
}
async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-http-'));
  const children = [];
  const requests = new Set();
  const f = { directory, origin: '', hostId: '', process: null };
  t.after(async () => {
    for (const request of requests) request.destroy();
    await Promise.all(children.map(stop));
    rmSync(directory, { recursive: true, force: true });
  });
  f.launch = args => {
    const process = childProcess(args);
    children.push(process);
    return process;
  };
  f.start = async (port = 0) => {
    const process = f.launch(['browser-dev', '--data-dir', directory, '--port', String(port)]);
    f.process = process;
    const lines = createInterface({ input: process.child.stdout });
    const ready = new Promise((resolve, reject) => {
      process.child.once('error', reject);
      lines.once('line', line => {
        try { resolve(JSON.parse(line)); } catch (error) { reject(error); }
      });
      void process.exited.then(result => reject(new Error(`Host exited before readiness ${JSON.stringify(result)} ${process.stderr}`)));
    });
    const timer = setTimeout(() => process.child.kill('SIGKILL'), 5000);
    try {
      const value = await ready;
      assert.equal(value.mode, 'browser-development');
      assert.match(value.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal(typeof value.hostId, 'string');
      Object.assign(f, { origin: value.origin, hostId: value.hostId });
    } finally { clearTimeout(timer); lines.close(); }
  };
  f.control = async (op, id) => {
    const process = f.launch([op, '--data-dir', directory, ...(id ? ['--id', id] : [])]);
    let stdout = '';
    process.child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    const timer = setTimeout(() => process.child.kill('SIGKILL'), 5000);
    try {
      const result = await process.exited;
      assert.equal(result.code, 0, process.stderr);
      const response = JSON.parse(stdout);
      assert.equal(response.ok, true);
      return response.value;
    } finally { clearTimeout(timer); }
  };
  f.begin = (body, cookie = '', headers = {}) => {
    const sent = deferred();
    let request;
    const response = new Promise((resolve, reject) => {
      request = httpRequest(`${f.origin}/api/v1`, { method: 'POST', headers: {
        Origin: f.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers,
      } }, incoming => {
        let text = '';
        incoming.setEncoding('utf8').on('data', chunk => { text += chunk; });
        incoming.once('error', reject);
        incoming.once('end', () => {
          try { resolve({ status: incoming.statusCode, headers: incoming.headers, body: JSON.parse(text) }); }
          catch (error) { reject(error); }
        });
      });
      requests.add(request);
      request.once('close', () => requests.delete(request));
      request.once('error', reject);
      request.once('finish', sent.resolve);
      request.setTimeout(12_000, () => request.destroy(new Error('HTTP request deadline exceeded')));
      request.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    return { response, sent: sent.promise,
      disconnect: () => request.destroy(new Error('Client disconnected before receiving a reply')) };
  };
  f.call = (body, cookie, headers) => f.begin(body, cookie, headers).response;
  f.ok = async (body, cookie) => {
    const response = await f.call(body, cookie);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ok, true);
    return response.body.value;
  };
  f.pair = async () => {
    const { code } = await f.control('invite');
    const response = await f.call({ op: 'pair', code });
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    const setCookie = response.headers['set-cookie'][0];
    assert.match(setCookie, /HttpOnly; SameSite=Strict; Path=\//);
    const cookie = setCookie.split(';')[0];
    const metadata = await f.ok({ op: 'metadata' }, cookie);
    return { code, cookie, metadata };
  };
  await f.start();
  return f;
}
function denied(response, status = 400, kind = 'invalid') {
  assert.equal(response.status, status);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.kind, kind);
  assert.equal('value' in response.body, false);
  assert.equal(JSON.stringify(response.body).includes('hostId'), false);
  assert.equal(JSON.stringify(response.body).includes('compatibility'), false);
}

test('real host pairs independent devices and protects metadata, scope and explicit catalog creation', { timeout: 20_000 }, async t => {
  const f = await fixture(t);
  denied(await f.call({ op: 'metadata' }), 401, 'unauthorized');
  const alice = await f.pair(), bob = await f.pair();
  assert.equal(alice.metadata.hostId, f.hostId);
  assert.equal(bob.metadata.hostId, f.hostId);
  assert.notEqual(alice.metadata.principalId, bob.metadata.principalId);
  assert.notEqual(alice.cookie, bob.cookie);
  denied(await f.call({ op: 'pair', code: alice.code }), 401, 'unauthorized');
  for (const [body, headers] of [
    [{ op: 'metadata' }, { Origin: 'https://foreign.example' }],
    [{ op: 'metadata' }, { Host: 'foreign.example' }],
    [{ op: 'metadata', leak: true }, {}],
    [[], {}], ['{', {}], [`${' '.repeat(410_000)}{"op":"metadata"}`, {}],
  ]) denied(await f.call(body, alice.cookie, headers));
  const catalog = { op: 'catalog', after: null, limit: 100 };
  assert.deepEqual(await f.ok(catalog, alice.cookie), []);
  assert.deepEqual(await f.ok(catalog, bob.cookie), []);
  const scope = { hostId: f.hostId, conversationId: 'stable-explicit-conversation' };
  const foreign = { ...scope, hostId: 'another-host' };
  for (const request of [{ op: 'create', scope: foreign },
    { op: 'watch', scope: foreign, after: null, projectionVersion: 1 },
    { op: 'submit', command: command(foreign) }, { op: 'receipt', scope: foreign, id: 'send-once' }]) {
    denied(await f.call(request, alice.cookie), 401, 'unauthorized');
  }
  assert.deepEqual(await f.ok(catalog, alice.cookie), []);
  assert.deepEqual(await f.ok({ op: 'create', scope }, alice.cookie), scope);
  assert.deepEqual(await f.ok({ op: 'create', scope }, bob.cookie), scope);
  assert.deepEqual(await f.ok(catalog, bob.cookie), [scope]);
  assert.deepEqual(await f.ok({ ...catalog, after: scope.conversationId }, alice.cookie), []);
  assert.deepEqual((await f.control('devices')).map(item => item.id).sort(),
    [alice.metadata.principalId, bob.metadata.principalId].sort());
});

test('real client applies a feed page before ACK and the host retains lost replies and rejects future ACKs', { timeout: 20_000 }, async t => {
  const f = await fixture(t), alice = await f.pair(), bob = await f.pair();
  const scope = { hostId: f.hostId, conversationId: 'application-ack' };
  await f.ok({ op: 'create', scope }, alice.cookie);
  const first = deferred(), second = deferred(), releaseFirst = deferred(), releaseSecond = deferred();
  const trace = [];
  const connection = createBrowserConnection({ fetch: async (url, init) => {
    const request = JSON.parse(init.body);
    const response = await fetch(new URL(url, f.origin), { ...init,
      headers: { ...init.headers, Origin: f.origin, Cookie: alice.cookie } });
    trace.push({ request, response: await response.clone().json() });
    return response;
  } });
  let deliveries = 0;
  const feed = connection.conversation(scope).watch({ after: null, projectionVersion: 1 }, async item => {
    deliveries++;
    if (deliveries === 1) { first.resolve(item); await releaseFirst.promise; }
    if (deliveries === 2) { second.resolve(item); await releaseSecond.promise; }
  });
  t.after(() => { releaseFirst.resolve(); releaseSecond.resolve(); feed.close(); });
  assert.equal((await first.promise).kind, 'snapshot');
  const feedId = trace.find(item => item.request.op === 'watch').response.value.feedId;
  const pull = ack => ({ op: 'pull', feedId, ack });
  const pageOne = await f.ok(pull(null), alice.cookie);
  assert.equal(pageOne.page, 1);
  denied(await f.call(pull(null), bob.cookie));
  const submitted = await connection.conversation(scope).submit(command(scope));
  assert.equal(submitted.receipt.state.kind, 'completed');
  assert.deepEqual(await f.ok(pull(null), alice.cookie), pageOne);
  assert.equal(trace.filter(item => item.request.op === 'pull').length, 1);
  denied(await f.call(pull(99), alice.cookie));
  assert.deepEqual(await f.ok(pull(null), alice.cookie), pageOne);
  releaseFirst.resolve();
  assert.equal((await second.promise).kind, 'events');
  const pageTwo = trace.filter(item => item.request.op === 'pull').at(-1).response.value;
  assert.equal(pageTwo.page, 2);
  assert.deepEqual(await f.ok(pull(1), alice.cookie), pageTwo);
  assert.deepEqual(await f.ok(pull(1), alice.cookie), pageTwo);
  assert.deepEqual(await f.ok(pull(null), alice.cookie), pageTwo);
  assert.equal(deliveries, 2);
  feed.close();
  releaseSecond.resolve();
  assert.equal((await feed.ended).kind, 'closed');
});

test('revoking a device wakes its open HTTP pull and denies later operations while another device continues', { timeout: 20_000 }, async t => {
  const f = await fixture(t), alice = await f.pair(), bob = await f.pair();
  const scope = { hostId: f.hostId, conversationId: 'revoke-open-pull' };
  await f.ok({ op: 'create', scope }, alice.cookie);
  const { feedId } = await f.ok({ op: 'watch', scope, after: null, projectionVersion: 1 }, alice.cookie);
  const first = await f.ok({ op: 'pull', feedId, ack: null }, alice.cookie);
  let settled = false;
  const pending = f.begin({ op: 'pull', feedId, ack: first.page }, alice.cookie);
  void pending.response.then(() => { settled = true; }, () => { settled = true; });
  await pending.sent;
  await f.ok({ op: 'metadata' }, bob.cookie);
  assert.equal(settled, false);
  await f.control('revoke', alice.metadata.principalId);
  denied(await pending.response, 401, 'unauthorized');
  for (const request of [{ op: 'metadata' }, { op: 'catalog', after: null, limit: 100 },
    { op: 'watch', scope, after: null, projectionVersion: 1 }, { op: 'submit', command: command(scope) },
    { op: 'create', scope }, { op: 'receipt', scope, id: 'send-once' }]) {
    denied(await f.call(request, alice.cookie), 401, 'unauthorized');
  }
  assert.equal((await f.ok({ op: 'metadata' }, bob.cookie)).principalId, bob.metadata.principalId);
  assert.equal((await f.ok({ op: 'submit', command: command(scope) }, bob.cookie)).receipt.state.kind, 'completed');
  assert.deepEqual(await f.control('devices'), [
    { id: alice.metadata.principalId, revoked: true }, { id: bob.metadata.principalId, revoked: false },
  ].sort((a, b) => a.id.localeCompare(b.id)));
});

test('fixed-port process restart preserves device identity, catalog and evidence with one acceptance on exact-ID retry', { timeout: 20_000 }, async t => {
  const f = await fixture(t), alice = await f.pair();
  const origin = f.origin, hostId = f.hostId;
  const scope = { hostId, conversationId: 'restart-evidence' }, intent = command(scope);
  await f.ok({ op: 'create', scope }, alice.cookie);
  const connection = createBrowserConnection({ fetch: async (url, init) => {
    const response = await fetch(new URL(url, f.origin), { ...init,
      headers: { ...init.headers, Origin: f.origin, Cookie: alice.cookie } });
    if (JSON.parse(init.body).op === 'submit') {
      await response.arrayBuffer();
      throw new Error('Accepted command reply lost before application receipt');
    }
    return response;
  } });
  await assert.rejects(connection.conversation(scope).submit(intent), /reply lost/);
  const receipt = await f.ok({ op: 'receipt', scope, id: intent.clientCommandId }, alice.cookie);
  assert.equal(receipt.state.kind, 'completed');
  const snapshot = async () => {
    const { feedId } = await f.ok({ op: 'watch', scope, after: null, projectionVersion: 1 }, alice.cookie);
    const page = await f.ok({ op: 'pull', feedId, ack: null }, alice.cookie);
    await f.ok({ op: 'close', feedId }, alice.cookie);
    assert.equal(page.item.kind, 'snapshot');
    return page.item.snapshot;
  };
  const before = await snapshot();
  assert.equal(before.document.domain.messages[0].text, intent.body.text);
  assert.ok(before.document.domain.messages.every(message => message.complete));
  assert.equal(Object.keys(before.document.decisions).length, 1);
  const accepted = () => readFileSync(join(f.directory, 'recorded.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(accepted().length, 1);
  assert.equal(accepted()[0].evidence.identity.hostOperationId, receipt.hostOperationId);
  await stop(f.process);
  await f.start(Number(new URL(origin).port));
  assert.equal(f.origin, origin);
  assert.equal(f.hostId, hostId);
  assert.deepEqual(await f.ok({ op: 'metadata' }, alice.cookie), alice.metadata);
  assert.deepEqual(await f.ok({ op: 'catalog', after: null, limit: 100 }, alice.cookie), [scope]);
  assert.deepEqual(await f.ok({ op: 'receipt', scope, id: intent.clientCommandId }, alice.cookie), receipt);
  assert.deepEqual(await snapshot(), before);
  assert.deepEqual((await f.ok({ op: 'submit', command: intent }, alice.cookie)).receipt, receipt);
  assert.deepEqual(await snapshot(), before);
  assert.equal(accepted().length, 1);
});

test('SIGTERM during playback retains exclusive process ownership until the accepted command drains', { timeout: 20_000 }, async t => {
  const f = await fixture(t), alice = await f.pair();
  const scope = { hostId: f.hostId, conversationId: 'shutdown-drain' }, intent = command(scope);
  await f.ok({ op: 'create', scope }, alice.cookie);
  const acceptance = deferred(), path = join(f.directory, 'recorded.jsonl');
  const watcher = watch(f.directory, () => {
    if (existsSync(path) && readFileSync(path, 'utf8').trim()) acceptance.resolve();
  });
  t.after(() => watcher.close());
  const submitted = f.begin({ op: 'submit', command: intent }, alice.cookie);
  await acceptance.promise;
  watcher.close();
  const lostReply = assert.rejects(submitted.response, /Client disconnected/);
  submitted.disconnect();
  await lostReply;
  await f.ok({ op: 'metadata' }, alice.cookie);
  const original = f.process, origin = f.origin, hostId = f.hostId;
  original.child.kill('SIGTERM');
  const contender = f.launch(['browser-dev', '--data-dir', f.directory, '--port', '0']);
  const result = await contender.exited;
  assert.equal(result.code, 1);
  assert.match(contender.stderr, /Another host owns this data directory/);
  assert.equal((await original.exited).code, 0, original.stderr);
  await f.start(Number(new URL(origin).port));
  assert.equal(f.hostId, hostId);
  assert.equal((await f.ok({ op: 'receipt', scope, id: intent.clientCommandId }, alice.cookie)).state.kind, 'completed');
  assert.equal((await f.ok({ op: 'submit', command: intent }, alice.cookie)).receipt.state.kind, 'completed');
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 1);
});
