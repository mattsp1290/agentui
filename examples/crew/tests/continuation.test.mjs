import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContinuationUnavailable, createProviderRegistry, openLocalHost } from '@agentui/host';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { SqliteStore } from '../../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../../packages/host/dist/durable-model.js';
import { until } from '../../../tests/host/fixture.mjs';
import { fixture } from '../../../tests/application/provider-stream-fixture.mjs';
import { crewService } from './support/crew-service.mjs';

const memberId = randomUUID();
const crewInstance = { namespace: 'crew', installationId: 'test', generation: 'one', protocolVersion: '1' };
const service = t => crewService(t, { memberId, token: 'private-crew-test', instance: crewInstance });

const hostId = 'crew-host';
const scope = conversationId => ({ hostId, conversationId });
const before = scope('before');
const credential = instance => ({ kind: 'credential-handle', hostId, instance, opaqueHandle: 'crew-handle' });
const none = { predecessor: null, carried: null, closure: null, successor: null };
const carried = row => ({ carriedTurns: row.carriedTurns, omittedTurns: row.omittedTurns, uncertainTurns: row.uncertainTurns,
  carriedBytes: row.transcriptBytes, limitBytes: 65536 });

async function harness(t) {
  const remote = await service(t), directory = mkdtempSync(join(tmpdir(), 'agentui-crew-continuation-')), path = join(directory, 'host.sqlite');
  let current;
  async function open() {
    const { value } = remote.extension();
    const registry = createProviderRegistry([{ manifest: value.manifest, entry: value.entry, authority: {
      credentials: { use: (_request, action) => action('private-crew-test') },
      issue: (_id, instance) => ({ credential: credential(instance), expectedAuthority: 'remote-provider', assertAuthorized() {} }),
      async close() {} } }]);
    await registry.activate();
    const [discovered] = await registry.discover();
    assert.equal(discovered.kind, 'available');
    current = { registry, host: openLocalHost({ path, projection: transcriptProjection, driver: [], authorize: () => true, providers: registry }),
      target: { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance, agent: discovered.agents[0],
        presentationVersion: 1, expectedAuthority: discovered.expectedAuthority } };
  }
  async function close() {
    if (!current) return;
    const { host, registry } = current;
    current = undefined;
    host.close(); await host.drained; await registry.close();
  }
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  await open();
  const database = action => { const db = new DatabaseSync(path); try { return action(db); } finally { db.close(); } };
  return { remote, path, open, close, database,
    get host() { return current.host; }, get registry() { return current.registry; }, get target() { return current.target; },
    continuation: (conversation, action) => current.host.continuation(conversation, action, current.registry),
    posts: () => remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/handoffs')),
    reads: () => remote.calls.filter(call => call.method === 'GET' && call.path.endsWith('/handoff')).length,
    attempts: (predecessor = before) => database(db => db.prepare(`SELECT conversation, observation FROM provider_creations
      WHERE json_extract(original,'$.intent.from.scope.conversationId')=? ORDER BY rowid`).all(predecessor.conversationId)
      .map(row => ({ scope: scope(row.conversation), observation: JSON.parse(row.observation) }))) };
}
/** Creates the conversation when needed, then lets Crew end it and waits until the host reports it concluded. */
async function concluded(f, conversation = before, phase = 'cancelled') {
  if (!f.host.creation(conversation)) assert.equal((await f.host.createProviderConversation(conversation, f.target, f.registry)).kind, 'confirmed');
  const session = f.host.creation(conversation).observation.binding.authority.binding.opaqueSessionId;
  await until(() => [...f.remote.streams].some(stream => stream.conversationId === session));
  f.remote.end(session, phase);
  await until(() => f.host.observationStatus(conversation).kind === 'concluded');
  return session;
}
async function eventually(read, done, ms = 5000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('ten concurrent starts post one handoff; every caller and a later device see the same confirmed successor', async t => {
  const f = await harness(t);
  await concluded(f);
  const calls = f.remote.calls.length;
  assert.deepEqual(await f.continuation(before, 'read'), { ...none, closure: 'cancelled' });
  assert.equal(f.remote.calls.length, calls);
  const starting = Promise.all(Array.from({ length: 10 }, () => f.continuation(before, 'start')));
  assert.deepEqual(await f.continuation(before, 'read'), { ...none, closure: 'cancelled', successor: { kind: 'starting' } });
  const views = await starting;
  assert.equal(f.posts().length, 1);
  const [row] = f.remote.handoffs, [attempt] = f.attempts(), after = attempt.scope;
  for (const view of views) assert.deepEqual(view, { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope: after } });
  assert.equal(f.host.creation(after).intent.operationId, f.posts()[0].input.requestId);
  assert.equal(f.host.creation(after).observation.binding.authority.binding.opaqueSessionId, row.target.conversationId);
  assert.deepEqual(await f.continuation(before, 'start'), views[0]);
  assert.deepEqual(await f.continuation(before, 'check'), views[0]);
  assert.deepEqual(await f.continuation(after, 'read'), { predecessor: before, carried: carried(row), closure: null, successor: null });
  assert.deepEqual(await f.continuation(before, 'read'), views[0]);
  assert.equal(f.posts().length, 1);
  assert.equal(f.reads(), 0);
});

test('an uncertain start, a failed check and Try again settle on the first attempt once Crew answers handed_off', async t => {
  const f = await harness(t);
  await concluded(f);
  f.remote.replyHandoffs('lost');
  assert.deepEqual((await f.continuation(before, 'start')).successor, { kind: 'unconfirmed' });
  f.remote.failHandoffLookups(1);
  assert.deepEqual((await f.continuation(before, 'check')).successor, { kind: 'unconfirmed' });
  assert.equal(f.posts().length, 1);
  f.remote.failHandoffLookups(1);
  const view = await f.continuation(before, 'start');
  const posts = f.posts(), [first, second] = f.attempts();
  assert.equal(posts.length, 2);
  assert.notEqual(posts[1].input.requestId, posts[0].input.requestId);
  assert.deepEqual(posts.map(call => call.input.requestId), [first, second].map(attempt => f.host.creation(attempt.scope).intent.operationId));
  assert.deepEqual(second.observation.evidence, { refused: 'continued-elsewhere', code: 'handed_off' });
  assert.equal(first.observation.kind, 'confirmed');
  assert.equal(first.observation.source, 'lookup');
  assert.deepEqual(view, { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope: first.scope } });
  assert.equal(f.reads(), 3);
  assert.deepEqual(await f.continuation(before, 'start'), view);
  assert.equal(f.posts().length, 2);
});

test('each Crew refusal shows as the newest refusal, and a host refusal before recording shows only once', async t => {
  const f = await harness(t);
  await concluded(f);
  const offline = { capture() { throw new Error('Provider unavailable'); }, execute: (...args) => f.registry.execute(...args) };
  assert.deepEqual((await f.host.continuation(before, 'start', offline)).successor, { kind: 'refused', refusal: 'unavailable' });
  assert.deepEqual(await f.continuation(before, 'read'), { ...none, closure: 'cancelled' });
  assert.deepEqual(f.attempts(), []);
  for (const [status, code, refusal] of [[409, 'busy', 'busy'], [409, 'usage_limit', 'limit'], [409, 'memory_limit', 'limit'],
    [409, 'instructions_limit', 'limit'], [409, 'handoff_empty', 'unavailable'], [409, 'handoff_too_large', 'unavailable'],
    [409, 'history_unavailable', 'unavailable'], [409, 'trusted_conversation', 'unavailable'], [409, 'conflict', 'unavailable'],
    [400, 'invalid_input', 'unavailable'], [404, 'not_found', 'unavailable'], [401, 'unauthorized', 'unavailable'],
    [403, 'forbidden', 'unavailable'], [409, 'handed_off', 'continued-elsewhere']]) {
    f.remote.replyHandoffs({ status, code });
    const view = await f.continuation(before, 'start');
    assert.deepEqual(view, { ...none, closure: 'cancelled', successor: { kind: 'refused', refusal } }, code);
    assert.deepEqual(await f.continuation(before, 'read'), view, code);
  }
  assert.equal(f.posts().length, 14);
  assert.equal(new Set(f.posts().map(call => call.input.requestId)).size, 14);
  assert.equal(f.reads(), 0);
  assert.equal(f.remote.handoffs.length, 0);
});

test('an unadmitted handoff stays pending without another POST until a lookup sees the carried turn admitted', async t => {
  const f = await harness(t), source = await concluded(f);
  f.remote.replyHandoffs('dropped');
  assert.deepEqual((await f.continuation(before, 'start')).successor, { kind: 'unconfirmed' });
  f.remote.commitHandoff(source, f.posts()[0].input.requestId);
  assert.deepEqual((await f.continuation(before, 'check')).successor, { kind: 'pending' });
  assert.deepEqual((await f.continuation(before, 'start')).successor, { kind: 'pending' });
  assert.deepEqual((await f.continuation(before, 'read')).successor, { kind: 'pending' });
  f.remote.admit(f.remote.handoffs[0].target.conversationId);
  const [attempt] = f.attempts();
  assert.deepEqual((await f.continuation(before, 'check')).successor, { kind: 'confirmed', scope: attempt.scope });
  assert.equal(f.posts().length, 1);
  assert.equal(f.reads(), 3);
});

test('start is refused for an open, unknown or native conversation and one with frontend observations; read stays inert', async t => {
  const f = await harness(t);
  assert.equal((await f.host.createProviderConversation(before, f.target, f.registry)).kind, 'confirmed');
  await assert.rejects(f.continuation(before, 'start'), ContinuationUnavailable);
  assert.deepEqual(await f.continuation(before, 'read'), none);
  await assert.rejects(f.continuation(scope('unknown'), 'start'), ContinuationUnavailable);
  assert.deepEqual(await f.continuation(scope('unknown'), 'read'), none);
  await concluded(f);
  f.database(db => db.prepare("INSERT INTO commands(host, conversation, id, operation, intent, target, observation, receipt) VALUES (?, ?, 'offer', ?, '{}', ?, NULL, '{}')")
    .run(hostId, before.conversationId, randomUUID(), JSON.stringify({ kind: 'provider', operation: { observationProtocol: 'ag-ui-v1' } })));
  await assert.rejects(f.continuation(before, 'start'), ContinuationUnavailable);
  await assert.rejects(f.host.continuation(before, 'check'), /^Error: Provider unavailable$/u);
  assert.equal(f.posts().length, 0);
  assert.deepEqual(f.attempts(), []);
});

for (const status of ['reserved', 'attempted']) test(`a start ${status} before a restart is read as unconfirmed and settled by lookup only`, async t => {
  const f = await harness(t), source = await concluded(f), after = scope('after');
  const original = f.registry.capture(after, f.target, { scope: before, binding: f.host.creation(before).observation.binding.authority.binding });
  await f.close();
  const store = new SqliteStore(f.path, transcriptProjection, budgets());
  try {
    store.reserveCreation(original);
    if (status === 'attempted') store.attemptCreation(original);
  } finally { store.close(); }
  if (status === 'attempted') f.remote.admit(f.remote.commitHandoff(source, original.intent.operationId).target.conversationId);
  await f.open();
  const calls = f.remote.calls.length;
  assert.deepEqual(await f.continuation(before, 'read'), { ...none, closure: 'cancelled', successor: { kind: 'unconfirmed' } });
  assert.equal(f.remote.calls.length, calls);
  const view = await f.continuation(before, status === 'attempted' ? 'start' : 'check');
  assert.deepEqual(view.successor, status === 'attempted' ? { kind: 'confirmed', scope: after } : { kind: 'unconfirmed' });
  assert.equal(f.posts().length, 0);
  assert.equal(f.reads(), 1);
});

test('the catalog lists one row per continuation chain and each segment links both ways', async t => {
  const f = await harness(t), other = scope('other');
  assert.equal((await f.host.createProviderConversation(other, f.target, f.registry)).kind, 'confirmed');
  await concluded(f);
  f.remote.replyHandoffs({ status: 409, code: 'busy' });
  assert.equal((await f.continuation(before, 'start')).successor.kind, 'refused');
  const second = (await f.continuation(before, 'start')).successor.scope;
  assert.deepEqual(f.host.listConversations(hostId, null, 100).map(entry => entry.conversationId).sort(), [other, second].map(entry => entry.conversationId).sort());
  await concluded(f, second, 'complete');
  const third = (await f.continuation(second, 'start')).successor.scope;
  const [first, next] = f.remote.handoffs;
  assert.deepEqual(f.host.listConversations(hostId, null, 100).map(entry => entry.conversationId).sort(), [other, third].map(entry => entry.conversationId).sort());
  assert.deepEqual(await f.continuation(before, 'read'), { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope: second } });
  assert.deepEqual(await f.continuation(second, 'read'), { predecessor: before, carried: carried(first), closure: 'exhausted', successor: { kind: 'confirmed', scope: third } });
  assert.deepEqual(await f.continuation(third, 'read'), { predecessor: second, carried: carried(next), closure: null, successor: null });
  assert.equal(f.posts().length, 3);
});

test('the continuation operation round-trips over the service wire and the catalog shows the newest segment', { timeout: 20_000 }, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), chat = await f.create();
  assert.deepEqual(await f.client.continuation({ scope: chat, action: 'read' }), none);
  await assert.rejects(f.client.continuation({ scope: chat, action: 'start' }), error => error.kind === 'invalid');
  await until(() => remote.streams.size === 1);
  remote.end([...remote.conversations.keys()][0], 'failed');
  await eventually(() => f.client.providerObservation({ scope: chat, action: 'read' }), status => status.kind === 'concluded');
  const started = await f.client.continuation({ scope: chat, action: 'start' });
  assert.equal(started.successor.kind, 'confirmed');
  const next = started.successor.scope, [row] = remote.handoffs;
  assert.deepEqual(started, { ...none, closure: 'failed', successor: { kind: 'confirmed', scope: next } });
  assert.deepEqual(await f.client.continuation({ scope: chat, action: 'check' }), started);
  assert.deepEqual((await f.client.catalog()).map(entry => entry.scope), [next]);
  assert.deepEqual(await f.client.continuation({ scope: next, action: 'read' }), { predecessor: chat, carried: carried(row), closure: null, successor: null });
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/handoffs')).length, 1);
});
