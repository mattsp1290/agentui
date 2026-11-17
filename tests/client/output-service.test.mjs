import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createBrowserConnection, ServiceError, ServiceProtocolError } from '@agentui/client/service';
import { createMacConnection } from '@agentui/client/mac';
import { createServiceConnection } from '../../packages/client/dist/service-engine.js';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { parseServiceRequest, parseServiceResponse, SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';

const scope = { hostId: 'host', conversationId: 'chat' }, outputId = `output-${'a'.repeat(64)}`;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const descriptor = bytes => ({ outputId, name: 'report.txt', mediaType: 'text/plain', byteLength: bytes.length,
  sha256: digest(bytes), lifetime: 'provider-retained' });
const readValue = (bytes = Uint8Array.of(65)) => ({ scope, outputId,
  result: { kind: 'available', output: descriptor(bytes), base64: Buffer.from(bytes).toString('base64') } });
const reply = value => Response.json({ ok: true, value });
const failures = [ { kind: 'unsupported', reason: 'outputs-unsupported' }, { kind: 'unavailable', reason: 'outputs-unavailable' },
  { kind: 'invalid', reason: 'outputs-invalid' } ];
const readOutcomes = [...failures, { kind: 'missing', reason: 'output-missing' }, readValue(new Uint8Array()).result, readValue(new TextEncoder().encode('\ufeff')).result];
const listOutcomes = [...failures, { kind: 'available', outputs: [] }, { kind: 'available', outputs: [descriptor(Uint8Array.of(65))] }];

for (const [method, op, outcomes] of [['conversationOutputs', 'output-list', listOutcomes], ['readOutput', 'output-read', readOutcomes]]) {
  test(`${method} captures owned scope before awaiting and correlates every outcome`, async () => {
    for (const result of outcomes) for (const foreign of ['none', 'hostId', 'conversationId', ...(op === 'output-read' ? ['outputId'] : [])]) {
      const pending = Promise.withResolvers(), caller = { ...scope };
      const client = createBrowserConnection({ fetch: async (path, init) => {
        assert.equal(path, '/api/v1');
        assert.deepEqual(JSON.parse(init.body), { op, scope, ...(op === 'output-read' ? { outputId } : {}) });
        return pending.promise;
      } });
      const request = client[method](caller, outputId);
      caller.hostId = 'mutated'; caller.conversationId = 'mutated';
      const value = { scope: { ...scope }, result, ...(op === 'output-read' ? { outputId } : {}) };
      if (foreign === 'outputId') value.outputId = `output-${'b'.repeat(64)}`;
      else if (foreign !== 'none') value.scope[foreign] = 'foreign';
      pending.resolve(reply(value));
      if (foreign !== 'none') await assert.rejects(request, ServiceProtocolError);
      else {
        const actual = await request;
        assert.equal(actual.kind, result.kind);
        if (result.kind !== 'available') assert.deepEqual(actual, result);
      }
    }
  });
}

test('public read owns exact zero, maximum, BOM, multibyte and control bytes on both shared adapters', async () => {
  for (const bytes of [new Uint8Array(), new Uint8Array(65_536).fill(65), new TextEncoder().encode('\ufeff'),
    new TextEncoder().encode('\ufeffé🐦\n\r\t\u0000\u001f')]) {
    const value = readValue(bytes), body = JSON.stringify({ ok: true, value });
    for (const client of [createBrowserConnection({ fetch: async () => reply(value) }),
      createMacConnection({ kind: 'ready', hostId: 'host', principalId: 'owner', observation: 'current' }, async command => {
        assert.deepEqual(command.request, { op: 'output-read', scope, outputId });
        return { status: 200, body };
      })]) {
      const a = await client.readOutput(scope, outputId), b = await client.readOutput(scope, outputId);
      assert.equal(a.kind, 'available'); assert.equal(b.kind, 'available');
      assert.deepEqual(a.bytes, bytes); assert.deepEqual(b.bytes, bytes);
      assert.notEqual(a.bytes.buffer, b.bytes.buffer); assert.notEqual(a.bytes.buffer, bytes.buffer);
      if (a.bytes.length) a.bytes[0] ^= 255;
      assert.deepEqual(b.bytes, bytes);
      assert.deepEqual((await client.readOutput(scope, outputId)).bytes, bytes);
    }
  }
});

test('public parsers reject private fields, malformed descriptors, duplicates and noncanonical bytes before decode', async t => {
  const valid = readValue(), list = { scope, result: { kind: 'available', outputs: [valid.result.output] } };
  const badReads = [
    { ...valid, private: true }, { ...valid, scope: { ...scope, private: true } },
    { ...valid, outputId: 'private-id' }, { ...valid, result: { ...valid.result, bytes: [] } },
    ...[{ name: '../report.txt' }, { mediaType: 'text/html' }, { byteLength: -1 }, { byteLength: 0.5 }, { byteLength: 65_537 },
      { sha256: 'A'.repeat(64) }, { lifetime: 'permanent' }, { outputId: `output-${'b'.repeat(64)}` }, { credential: 'private' }]
      .map(change => ({ ...valid, result: { ...valid.result, output: { ...valid.result.output, ...change } } })),
    ...['QR==', 'QQ', 'QQ==\n', 'QQ-_', '====', 'QQ==QQ==', 'A'.repeat(87_385)]
      .map(base64 => ({ ...valid, result: { ...valid.result, base64 } })),
    { ...valid, result: { kind: 'missing', reason: 'output-missing', ref: 'private' } },
    ...failures.map(result => ({ ...valid, result: { ...result, reason: 'private detail' } })),
  ];
  const decode = t.mock.method(globalThis, 'atob', () => assert.fail('Invalid envelope reached byte decoder'));
  for (const value of badReads) {
    assert.throws(() => parseServiceResponse({ op: 'output-read', scope, outputId }, { ok: true, value }));
    await assert.rejects(createBrowserConnection({ fetch: async () => reply(value) }).readOutput(scope, outputId), ServiceProtocolError);
  }
  assert.equal(decode.mock.callCount(), 0); decode.mock.restore();
  for (const value of [ { ...list, result: { ...list.result, private: true } },
    { ...list, result: { kind: 'available', outputs: Array(33).fill(list.result.outputs[0]) } },
    { ...list, result: { kind: 'available', outputs: Array(2).fill(list.result.outputs[0]) } },
    { ...list, result: { kind: 'available', outputs: null } },
    ...failures.map(result => ({ scope, result: { ...result, private: true } })),
  ]) assert.throws(() => parseServiceResponse({ op: 'output-list', scope }, { ok: true, value }));
  assert.deepEqual(parseServiceResponse({ op: 'output-list', scope }, { ok: true, value: {
    scope, result: { kind: 'available', outputs: Array.from({ length: 32 }, (_, i) => ({ ...list.result.outputs[0], outputId: `output-${i.toString(16).padStart(64, '0')}` })) },
  } }).value.result.outputs.length, 32);
});

test('completion rejects invalid UTF-8 with matching digest, wrong digest and decoded length', async t => {
  const wrongDigest = readValue();
  wrongDigest.result.output.sha256 = '0'.repeat(64);
  for (const value of [wrongDigest, ...[[255], [0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf0, 0x9f], [0xe2, 0x28, 0xa1]].map(bytes => readValue(Uint8Array.from(bytes)))]) {
    await assert.rejects(createBrowserConnection({ fetch: async () => reply(value) }).readOutput(scope, outputId), ServiceProtocolError);
  }
  const decode = t.mock.method(globalThis, 'atob', () => '');
  await assert.rejects(createBrowserConnection({ fetch: async () => reply(readValue()) }).readOutput(scope, outputId), ServiceProtocolError);
  decode.mock.restore();
});

test('output transport rejects truncated, malformed, oversized announced and streamed bodies', async () => {
  for (const response of [new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { headers: { 'Content-Type': 'text/plain' } }),
    new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/json' } }),
    new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(SERVICE_MAX_RESPONSE_BYTES + 1) } }),
    new Response(' '.repeat(SERVICE_MAX_RESPONSE_BYTES + 1), { headers: { 'Content-Type': 'application/json' } })]) {
    await assert.rejects(createBrowserConnection({ fetch: async () => response }).readOutput(scope, outputId), ServiceProtocolError);
  }
});

test('output completion stays within caller deadline and cleans its timer on success, errors and timeout', async t => {
  const active = new Set(), originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args) => { const timer = originalSet(...args); active.add(timer); return timer; });
  t.mock.method(globalThis, 'clearTimeout', timer => { active.delete(timer); return originalClear(timer); });
  const normal = createBrowserConnection({ fetch: async () => reply(readValue()) });
  await normal.readOutput(scope, outputId); assert.equal(active.size, 0);
  const decode = t.mock.method(globalThis, 'atob', () => { throw new Error('Decoder failed'); });
  await assert.rejects(normal.readOutput(scope, outputId), ServiceProtocolError); assert.equal(active.size, 0);
  decode.mock.restore();
  const slow = t.mock.method(globalThis, 'atob', value => {
    const stop = performance.now() + 15; while (performance.now() < stop) {}
    return Buffer.from(value, 'base64').toString('latin1');
  });
  await assert.rejects(createBrowserConnection({ requestTimeoutMs: 5, fetch: async () => reply(readValue()) }).readOutput(scope, outputId),
    error => error instanceof ServiceError && error.kind === 'unavailable');
  assert.equal(active.size, 0); slow.mock.restore();
  const pending = Promise.withResolvers(); let signal;
  const timed = createBrowserConnection({ requestTimeoutMs: 5, fetch: async (_url, init) => { signal = init.signal; return pending.promise; } });
  await assert.rejects(timed.readOutput(scope, outputId), error => error instanceof ServiceError && error.kind === 'unavailable');
  assert.equal(signal.aborted, true); assert.equal(active.size, 0);
  pending.resolve(reply(readValue())); await setImmediate();
});

test('TypeScript and Rust share exact output request golden cases', () => {
  const cases = JSON.parse(readFileSync(new URL('./fixtures/output-requests.json', import.meta.url)));
  for (const row of cases) {
    if (row.valid) assert.deepEqual(parseServiceRequest(row.request), row.request);
    else assert.throws(() => parseServiceRequest(row.request));
  }
});


test('public feed abort removes its request listener and settles an uncooperative executor', async t => {
  const added = new Set(), removed = new Set(), pending = Promise.withResolvers(), entered = Promise.withResolvers();
  const add = AbortSignal.prototype.addEventListener, remove = AbortSignal.prototype.removeEventListener;
  t.mock.method(AbortSignal.prototype, 'addEventListener', function(type, listener, options) {
    if (type === 'abort') added.add(listener);
    return add.call(this, type, listener, options);
  });
  t.mock.method(AbortSignal.prototype, 'removeEventListener', function(type, listener, options) {
    if (type === 'abort') removed.add(listener);
    return remove.call(this, type, listener, options);
  });
  let signal;
  const client = createServiceConnection(async (body, context) => {
    const request = JSON.parse(body);
    if (request.op === 'watch') return reply({ feedId: 'feed' });
    if (request.op === 'close') return reply(null);
    signal = context.signal; entered.resolve(); return pending.promise;
  }, transcriptProjection);
  const feed = client.conversation(scope).watch({ after: null, projectionVersion: 4 }, async () => assert.fail('Closed feed delivered'));
  await entered.promise; feed.close();
  assert.equal((await feed.ended).kind, 'closed'); assert.equal(signal.aborted, true);
  pending.resolve(reply({ kind: 'heartbeat' })); await setImmediate();
  assert.ok(added.size > 0);
  for (const listener of added) assert.ok(removed.has(listener));
});
