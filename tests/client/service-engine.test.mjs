import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { projection, events, scope as textScope, snapshot as textSnapshot } from './support.mjs';
import { createServiceConnection } from '../../packages/client/dist/service-engine.js';
import { ServiceError, ServiceProtocolError } from '@agentui/client/service';

const scope = { hostId: 'host', conversationId: 'conversation' };
const snapshot = { kind: 'snapshot', snapshot: { scope, projectionVersion: 3, cursor: 0,
  document: { domain: { messages: [] }, receipts: {}, decisions: {} } } };
const reply = value => Response.json({ ok: true, value });
const unauthorized = () => Response.json({ ok: false, error: { kind: 'unauthorized', message: 'Expired' } }, { status: 401 });
const until = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await setImmediate(); }
  assert.fail('Expected asynchronous operation did not complete');
};

test('shared engine bounds an executor that ignores abort and ignores its late unauthorized reply', async () => {
  const pending = Promise.withResolvers();
  let signal, notifications = 0;
  const connection = createServiceConnection(async (_body, context) => {
    signal = context.signal;
    return pending.promise;
  }, transcriptProjection, { requestTimeoutMs: 10, onUnauthorized: () => notifications++ });
  await assert.rejects(connection.metadata(), error => error instanceof ServiceError && /timed out/.test(error.message));
  assert.equal(signal.aborted, true);
  pending.resolve(unauthorized());
  await setImmediate();
  assert.equal(notifications, 0);
});

test('shared engine fences old unauthorized envelopes and adapter errors across pairing', async () => {
  for (const adapterError of [false, true]) {
    const pending = Promise.withResolvers();
    let notifications = 0, calls = 0;
    const connection = createServiceConnection(async encoded => {
      const request = JSON.parse(encoded);
      if (request.op === 'pair') return reply(null);
      return ++calls === 1 ? pending.promise : unauthorized();
    }, transcriptProjection, { onUnauthorized: () => notifications++ });
    const old = connection.metadata();
    await connection.pair('replacement');
    if (adapterError) pending.reject(new ServiceError('unauthorized', 'Expired'));
    else pending.resolve(unauthorized());
    await assert.rejects(old, error => error.kind === 'unauthorized');
    assert.equal(notifications, 0);
    await assert.rejects(connection.metadata(), error => error.kind === 'unauthorized');
    assert.equal(notifications, 1);
  }
});

test('shared engine validates before execution and never retries a failed command', async () => {
  let calls = 0, sent;
  const connection = createServiceConnection(async (body, context) => { sent = { body, op: context.op }; calls++; throw new Error('Lost reply'); }, transcriptProjection);
  const port = connection.conversation(scope);
  const command = { version: 1, scope, clientCommandId: 'original', body: { kind: 'send', text: 'Hello' } };
  const invalid = await port.submit({ ...command, body: { kind: 'send', text: '🙂'.repeat(20000) } });
  assert.equal(invalid.kind, 'rejected');
  assert.equal(calls, 0);
  await assert.rejects(port.submit(command), /Lost reply/);
  assert.equal(calls, 1);
  assert.equal(typeof sent.body, 'string');
  assert.equal(sent.op, 'submit');
  assert.deepEqual(JSON.parse(sent.body), { op: 'submit', command });
  const malformed = createServiceConnection(async () => reply({}), transcriptProjection);
  await assert.rejects(malformed.metadata(), error => error instanceof ServiceProtocolError);
});

test('shared feed applies before ACK, deduplicates pages, and refuses a sequence gap', async () => {
  const applying = Promise.withResolvers(), acks = [], received = [];
  let closed = 0;
  const pages = [1, 1, 3];
  const connection = createServiceConnection(async encoded => {
    const request = JSON.parse(encoded);
    if (request.op === 'watch') return reply({ feedId: 'feed' });
    if (request.op === 'close') { closed++; return reply(null); }
    acks.push(request.ack);
    return reply({ kind: 'page', page: pages.shift(), item: snapshot });
  }, transcriptProjection);
  const feed = connection.conversation(scope).watch({ after: null, projectionVersion: 3 }, async item => {
    received.push(item); await applying.promise;
  });
  await until(() => received.length === 1);
  assert.deepEqual(acks, [null]);
  applying.resolve();
  assert.equal((await feed.ended).kind, 'resync');
  assert.deepEqual(acks, [null, 1, 1]);
  assert.equal(received.length, 1);
  assert.equal(closed, 1);
});

test('shared feed close cancels an uncooperative pull and never ACKs after close during apply', async () => {
  for (const duringApply of [false, true]) {
    const gate = Promise.withResolvers();
    let signal, pulls = 0, applying = false, closed = 0;
    const connection = createServiceConnection(async (encoded, context) => {
      const request = JSON.parse(encoded);
      if (request.op === 'watch') return reply({ feedId: 'feed' });
      if (request.op === 'close') { closed++; return reply(null); }
      pulls++; signal = context.signal;
      return duringApply ? reply({ kind: 'page', page: 1, item: snapshot }) : gate.promise;
    }, transcriptProjection);
    const feed = connection.conversation(scope).watch({ after: null, projectionVersion: 3 }, async () => {
      applying = true; await gate.promise;
    });
    await until(() => duringApply ? applying : pulls === 1);
    feed.close(); feed.close();
    assert.equal((await feed.ended).kind, 'closed');
    if (!duringApply) assert.equal(signal.aborted, true);
    gate.resolve(reply({ kind: 'heartbeat' }));
    await setImmediate();
    assert.equal(pulls, 1);
    assert.equal(closed, 1);
  }
});

test('shared engine decodes an independent projection before delivery and ACK', async () => {
  const items = [textSnapshot(0, 'start'), events([1, ' next'])], acks = [], received = [];
  const connection = createServiceConnection(async encoded => {
    const request = JSON.parse(encoded);
    if (request.op === 'watch') return reply({ feedId: 'feed' });
    if (request.op === 'close') return reply(null);
    acks.push(request.ack);
    return reply(items.length ? { kind: 'page', page: acks.length, item: items.shift() }
      : { kind: 'ended', end: { kind: 'closed', cursor: 1, reason: 'Complete' } });
  }, projection);
  const feed = connection.conversation(textScope).watch({ after: null, projectionVersion: 1 }, async item => received.push(item));
  assert.equal((await feed.ended).kind, 'closed');
  assert.equal(received[0].snapshot.document.domain.text, 'start');
  assert.equal(received[1].events[0].event.event, ' next');
  assert.deepEqual(acks, [null, 1, 2]);
});

for (const [name, mutate, kind] of [
  ['scope', item => { item.snapshot.scope.hostId = 'foreign'; }, 'refused'],
  ['projection', item => { item.snapshot.projectionVersion = 1; }, 'refused'],
  ['document', item => { item.snapshot.document.extra = true; }, 'resync'],
]) {
  test(`shared engine closes ${name} failure without delivery or ACK`, async () => {
    const item = structuredClone(snapshot), acks = [];
    mutate(item);
    let closed = 0;
    const connection = createServiceConnection(async encoded => {
      const request = JSON.parse(encoded);
      if (request.op === 'watch') return reply({ feedId: 'feed' });
      if (request.op === 'close') { closed++; return reply(null); }
      acks.push(request.ack);
      return reply({ kind: 'page', page: 1, item });
    }, transcriptProjection);
    const feed = connection.conversation(scope).watch({ after: 8, projectionVersion: 3 }, async () => assert.fail('Invalid item delivered'));
    assert.equal((await feed.ended).kind, kind);
    assert.deepEqual(acks, [null]);
    assert.equal(closed, 1);
  });
}

for (const [name, response, kind] of [
  ['malformed unauthorized', () => new Response('{', { status: 401, headers: { 'Content-Type': 'application/json' } }), 'unauthorized'],
  ['non-OK success', () => Response.json({ ok: true, value: null }, { status: 503 }), 'unavailable'],
  ['classified failure', () => Response.json({ ok: false, error: { kind: 'forbidden', message: 'Denied' } }, { status: 403 }), 'forbidden'],
]) {
  test(`shared engine classifies ${name}`, async () => {
    let notifications = 0;
    const connection = createServiceConnection(response, transcriptProjection, { onUnauthorized: () => notifications++ });
    await assert.rejects(connection.reconcile(scope, 'command'), error => error instanceof ServiceError && error.kind === kind);
    assert.equal(notifications, kind === 'unauthorized' ? 1 : 0);
  });
}

for (const [name, body, headers] of [
  ['content type', '{}', { 'Content-Type': 'text/plain' }],
  ['UTF-8', new Uint8Array([0xff]), { 'Content-Type': 'application/json' }],
  ['JSON', '{', { 'Content-Type': 'application/json' }],
  ['announced limit', '{}', { 'Content-Type': 'application/json', 'Content-Length': String(SERVICE_MAX_RESPONSE_BYTES + 1) }],
  ['stream limit', ' '.repeat(SERVICE_MAX_RESPONSE_BYTES + 1), { 'Content-Type': 'application/json' }],
]) {
  test(`shared engine resynchronizes ${name} failure without delivery or ACK`, async () => {
    const acks = [];
    const connection = createServiceConnection(async encoded => {
      const request = JSON.parse(encoded);
      if (request.op === 'watch') return reply({ feedId: 'feed' });
      if (request.op === 'close') return reply(null);
      acks.push(request.ack);
      return new Response(body, { headers });
    }, transcriptProjection);
    const feed = connection.conversation(scope).watch({ after: 8, projectionVersion: 3 }, async () => assert.fail('Invalid item delivered'));
    assert.equal((await feed.ended).kind, 'resync');
    assert.deepEqual(acks, [null]);
  });
}


test('a legacy host projection refusal tells the new client to update together and never submits or receives', async () => {
  const requests = [];
  const connection = createServiceConnection(async encoded => {
    const request = JSON.parse(encoded);
    requests.push(request.op);
    return reply(request.op === 'watch' ? { feedId: 'old-host' } : request.op === 'close' ? null :
      { kind: 'ended', end: { kind: 'refused', cursor: null, reason: 'unknown-scope-or-incompatible-projection' } });
  }, transcriptProjection);
  const feed = connection.conversation(scope).watch({ after: null, projectionVersion: transcriptProjection.version }, async () => assert.fail('Old feed delivered'));
  const end = await feed.ended;
  assert.equal(end.kind, 'refused');
  assert.match(end.reason, /Update the app and host together/);
  assert.equal(requests.includes('submit'), false);
});
