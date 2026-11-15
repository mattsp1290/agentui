import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { CodexRpc } from '../../packages/host/dist/codex-rpc.js';

function connection(t, mode = 'normal', callbacks = {}) {
  const notifications = [], requests = [], closes = [];
  const rpc = new CodexRpc({
    executable: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/codex-rpc-child.mjs', import.meta.url)), mode],
    cwd: process.cwd(),
    onNotification(method, params) {
      notifications.push({ method, params });
      callbacks.onNotification?.(method, params);
    },
    onRequest(id, method, params) { requests.push({ id, method, params }); },
    onClose(error) { closes.push(error); callbacks.onClose?.(error); },
  });
  t.after(() => rpc.close());
  return { rpc, notifications, requests, closes };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await delay(20);
  }
  assert.fail('Timed out waiting for fixture');
}

test('frames split UTF-8 and coalesced NDJSON, matching out-of-order numeric replies', { timeout: 4000 }, async t => {
  const { rpc, notifications } = connection(t);
  const first = rpc.request('reorder', { value: 'first' });
  const second = rpc.request('reorder', { value: 'second' });
  assert.deepEqual(await Promise.all([first, second]), [{ value: 'first' }, { value: 'second' }]);
  assert.deepEqual(notifications, [{ method: 'delta', params: { text: 'hello 🌍' } }]);
  assert.match(rpc.processId, /^[\da-f]{8}-[\da-f-]{27}$/);
});

test('preserves exact string and numeric server IDs and flushes responses', { timeout: 4000 }, async t => {
  const { rpc, requests, notifications } = connection(t);
  const ids = ['17', 17, 0, ''];
  await rpc.request('serverRequests', ids);
  assert.deepEqual(requests.map(request => request.id), ids);
  assert.ok(requests.every(request => request.method === 'approval'));
  for (const id of ids) await rpc.respond(id, { approved: true });
  await until(() => notifications.length === ids.length);
  assert.deepEqual(notifications.map(notification => notification.params),
    ids.map(id => ({ id, result: { approved: true } })));
});

test('rejects an unknown server method using JSON-RPC method-not-found', { timeout: 4000 }, async t => {
  const { rpc, notifications } = connection(t);
  await rpc.request('serverRequests', ['unknown-request']);
  rpc.rejectRequest('unknown-request', 'Unsupported server method');
  await until(() => notifications.length === 1);
  assert.deepEqual(notifications[0].params, {
    id: 'unknown-request', error: { code: -32601, message: 'Unsupported server method' },
  });
});

test('does not confuse string replies with numeric outgoing request IDs', { timeout: 4000 }, async t => {
  const { rpc } = connection(t);
  assert.equal(await rpc.request('stringReply', null), 'numeric id');
  await assert.rejects(rpc.request('remoteError', null), /Invalid fixture input/);
  assert.equal(await rpc.request('echo', 'still usable'), 'still usable');
});

test('writes client notifications without allocating a request ID', { timeout: 4000 }, async t => {
  const { rpc, notifications } = connection(t);
  rpc.notify('notify', { initialized: true });
  await until(() => notifications.length === 1);
  assert.deepEqual(notifications, [{ method: 'notificationReceived',
    params: { method: 'notify', params: { initialized: true } } }]);
  assert.equal(await rpc.request('echo', 'usable'), 'usable');
});

test('child exit rejects all pending work and reports closure once without stderr', { timeout: 4000 }, async t => {
  const { rpc, closes } = connection(t, 'exit');
  const pending = [rpc.request('wait', null), rpc.request('break', null)];
  const outcomes = await Promise.allSettled(pending);
  assert.ok(outcomes.every(outcome => outcome.status === 'rejected'));
  assert.equal(closes.length, 1);
  assert.doesNotMatch(closes[0].message, /credential-like/);
  rpc.close();
  assert.equal(closes.length, 1);
  await assert.rejects(rpc.respond('closed-request', true), /closed/);
});

for (const mode of ['malformed', 'bad-id', 'bad-method', 'bad-response', 'oversize', 'callback']) {
  test(`${mode} closes the connection, rejects requests, and terminates the child`, { timeout: 5000 }, async t => {
    const { rpc, notifications, closes } = connection(t, mode, {
      onNotification(method) { if (method === 'throw') throw new Error('consumer failure'); },
    });
    const pending = rpc.request('wait', null);
    const broken = rpc.request('break', null);
    const outcomes = await Promise.allSettled([pending, broken]);
    assert.ok(outcomes.every(outcome => outcome.status === 'rejected'));
    assert.equal(closes.length, 1);
    const pid = notifications.find(notification => notification.method === 'pid').params;
    await until(() => {
      try { process.kill(pid, 0); return false; }
      catch (error) { if (error.code === 'ESRCH') return true; throw error; }
    });
  });
}

test('intentional close is idempotent and rejects pending requests', { timeout: 4000 }, async t => {
  const { rpc, closes } = connection(t);
  await rpc.request('echo', 'ready');
  const pending = rpc.request('wait', null);
  rpc.close();
  rpc.close();
  await assert.rejects(pending, /connection closed/);
  await assert.rejects(rpc.request('echo', null), /connection closed/);
  assert.equal(closes.length, 1);
});

test('spawn failure closes cleanly even when the close callback throws', { timeout: 4000 }, async () => {
  const closes = [];
  const rpc = new CodexRpc({
    executable: '/agentui-fixture/missing-codex', cwd: process.cwd(),
    onNotification() {}, onRequest() {},
    onClose(error) { closes.push(error); throw new Error('consumer failure'); },
  });
  await assert.rejects(rpc.request('echo', null), /Codex/);
  assert.equal(closes.length, 1);
  rpc.close();
});
