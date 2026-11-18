import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseServiceRequest } from '@agentui/contracts/service';
import { createCustomizationRelay } from '../../apps/host/build/tsc/customization-relay.js';
import { startBrowserHost } from './extensions/fixtures.mjs';

const head = 'a'.repeat(40);
const workerStatus = (extra = {}) => ({ connection: { location: '/srv/custom', branch: 'customization', subdirectory: 'examples/customization' },
  head, extensions: [{ key: 'extensions/a', enabled: true, namespace: 'alpha' }], settings: { version: 1, appearance: 'system', showExtensionViews: true },
  build: null, presentTokens: ['AGENTUI_EXTENSION_ALPHA_TOKEN'], ...extra });
const toggle = (requestId = randomUUID()) => parseServiceRequest({ op: 'customization-toggle', requestId, key: 'extensions/a', enabled: false, expectedHead: head });

function clocked() {
  let time = 1_000_000;
  const relay = createCustomizationRelay({ now: () => time });
  return { relay, advance: ms => { time += ms; } };
}

test('with no worker, status is worker-offline and a mutation is refused as unsupported', () => {
  const { relay } = clocked();
  const status = relay.status();
  assert.equal(status.support, 'worker-offline');
  assert.deepEqual([status.connection, status.head, status.pending, status.results], [null, null, null, []]);
  assert.deepEqual(relay.mutate(toggle()), { kind: 'refused', cause: 'unsupported' });
});

test('a queued toggle reaches the worker, a second mutation is busy, and the pushed result lands under its request ID', async () => {
  const { relay } = clocked();
  relay.push(randomUUID(), workerStatus(), []);
  assert.equal(relay.status().support, 'supported');
  const request = toggle();
  const workerId = randomUUID();
  const pulled = relay.pull(workerId, 10);
  assert.deepEqual(relay.mutate(request), { kind: 'accepted' });
  assert.deepEqual(relay.mutate(toggle()), { kind: 'refused', cause: 'busy' });
  assert.deepEqual(relay.status().pending, { requestId: request.requestId, op: 'customization-toggle' });
  const { requests } = await pulled;
  assert.deepEqual(requests, [{ op: 'toggle', requestId: request.requestId, key: 'extensions/a', enabled: false, expectedHead: head }]);
  assert.deepEqual((await relay.pull(workerId, 0)).requests, [], 'a request is delivered once');
  relay.push(workerId, workerStatus({ head: 'b'.repeat(40) }), [{ requestId: request.requestId, outcome: 'ok' }]);
  const status = relay.status();
  assert.deepEqual([status.pending, status.results, status.head], [null, [{ requestId: request.requestId, outcome: 'ok' }], 'b'.repeat(40)]);
  assert.deepEqual(relay.mutate(toggle()), { kind: 'accepted' });
});

test('a request taken by a worker that then went silent goes to the next worker, never to a live one twice', async () => {
  const { relay, advance } = clocked();
  const first = randomUUID(), second = randomUUID();
  relay.push(first, workerStatus(), []);
  const request = toggle();
  relay.mutate(request);
  assert.equal((await relay.pull(first, 0)).requests.length, 1);
  advance(5_000);
  relay.push(first, workerStatus(), []);
  assert.deepEqual((await relay.pull(second, 0)).requests, [], 'the first worker is alive');
  advance(16_000);
  assert.equal((await relay.pull(second, 0)).requests[0].requestId, request.requestId);
  assert.deepEqual((await relay.pull(second, 0)).requests, []);
});

test('worker-pull returns empty after its wait when nothing is queued', async () => {
  const { relay } = clocked();
  const started = Date.now();
  assert.deepEqual(await relay.pull(randomUUID(), 1), { requests: [] });
  assert.ok(Date.now() - started >= 900);
});

test('31 seconds without a worker call make the relay worker-offline', () => {
  const { relay, advance } = clocked();
  relay.push(randomUUID(), workerStatus(), []);
  advance(29_000);
  assert.equal(relay.status().support, 'supported');
  advance(2_000);
  const status = relay.status();
  assert.equal(status.support, 'worker-offline');
  assert.equal(status.connection.location, '/srv/custom', 'the last known connection stays readable');
  assert.deepEqual(relay.mutate(toggle()), { kind: 'refused', cause: 'unsupported' });
});

test('a pending mutation with no result for 180 seconds ends with worker-timeout and a later mutation is accepted', () => {
  const { relay, advance } = clocked();
  const workerId = randomUUID();
  relay.push(workerId, workerStatus(), []);
  const request = toggle();
  assert.deepEqual(relay.mutate(request), { kind: 'accepted' });
  for (let elapsed = 0; elapsed < 170_000; elapsed += 10_000) { advance(10_000); relay.push(workerId, workerStatus(), []); }
  advance(9_000);
  relay.push(workerId, workerStatus(), []);
  assert.notEqual(relay.status().pending, null);
  advance(1_000);
  assert.deepEqual(relay.status().results, [{ requestId: request.requestId, outcome: 'worker-timeout' }]);
  assert.equal(relay.status().pending, null);
  assert.deepEqual(relay.mutate(toggle()), { kind: 'accepted' });
});

test('a result for an unknown request ID is stored, and the ring keeps the last 32', () => {
  const { relay } = clocked();
  const unknown = randomUUID();
  relay.push(randomUUID(), workerStatus(), [{ requestId: unknown, outcome: 'conflict' }]);
  assert.deepEqual(relay.status().results, [{ requestId: unknown, outcome: 'conflict' }]);
  const ids = Array.from({ length: 40 }, () => randomUUID());
  for (const requestId of ids) relay.push(randomUUID(), workerStatus(), [{ requestId, outcome: 'ok' }]);
  assert.deepEqual(relay.status().results.map(item => item.requestId), ids.slice(-32));
});

test('apply is refused as not-ready until the restart path exists', () => {
  const { relay } = clocked();
  relay.push(randomUUID(), workerStatus(), []);
  assert.deepEqual(relay.mutate(parseServiceRequest({ op: 'customization-apply', requestId: randomUUID(), buildKey: 'c'.repeat(64) })), { kind: 'refused', cause: 'not-ready' });
});

async function host(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-relay-'));
  const running = await startBrowserHost({ agentStartup: { kind: 'recorded' }, directory, port: 0, assetsDirectory: fileURLToPath(new URL('../../apps/desktop/web-dist-browser', import.meta.url)),
    extensions: { kind: 'transient', entries: [] } });
  t.after(async () => { await running.close(); await rm(directory, { recursive: true, force: true }); });
  const call = (body, path = '/api/v1') => fetch(`${running.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: running.origin },
    body: typeof body === 'string' ? body : JSON.stringify(body) }).then(async response => ({ status: response.status, body: await response.json() }));
  return { running, directory, call };
}

test('a real host relays through HTTP: worker operations use the worker route, status reaches clients, and bounds hold', async t => {
  const { call, directory } = await host(t);
  assert.equal(((await stat(join(directory, 'customization'))).mode & 0o777), 0o700);
  const workerId = randomUUID();
  const offline = await call({ op: 'customization-status' });
  assert.equal(offline.body.value.support, 'worker-offline');
  assert.equal((await call({ op: 'customization-worker-pull', workerId, waitSeconds: 0 })).body.ok, false, 'the client route refuses worker operations');
  assert.equal((await call({ op: 'customization-status' }, '/api/v1/worker')).body.ok, false, 'the worker route refuses client operations');
  // 256 extensions and a 3,000-byte remote key fit.
  const extensions = Array.from({ length: 256 }, (_, index) => ({ key: `${'r'.repeat(2_990)}#${index}`, enabled: index % 2 === 0, namespace: null }));
  const pushed = await call({ op: 'customization-worker-push', workerId, status: workerStatus({ extensions }), results: [] }, '/api/v1/worker');
  assert.deepEqual(pushed.body, { ok: true, value: { ok: true } });
  const status = await call({ op: 'customization-status' });
  assert.equal(status.body.value.support, 'supported');
  assert.equal(status.body.value.extensions.length, 256);
  const requestId = randomUUID();
  assert.deepEqual((await call({ op: 'customization-toggle', requestId, key: `${'r'.repeat(2_990)}#0`, enabled: false, expectedHead: head })).body,
    { ok: true, value: { kind: 'accepted' } });
  const pulled = await call({ op: 'customization-worker-pull', workerId, waitSeconds: 1 }, '/api/v1/worker');
  assert.equal(pulled.body.value.requests[0].requestId, requestId);
  // An over-size worker status is rejected.
  // Each key is within its byte bound, but quotes double in JSON, so the serialized status passes 1,000,000 bytes.
  const huge = Array.from({ length: 256 }, (_, index) => ({ key: `${'"'.repeat(2_000)}${index}`, enabled: true, namespace: null }));
  const body = JSON.stringify({ op: 'customization-worker-push', workerId, status: workerStatus({ extensions: huge }), results: [] });
  assert.ok(body.length > 1_000_000 && body.length < 1_064_000);
  const oversize = await call(body, '/api/v1/worker');
  assert.equal(oversize.body.ok, false);
  assert.equal((await call({ op: 'customization-worker-push', workerId, status: { ...workerStatus(), token: 'x' }, results: [] }, '/api/v1/worker')).body.ok, false);
});
