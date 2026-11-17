import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createBrowserConnection, ServiceError } from '@agentui/client/service';
import { parseServiceRequest, parseServiceResponse, parseServicePull, SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';

const scope = { hostId: 'host', conversationId: 'conversation' };
const snapshot = { kind: 'snapshot', snapshot: { scope, projectionVersion: 4, cursor: 0,
  document: { domain: { messages: [] }, receipts: {}, decisions: {} } } };
const agent = { id: 'agent', label: 'Test agent', runtime: { engine: 'engine', version: '1', format: '1' }, frontendOffers: 'unsupported', commands: ['send'], availability: { kind: 'ready' } };
const metadata = { agents: [agent], defaultAgentId: agent.id, hostId: 'host', principalId: 'principal', compatibility: { wireVersion: 1,
  extensionSdkVersion: '1', nativeRuntime: { engine: 'engine', version: '1', format: '1' },
  desiredGitRevision: 'revision', appliedArtifact: { artifactId: 'artifact', gitRevision: 'revision' } } };
const reply = value => Response.json({ ok: true, value });
const page = (number, item = snapshot) => ({ kind: 'page', page: number, item });
const ended = { kind: 'ended', end: { kind: 'closed', cursor: 0, reason: 'Done' } };
const until = async predicate => {
  for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await setImmediate(); }
  assert.fail('Expected asynchronous operation did not complete');
};
const command = { version: 1, scope, clientCommandId: 'command', body: { kind: 'send', text: 'Hello' } };

test('canonical service schema rejects unknown operations, fields, and out of range inputs', () => {
  assert.deepEqual(parseServiceRequest({ op: 'submit', command }), { op: 'submit', command });
  for (const input of [ { op: 'create', scope }, { op: 'unknown' }, { op: 'metadata', code: 'extra' }, { op: 'pair', code: '' },
    { op: 'catalog', after: null, limit: 101 }, { op: 'catalog', after: null, limit: 0 },
    { op: 'watch', scope, after: -1, projectionVersion: 4 }, { op: 'pull', feedId: 'feed', ack: 0.5 },
    { op: 'submit', command: { ...command, body: { kind: 'send', text: 'x'.repeat(64_001) } } } ]) {
    assert.throws(() => parseServiceRequest(input));
  }
  assert.throws(() => parseServiceResponse({ op: 'catalog' }, { ok: true, value: Array(101).fill(scope) }));
  assert.throws(() => parseServiceResponse({ op: 'close' }, { ok: true, value: {} }));
  assert.throws(() => parseServicePull({ ...page(1), extra: true }));
  const unknownDomain = page(1, { kind: 'events', events: [{ scope, sequence: 1, event: { kind: 'invalid' } }] });
  assert.deepEqual(parseServicePull(unknownDomain), unknownDomain);
  let nested = {};
  for (let depth = 0; depth < 70; depth++) nested = { nested };
  assert.throws(() => parseServiceResponse({ op: 'metadata' }, { ok: true, value: nested }), /structural limit/);
});

test('catalog entries keep bounded display previews separate from scope identity', async () => {
  const entries = [{ scope, preview: 'A recognizable first prompt' }, { scope: { ...scope, conversationId: 'empty' }, preview: null }];
  const connection = createBrowserConnection({ fetch: async () => reply(entries) });
  assert.deepEqual(await connection.catalog(), entries);
  for (const preview of ['', 'x'.repeat(81), ' leading', 'trailing ', 'two\nlines', 42]) {
    assert.throws(() => parseServiceResponse({ op: 'catalog' }, { ok: true, value: [{ scope, preview }] }));
  }
  assert.throws(() => parseServiceResponse({ op: 'catalog' }, { ok: true, value: [scope] }));
});

test('search wire values are bounded and use the authenticated browser service', async () => {
  const page = { items: [{ scope, preview: 'Garden', excerpt: 'Water the herbs' }], after: 'scanned-through' };
  let sent;
  const connection = createBrowserConnection({ fetch: async (url, init) => {
    sent = { url, credentials: init.credentials, body: JSON.parse(init.body) };
    return reply(page);
  } });
  assert.deepEqual(await connection.search('  water\n herbs  '), page);
  assert.deepEqual(sent, { url: '/api/v1', credentials: 'same-origin', body: { op: 'search', query: 'water herbs', after: null } });
  for (const input of [
    { query: '' }, { query: ' \n ' }, { query: 'x'.repeat(201) }, { query: 1 }, { query: 'ok', after: '' },
    { query: 'ok', credential: 'private' },
  ]) assert.throws(() => parseServiceRequest({ op: 'search', after: null, ...input }));
  for (const invalid of [
    { ...page, items: Array(101).fill(page.items[0]) }, { ...page, after: '' },
    { ...page, items: [{ ...page.items[0], excerpt: 'x'.repeat(161) }] },
    { ...page, items: [{ ...page.items[0], privateReceipt: {} }] },
    { ...page, items: [{ ...page.items[0], preview: 'x'.repeat(81) }] },
  ]) assert.throws(() => parseServiceResponse({ op: 'search' }, { ok: true, value: invalid }));
});

test('browser uses same origin JSON endpoint and returns only validated domain values', async () => {
  const calls = [];
  const connection = createBrowserConnection({ fetch: async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return reply(metadata);
  } });
  assert.deepEqual(await connection.metadata(), metadata);
  assert.equal(calls.length, 1);
  for (const { url, init } of calls) {
    assert.equal(url, '/api/v1');
    assert.equal(init.method, 'POST');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.headers['Content-Type'], 'application/json');
  }
  assert.deepEqual(calls[0].body, { op: 'metadata' });
});

test('command network failures never retry and authorization failures remain identifiable', async () => {
  let submissions = 0, unauthorized = 0;
  const connection = createBrowserConnection({ onUnauthorized: () => unauthorized++, fetch: async (url, init) => {
    if (JSON.parse(init.body).op === 'submit') { submissions++; throw new Error('Lost reply'); }
    return new Response('Expired', { status: 401 });
  } });
  await assert.rejects(connection.conversation(scope).submit(command), /Lost reply/);
  assert.equal(submissions, 1);
  await assert.rejects(connection.metadata(), error => error instanceof ServiceError && error.kind === 'unauthorized');
  assert.equal(unauthorized, 1);
});

test('feed ACK waits for receiver and duplicate pages are delivered once', async () => {
  const received = [], acks = [], gate = Promise.withResolvers();
  const results = [page(1), page(1), { kind: 'heartbeat' }, page(2, { kind: 'events', events: [] }), ended];
  const connection = createBrowserConnection({ fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.op === 'watch') return reply({ feedId: 'feed' });
    if (body.op === 'close') return reply(null);
    acks.push(body.ack);
    return reply(results.shift());
  } });
  const feed = connection.conversation(scope).watch({ after: null, projectionVersion: 4 }, async item => {
    received.push(item);
    if (received.length === 1) await gate.promise;
  });
  assert.equal(typeof feed.close, 'function');
  await until(() => received.length === 1);
  assert.deepEqual(acks, [null]);
  gate.resolve();
  assert.deepEqual(await feed.ended, ended.end);
  assert.deepEqual(acks, [null, 1, 1, 1, 2]);
  assert.equal(received.length, 2);
});

test('feed failure releases server feed and reports last delivered cursor', async () => {
  let pulls = 0, closed = 0;
  const connection = createBrowserConnection({ fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.op === 'watch') return reply({ feedId: 'feed' });
    if (body.op === 'close') { closed++; return reply(null); }
    if (++pulls === 1) return reply(page(1));
    throw new Error('Disconnected');
  } });
  const feed = connection.conversation(scope).watch({ after: null, projectionVersion: 4 }, async () => {});
  assert.deepEqual(await feed.ended, { kind: 'failed', cursor: 0, reason: 'Disconnected' });
  await until(() => closed === 1);
  assert.equal(pulls, 2);
});

test('closing feed aborts active pull and posts close once', async () => {
  let closed = 0, aborted = false, pulling = false;
  const connection = createBrowserConnection({ fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.op === 'watch') return reply({ feedId: 'feed' });
    if (body.op === 'close') { closed++; return reply(null); }
    pulling = true;
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('Aborted'));
    }, { once: true }));
  } });
  const feed = connection.conversation(scope).watch({ after: 5, projectionVersion: 4 }, async () => assert.fail('Unexpected delivery'));
  await until(() => pulling);
  feed.close();
  feed.close();
  assert.equal((await feed.ended).kind, 'closed');
  await until(() => closed === 1);
  assert.equal(aborted, true);
});

test('closing before watch opens releases its eventual server feed', async () => {
  const opening = Promise.withResolvers();
  let closed = 0, pulls = 0;
  const connection = createBrowserConnection({ fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.op === 'watch') return opening.promise;
    if (body.op === 'close') { closed++; return reply(null); }
    pulls++;
    assert.fail('Closed watch must not pull');
  } });
  const feed = connection.conversation(scope).watch({ after: null, projectionVersion: 4 }, async () => {});
  feed.close();
  assert.equal((await feed.ended).kind, 'closed');
  opening.resolve(reply({ feedId: 'feed' }));
  await until(() => closed === 1);
  assert.equal(pulls, 0);
});

test('changed duplicate pages fail without redelivery or acknowledgement', async () => {
  let pulls = 0, received = 0;
  const connection = createBrowserConnection({ fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.op === 'watch') return reply({ feedId: 'feed' });
    if (body.op === 'close') return reply(null);
    return reply(++pulls === 1 ? page(1) : page(1, { kind: 'events', events: [] }));
  } });
  const feed = connection.conversation(scope).watch({ after: null, projectionVersion: 4 }, async () => { received++; });
  assert.match((await feed.ended).reason, /changed an acknowledged page/);
  assert.equal(received, 1);
  assert.equal(pulls, 2);
});

test('receiver rejection does not ACK the failed page', async () => {
  const acks = [];
  const connection = createBrowserConnection({ fetch: async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.op === 'watch') return reply({ feedId: 'feed' });
    if (body.op === 'close') return reply(null);
    acks.push(body.ack);
    return reply(page(1));
  } });
  const feed = connection.conversation(scope).watch({ after: null, projectionVersion: 4 }, async () => { throw new Error('Persistence failed'); });
  assert.equal((await feed.ended).reason, 'Persistence failed');
  assert.deepEqual(acks, [null]);
});

test('response byte limit cancels a streaming body before JSON parsing', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(SERVICE_MAX_RESPONSE_BYTES + 1)); },
    cancel() { cancelled = true; } });
  const connection = createBrowserConnection({ fetch: async () => new Response(body, { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(connection.metadata(), /byte limit/);
  assert.equal(cancelled, true);
});

test('malformed frames and first-page gaps request a new baseline', async () => {
  for (const result of [page(2), page(1, { kind: 'invalid' }), page(0)]) {
    const connection = createBrowserConnection({ fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      return reply(body.op === 'watch' ? { feedId: 'feed' } : body.op === 'close' ? null : result);
    } });
    const feed = connection.conversation(scope).watch({ after: 8, projectionVersion: 4 }, async () => assert.fail('Invalid page delivered'));
    const end = await feed.ended;
    assert.equal(end.kind, 'resync');
    assert.equal(end.cursor, 8);
  }
  const event = { scope, sequence: 1, event: { kind: 'domain', event: { kind: 'message-updated', messageId: 'message',
    revision: 1, role: 'assistant', text: 'Hello', complete: false } } };
  assert.throws(() => parseServicePull(page(1, { kind: 'events', events: Array(65).fill(event) })));
  assert.throws(() => parseServicePull(page(1, { kind: 'events', events: [{ ...event,
    event: { kind: 'domain', event: { ...event.event.event, text: 'x'.repeat(256_000) } } }] })), /byte limit/);
});

test('deadlines cover a missing response and a response whose body never completes', async () => {
  for (const streaming of [false, true]) {
    let signal;
    const stream = new ReadableStream();
    const connection = createBrowserConnection({ requestTimeoutMs: 10, fetch: async (url, init) => {
      signal = init.signal;
      return streaming ? new Response(stream, { headers: { 'Content-Type': 'application/json' } }) : new Promise(() => {});
    } });
    await assert.rejects(connection.metadata(), error => error instanceof ServiceError && /timed out/.test(error.message));
    assert.equal(signal.aborted, true);
  }
});

test('watch opening has a bounded deadline and failed cleanup cannot delay feed ending', async () => {
  let watch = 0;
  const connection = createBrowserConnection({ requestTimeoutMs: 10, fetch: async () => { watch++; return new Promise(() => {}); } });
  const feed = connection.conversation(scope).watch({ after: null, projectionVersion: 4 }, async () => {});
  assert.equal((await feed.ended).kind, 'failed');
  assert.equal(watch, 1);
});

test('HTTP status interpretation retains classified failures and refuses a non-OK success envelope', async () => {
  for (const [status, value, kind] of [
    [503, { ok: true, value: metadata }, 'unavailable'],
    [403, { ok: false, error: { kind: 'forbidden', message: 'Denied' } }, 'forbidden'],
    [401, { ok: true, value: metadata }, 'unauthorized'],
  ]) {
    const connection = createBrowserConnection({ fetch: async () => Response.json(value, { status }) });
    await assert.rejects(connection.metadata(), error => error instanceof ServiceError && error.kind === kind);
  }
});

test('provider descriptors have a strict independent shape and retain native descriptor bytes', () => {
  const provider = { kind: 'provider', id: 'remote', label: 'Remote', namespace: 'example', protocolVersion: 'v1', frontendOffers: 'unsupported', commands: [], availability: { kind: 'ready' } };
  const parse = value => parseServiceResponse({ op: 'conversation-agent' }, { ok: true, value }).value;
  assert.deepEqual(parse(provider), provider);
  assert.equal(JSON.stringify(parse(agent)), JSON.stringify({ frontendOffers: agent.frontendOffers, id: agent.id, label: agent.label, commands: agent.commands, availability: agent.availability, runtime: agent.runtime }));
  for (const invalid of [{ ...provider, runtime: agent.runtime }, { ...provider, kind: 'remote' },
    { ...provider, namespace: '' }, { ...provider, protocolVersion: 1 }, { ...provider, credential: 'private' }]) assert.throws(() => parse(invalid));
});


test('native model metadata retains host labels and rejects malformed selections', () => {
  const parse = value => parseServiceResponse({ op: 'conversation-agent' }, { ok: true, value }).value;
  const model = { id: 'remote-astra', label: 'Remote Astra' };
  assert.deepEqual(parse({ ...agent, model }).model, model);
  for (const invalid of [null, {}, { id: '', label: 'Remote Astra' }, { id: 'remote-astra', label: 1 }, { ...model, extra: true }]) {
    assert.throws(() => parse({ ...agent, model: invalid }));
  }
});
