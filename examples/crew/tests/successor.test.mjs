import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProviderRegistry, openLocalHost } from '@agentui/host';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { SqliteStore } from '../../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../../packages/host/dist/durable-model.js';
import { acknowledgement, crewService } from './support/crew-service.mjs';

const memberId = randomUUID();
const crewInstance = { namespace: 'crew', installationId: 'test', generation: 'one', protocolVersion: '1' };
const service = (t, options) => crewService(t, { ...options, memberId, token: 'private-crew-test', instance: crewInstance });

const hostId = 'crew-host';
const scope = conversationId => ({ hostId, conversationId });
const before = scope('before');
const credential = instance => ({ kind: 'credential-handle', hostId, instance, opaqueHandle: 'crew-handle' });

async function harness(t) {
  const remote = await service(t), directory = mkdtempSync(join(tmpdir(), 'agentui-crew-successor-')), path = join(directory, 'host.sqlite');
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
  return { remote, path, open, close,
    get host() { return current.host; }, get registry() { return current.registry; }, get target() { return current.target; },
    create: (conversation, predecessor) => current.host.createProviderConversation(conversation, current.target, current.registry, predecessor),
    posts: () => remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/handoffs')),
    reads: conversationId => remote.calls.filter(call => call.method === 'GET' && call.path === `/v1/conversations/${conversationId}/handoff`).length,
    events: conversationId => remote.calls.filter(call => call.path === `/v1/conversations/${conversationId}/events`).length,
    database(action) { const db = new DatabaseSync(path); try { return action(db); } finally { db.close(); } },
    state(conversation) {
      return this.database(db => JSON.parse(db.prepare('SELECT data FROM provider_checkpoints WHERE conversation=?').get(conversation).data).state);
    } };
}
async function predecessor(f) {
  assert.equal((await f.create(before)).kind, 'confirmed');
  const binding = f.host.creation(before).observation.binding;
  return { binding, source: binding.authority.binding.opaqueSessionId };
}
async function activated(remote, use = (_request, action) => action('private-crew-test')) {
  const { value } = remote.extension();
  let provider, presentation;
  await value.entry.activate({ namespace: 'crew', credentials: { use },
    providers: { add(_id, backend, view) { provider = backend; presentation = view; } } });
  return { provider, presentation, instance: value.installations[0].instance };
}
const carried = row => ({ handoffId: row.handoffId, firstRequestId: row.firstRequestId, carriedTurns: row.carriedTurns,
  omittedTurns: row.omittedTurns, uncertainTurns: row.uncertainTurns, transcriptBytes: row.transcriptBytes });

test('Crew creation without a predecessor keeps its derived binding and never reads handoffs', async t => {
  const f = await harness(t), { binding, source } = await predecessor(f);
  const stored = f.database(db => JSON.parse(db.prepare("SELECT original FROM provider_creations WHERE conversation='before'").get().original));
  assert.deepEqual(Object.keys(stored.intent).sort(), ['agent', 'kind', 'operationId', 'scope']);
  assert.deepEqual(Object.keys(binding.creation).sort(), ['agent', 'kind', 'operationId', 'scope']);
  assert.equal(source, binding.creation.operationId);
  assert.deepEqual(f.host.creation(before).observation.evidence, { conversationId: source, memberId });
  assert.deepEqual(f.remote.calls.filter(call => call.method === 'POST' && call.path === '/v1/conversations').map(call => call.input.conversationId), [source]);
  assert.equal(f.events(source), 1);
  assert.equal(f.remote.calls.some(call => /\/handoffs?$/u.test(call.path)), false);
  assert.equal(Object.hasOwn(f.state('before'), 'handoff'), false);
});

test('Crew successor binds the target Crew drew, checks it against the handoff record before /events and hides the carried transcript', async t => {
  const f = await harness(t), { binding: earlier, source } = await predecessor(f), after = scope('after');
  const result = await f.create(after, before);
  assert.equal(result.kind, 'confirmed');
  const [row] = f.remote.handoffs, creation = f.host.creation(after), target = row.target.conversationId;
  assert.deepEqual(f.posts().map(call => [call.path, call.input]), [[`/v1/conversations/${source}/handoffs`, { requestId: creation.intent.operationId, memberId }]]);
  assert.deepEqual(creation.intent.from, { scope: before, binding: earlier.authority.binding });
  assert.equal(result.binding.authority.binding.opaqueSessionId, target);
  assert.notEqual(target, creation.intent.operationId);
  assert.deepEqual(result.evidence, carried(row));
  assert.equal(f.host.observationStatus(after).kind, 'observing');
  const index = path => f.remote.calls.findIndex(call => call.path === path);
  assert.ok(index(`/v1/conversations/${target}/handoff`) >= 0);
  assert.ok(index(`/v1/conversations/${target}/handoff`) < index(`/v1/conversations/${target}/events`));
  assert.deepEqual(f.host.inspect(after).snapshot.document.domain.messages.map(message => [message.messageId, message.role, message.text]),
    [[`${row.firstRequestId}/assistant`, 'assistant', acknowledgement]]);
  const state = f.state('after');
  assert.deepEqual(state.handoff, { firstRequestId: row.firstRequestId });
  assert.deepEqual(state.messages.map(message => message.messageId), [row.firstRequestId, `${row.firstRequestId}/assistant`]);
  const { presentation } = await activated(f.remote);
  assert.deepEqual(presentation.continuation(result.evidence), { carriedTurns: 1, omittedTurns: 1, uncertainTurns: 0,
    carriedBytes: row.transcriptBytes, limitBytes: 65536 });
});

test('Crew rejects successor bindings whose target or predecessor was altered', async t => {
  const f = await harness(t), { source } = await predecessor(f);
  const { binding } = await f.create(scope('after'), before);
  const { provider, instance } = await activated(f.remote);
  const connection = await provider.connect({ apiVersion: 1, instance, credential: credential(instance) });
  assert.equal(connection.kind, 'connected');
  t.after(() => connection.backend.close());
  const observe = forged => () => connection.backend.observe({ binding: forged, after: null }, async () => {});
  const from = binding.creation.from, session = binding.authority.binding;
  const target = value => ({ ...binding, authority: { ...binding.authority, binding: { ...session, opaqueSessionId: value } } });
  const lineage = value => ({ ...binding, creation: { ...binding.creation, from: value } });
  for (const forged of [
    target(source),
    target(binding.creation.operationId),
    lineage({ ...from, binding: { ...from.binding, installationId: 'other' } }),
    lineage({ ...from, binding: { ...from.binding, namespace: 'other' } }),
    { ...binding, creation: Object.fromEntries(Object.entries(binding.creation).filter(([key]) => key !== 'from')) },
  ]) assert.throws(observe(forged), /^Error: Foreign Crew (?:predecessor|conversation)$/u);
  assert.throws(observe(lineage({ ...from, binding: { ...from.binding, opaqueSessionId: 'not-a-uuid' } })));
  assert.throws(observe(lineage({ ...from, extra: true })));
  assert.equal(f.posts().length, 1);
});

for (const [name, tamper] of [
  ['another request', chain => chain?.incoming ? { ...chain, incoming: { ...chain.incoming, requestId: randomUUID() } } : chain],
  ['another source', chain => chain?.incoming ? { ...chain, incoming: { ...chain.incoming, source: { ...chain.incoming.source, conversationId: randomUUID() } } } : chain],
  ['another member', chain => chain?.incoming ? { ...chain, incoming: { ...chain.incoming, target: { ...chain.incoming.target, memberId: randomUUID() } } } : chain],
  ['no incoming record', chain => chain?.incoming ? null : chain],
]) test(`Crew successor whose handoff record has ${name} opens no /events until the record matches`, async t => {
  const f = await harness(t), after = scope('after');
  await predecessor(f);
  f.remote.setHandoffRead(tamper);
  assert.equal((await f.create(after, before)).kind, 'confirmed');
  const target = f.remote.handoffs[0].target.conversationId;
  assert.equal(f.host.observationStatus(after).kind, 'stopped');
  assert.equal(f.reads(target), 1);
  assert.equal(f.events(target), 0);
  f.remote.setHandoffRead(null);
  assert.equal((await f.host.retryObservation(after)).kind, 'observing');
  assert.equal(f.reads(target), 2);
  assert.equal(f.events(target), 1);
});

test('Crew successor whose saved target was altered is never observed', async t => {
  const f = await harness(t), after = scope('after');
  await predecessor(f);
  f.remote.setHandoffRead(chain => chain?.incoming ? null : chain);
  assert.equal((await f.create(after, before)).kind, 'confirmed');
  f.remote.setHandoffRead(null);
  await f.close();
  const forged = randomUUID();
  f.database(db => db.prepare("UPDATE provider_creations SET observation=json_set(observation,'$.binding.authority.binding.opaqueSessionId',?) WHERE conversation='after'").run(forged));
  await f.open();
  await f.host.observeProvider(after);
  assert.equal(f.host.creation(after).observation.binding.authority.binding.opaqueSessionId, forged);
  assert.equal(f.host.observationStatus(after).kind, 'stopped');
  assert.equal(f.reads(forged), 1);
  assert.equal(f.events(forged), 0);
});

test('Crew successor whose reply was lost confirms by lookup with exactly one POST', async t => {
  const f = await harness(t), { source } = await predecessor(f), after = scope('after');
  f.remote.replyHandoffs('lost');
  assert.equal((await f.create(after, before)).kind, 'uncertain');
  assert.equal(f.reads(source), 0);
  await assert.rejects(f.create(after, scope('other')), /Creation predecessor is immutable/);
  const result = await f.create(after);
  assert.equal(result.kind, 'confirmed');
  assert.equal(result.source, 'lookup');
  assert.equal(result.binding.authority.binding.opaqueSessionId, f.remote.handoffs[0].target.conversationId);
  assert.equal(f.posts().length, 1);
  assert.equal(f.reads(source), 1);
});

for (const status of ['reserved', 'attempted']) test(`Crew successor ${status} before a restart is looked up and never posted`, async t => {
  const f = await harness(t), { binding, source } = await predecessor(f), after = scope('after');
  const original = f.registry.capture(after, f.target, { scope: before, binding: binding.authority.binding });
  await f.close();
  const store = new SqliteStore(f.path, transcriptProjection, budgets());
  try {
    store.reserveCreation(original);
    if (status === 'attempted') store.attemptCreation(original);
  } finally { store.close(); }
  if (status === 'attempted') f.remote.admit(f.remote.commitHandoff(source, original.intent.operationId).target.conversationId);
  await f.open();
  const result = await f.create(after);
  assert.equal(result.kind, status === 'attempted' ? 'confirmed' : 'uncertain');
  assert.equal(result.source, 'lookup');
  assert.equal(f.posts().length, 0);
  assert.equal(f.reads(source), 1);
});

test('Crew successor of a source sealed by another request is refused as continued elsewhere on lookup and on POST', async t => {
  const f = await harness(t), { source } = await predecessor(f), after = scope('after');
  f.remote.replyHandoffs('dropped');
  assert.equal((await f.create(after, before)).kind, 'uncertain');
  f.remote.commitHandoff(source, randomUUID());
  const looked = await f.create(after);
  assert.equal(looked.kind, 'rejected');
  assert.equal(looked.source, 'lookup');
  assert.deepEqual(looked.evidence, { refused: 'continued-elsewhere', code: 'handed_off' });
  const posted = await f.create(scope('later'), before);
  assert.equal(posted.kind, 'rejected');
  assert.deepEqual(posted.evidence, { refused: 'continued-elsewhere', code: 'handed_off' });
  assert.equal(f.posts().length, 2);
});

test('Crew successor refusals settle rejected and the presentation reports each refusal', async t => {
  const f = await harness(t), { presentation } = await activated(f.remote);
  await predecessor(f);
  for (const [status, code, refused] of [[409, 'busy', 'busy'], [409, 'usage_limit', 'limit'], [409, 'memory_limit', 'limit'],
    [409, 'instructions_limit', 'limit'], [409, 'handoff_empty', 'unavailable'], [409, 'handoff_too_large', 'unavailable'],
    [409, 'history_unavailable', 'unavailable'], [409, 'trusted_conversation', 'unavailable'], [409, 'conflict', 'unavailable'],
    [400, 'invalid_input', 'unavailable'], [404, 'not_found', 'unavailable'], [401, 'unauthorized', 'unavailable'], [403, 'forbidden', 'unavailable']]) {
    f.remote.replyHandoffs({ status, code });
    const result = await f.create(scope(`after-${code}`), before);
    assert.equal(result.kind, 'rejected', code);
    assert.deepEqual(result.evidence, { refused, code });
    assert.deepEqual(presentation.continuation(result.evidence), { refused });
  }
  f.remote.replyHandoffs({ status: 409, code: 'request_rejected' });
  assert.equal((await f.create(scope('after-unknown'), before)).kind, 'uncertain');
  assert.equal(f.remote.handoffs.length, 0);
  for (const evidence of [null, { refused: 'later', code: 'busy' }, { handoffId: 'not-a-uuid' }]) assert.equal(presentation.continuation(evidence), null);
});

test('Crew successor re-posts only re-drivable answers within the first create, stays pending unadmitted, then confirms by lookup', { timeout: 30_000 }, async t => {
  const f = await harness(t), { source } = await predecessor(f), after = scope('after');
  f.remote.replyHandoffs('update_rejected', 'unavailable', 'unadmitted');
  const pending = await f.create(after, before);
  assert.equal(pending.kind, 'pending');
  const [row] = f.remote.handoffs, posts = f.posts();
  assert.deepEqual(pending.evidence, carried(row));
  assert.equal(posts.length, 3);
  for (const call of posts) assert.deepEqual([call.path, call.input], [`/v1/conversations/${source}/handoffs`, posts[0].input]);
  assert.equal(f.host.observationStatus(after).kind, 'stopped');
  assert.equal(f.events(row.target.conversationId), 0);
  assert.equal((await f.create(after)).kind, 'pending');
  f.remote.admit(row.target.conversationId);
  const confirmed = await f.create(after);
  assert.equal(confirmed.kind, 'confirmed');
  assert.equal(confirmed.source, 'lookup');
  assert.equal(f.posts().length, 3);
  assert.equal(f.reads(source), 2);
});

test('Crew successor refused after an unknown outcome stays uncertain and resolves by lookup', { timeout: 30_000 }, async t => {
  const f = await harness(t), { source } = await predecessor(f), after = scope('after');
  f.remote.replyHandoffs('update_rejected', { status: 401, code: 'authentication_required' });
  assert.equal((await f.create(after, before)).kind, 'uncertain');
  assert.equal(f.remote.handoffs.length, 1);
  assert.equal((await f.create(after)).kind, 'pending');
  assert.equal(f.posts().length, 2);
  assert.equal(f.reads(source), 1);
});

test('Crew successor re-posts a 503 only for retry_same_request, and a mapped 409 after it stays a refusal', { timeout: 30_000 }, async t => {
  const f = await harness(t);
  await predecessor(f);
  f.remote.replyHandoffs({ status: 503, code: 'unavailable' });
  assert.equal((await f.create(scope('after-unavailable'), before)).kind, 'uncertain');
  assert.equal(f.posts().length, 1);
  f.remote.replyHandoffs({ status: 503, code: 'retry_same_request' }, { status: 409, code: 'busy' });
  const result = await f.create(scope('after-busy'), before);
  assert.equal(result.kind, 'rejected');
  assert.deepEqual(result.evidence, { refused: 'busy', code: 'busy' });
  assert.equal(f.posts().length, 3);
  assert.equal(f.remote.handoffs.length, 0);
});

test('Crew successor sends no further POST once its credential is withdrawn during the repeat', { timeout: 30_000 }, async t => {
  const remote = await service(t), posts = () => remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/handoffs')).length;
  let withdrawn = false;
  const { provider, instance } = await activated(remote, async (_request, action) => {
    if (withdrawn) throw new Error('Provider credential use refused');
    try { return await action('private-crew-test'); } finally { withdrawn = posts() > 0; }
  });
  const connection = await provider.connect({ apiVersion: 1, instance, credential: credential(instance) });
  assert.equal(connection.kind, 'connected');
  t.after(() => connection.backend.close());
  const agent = { instance, kind: 'agent', opaqueId: memberId }, earlier = { kind: 'create', operationId: randomUUID(), scope: before, agent };
  assert.equal((await connection.backend.create(earlier)).kind, 'confirmed');
  remote.replyHandoffs('unavailable', 'admitted');
  const result = await connection.backend.create({ kind: 'create', operationId: randomUUID(), scope: scope('after'), agent,
    from: { scope: before, binding: { namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: earlier.operationId } } });
  assert.equal(result.kind, 'uncertain');
  assert.equal(posts(), 1);
  assert.equal(remote.handoffs.length, 1);
  assert.equal(remote.handoffs[0].firstRequestAdmitted, false);
});
