import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createProviderRegistry } from '@agentui/host';
import { EXTENSION_SDK_VERSION, backendProviderContractVersion } from '@agentui/sdk';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../packages/host/dist/durable-model.js';
import { openDatabase as openFormat7 } from './fixtures/sqlite-format7.ts';
import { fixture, installed, other, projection, scope as before } from './fixture.mjs';

// SHA-256 of packages/host/src/sqlite-schema.ts at 074b2ad, the last format 7 opener.
const format7OpenerSha256 = '9befb13e5cfc5d7139004d7d51de1b9cc1ffaf2ab810e215ab875161ef1d6ae6';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const after = { hostId: before.hostId, conversationId: 'conversation-after' };
const instance = { namespace: 'successor-fixture', installationId: 'successor-installation', generation: 'one', protocolVersion: '1' };
const supported = { kind: 'supported' }, unsupported = { kind: 'unsupported', reason: 'Creation fixture only' };
const successors = `SELECT conversation FROM provider_creations INDEXED BY provider_creations_from
  WHERE host=? AND json_extract(original,'$.intent.from.scope.conversationId')=?`;
const read = (path, action) => { const db = new DatabaseSync(path); try { return action(db); } finally { db.close(); } };

const drawn = operation => operation.from ? `drawn-for-${operation.operationId}` : operation.operationId;
const refused = { kind: 'not-dispatched', source: 'host', evidence: null };

async function providers(t, { continuation = true, session = drawn, carrying = () => undefined } = {}) {
  const creates = [], lookups = [];
  const confirmed = operation => ({ kind: 'confirmed', evidence: null, value: { kind: 'agentui-created', creation: operation, authority: {
    kind: 'remote-provider', binding: { namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: session(operation) } },
    ...(carrying(operation) !== undefined && { carryingTurn: carrying(operation) }) } });
  const backend = { instance,
    capabilities: { create: supported, send: unsupported, cancel: unsupported, decide: unsupported, reconcile: supported, observe: unsupported },
    async discover() { return { kind: 'available', agents: [{ ref: { instance, kind: 'agent', opaqueId: 'agent' }, name: 'Successor fixture' }] }; },
    async create(operation) { creates.push(structuredClone(operation)); return confirmed(operation); },
    async reconcileCreation(operation) { lookups.push(structuredClone(operation)); return confirmed(operation); },
    async submit() { return unsupported; }, async reconcileCommand() { return unsupported; }, async snapshot() { return unsupported; },
    observe() { return { close() {}, ended: Promise.resolve({ kind: 'unsupported', cursor: null, reason: 'Creation fixture only' }) }; },
    async close() {} };
  const presentation = { instance, decodeRequest: value => value, decodeCursor: value => value, decodeState: value => value,
    decodeEvent: value => value, request: text => ({ text }), snapshot: () => ({ messages: [], currentRun: null }), apply: state => ({ state, events: [] }),
    ...(continuation && { continuation: () => null }) };
  const registry = createProviderRegistry([{
    manifest: { namespace: instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.js' }] },
    entry: { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate(context) {
      context.providers.add('service', { apiVersion: backendProviderContractVersion, async connect() { return { kind: 'connected', backend }; } }, presentation);
      return { async dispose() {} };
    } },
    authority: { credentials: {}, issue: () => ({ credential: null, expectedAuthority: 'remote-provider', assertAuthorized() {} }), async close() {} },
  }]);
  await registry.activate();
  t.after(() => registry.close());
  const [discovered] = await registry.discover();
  return { registry, presentation, creates, lookups, target: { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance,
    agent: discovered.agents[0], presentationVersion: 1, expectedAuthority: discovered.expectedAuthority } };
}

test('a successor intent carries its predecessor\'s confirmed binding and is found by predecessor through the index', async t => {
  const f = fixture(t), host = f.open(), p = await providers(t);
  assert.equal((await host.createProviderConversation(before, p.target, p.registry)).kind, 'confirmed');
  const from = { scope: before, binding: host.creation(before).observation.binding.authority.binding };
  const result = await host.createProviderConversation(after, p.target, p.registry, before);
  assert.equal(result.kind, 'confirmed');
  assert.equal(Object.hasOwn(p.creates[0], 'from'), false);
  assert.deepEqual(p.creates[1].from, from);
  assert.deepEqual(host.creation(after).intent.from, from);
  assert.equal(result.binding.authority.binding.opaqueSessionId, `drawn-for-${host.creation(after).intent.operationId}`);
  read(f.path, db => {
    assert.deepEqual(Object.keys(JSON.parse(db.prepare('SELECT original FROM provider_creations WHERE conversation=?').get(before.conversationId).original).intent).sort(),
      ['agent', 'kind', 'operationId', 'scope']);
    assert.deepEqual(db.prepare(successors).all(before.hostId, before.conversationId).map(row => row.conversation), [after.conversationId]);
    assert.deepEqual(db.prepare(successors).all(before.hostId, after.conversationId), []);
    assert.match(db.prepare(`EXPLAIN QUERY PLAN ${successors}`).all(before.hostId, before.conversationId).map(row => row.detail).join('\n'),
      /SEARCH provider_creations USING INDEX provider_creations_from \(host=\? AND <expr>=\?\)/u);
  });
});

test('a predecessor must be this host\'s confirmed conversation with the same agent and cannot change on retry', async t => {
  const f = fixture(t), host = f.open(), p = await providers(t);
  await assert.rejects(host.createProviderConversation(after, p.target, p.registry, before), /^Error: Creation predecessor unavailable$/u);
  host.createConversation(other, installed);
  await assert.rejects(host.createProviderConversation(after, p.target, p.registry, other), /^Error: Creation predecessor unavailable$/u);
  assert.equal((await host.createProviderConversation(before, p.target, p.registry)).kind, 'confirmed');
  const foreign = { ...p.target, agent: { ...p.target.agent, opaqueId: 'another-agent' } };
  await assert.rejects(host.createProviderConversation(after, foreign, p.registry, before), /^Error: Creation predecessor unavailable$/u);
  assert.equal(host.creation(after), null);
  assert.equal(p.creates.length, 1);
  assert.equal((await host.createProviderConversation(after, p.target, p.registry, before)).kind, 'confirmed');
  await assert.rejects(host.createProviderConversation(after, p.target, p.registry, other), /^Error: Creation predecessor is immutable$/u);
  await assert.rejects(host.createProviderConversation(before, p.target, p.registry, other), /^Error: Creation predecessor is immutable$/u);
  assert.equal((await host.createProviderConversation(after, p.target, p.registry)).kind, 'confirmed');
  assert.equal((await host.createProviderConversation(after, p.target, p.registry, before)).kind, 'confirmed');
  assert.equal(p.creates.length, 2);
  assert.equal(p.lookups.length, 0);
});

test('capture refuses a predecessor on another host, of another installation, naming itself or with extra fields', async t => {
  const p = await providers(t), binding = { namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: 'earlier' };
  assert.deepEqual(p.registry.capture(after, p.target, { scope: before, binding }).intent.from, { scope: before, binding });
  for (const from of [
    { scope: { ...before, hostId: 'host-b' }, binding },
    { scope: after, binding },
    { scope: before, binding: { ...binding, installationId: 'other' } },
    { scope: before, binding: { ...binding, namespace: 'other' } },
    { scope: before, binding: { ...binding, extra: true } },
    { scope: before, binding, extra: true },
  ]) assert.throws(() => p.registry.capture(after, p.target, from), /^Error: (?:Foreign creation predecessor|Unexpected or missing field)$/u);
});

test('the host refuses a capture that drops, alters or adds the predecessor it built', async t => {
  const f = fixture(t), host = f.open(), p = await providers(t);
  assert.equal((await host.createProviderConversation(before, p.target, p.registry)).kind, 'confirmed');
  const binding = host.creation(before).observation.binding.authority.binding, execute = (...args) => p.registry.execute(...args);
  for (const [capture, predecessor] of [
    [(scope, target) => p.registry.capture(scope, target), before],
    [(scope, target, from) => p.registry.capture(scope, target, { ...from, binding: { ...from.binding, opaqueSessionId: 'another-session' } }), before],
    [(scope, target) => p.registry.capture(scope, target, { scope: before, binding }), undefined],
  ]) {
    assert.deepEqual(await host.createProviderConversation(after, p.target, { capture, execute }, predecessor), refused);
    assert.equal(host.creation(after), null);
  }
  assert.equal(p.creates.length, 1);
});

test('a provider whose presentation has no continuation hook is never handed a predecessor', async t => {
  const f = fixture(t), host = f.open(), p = await providers(t, { continuation: false });
  assert.equal((await host.createProviderConversation(before, p.target, p.registry)).kind, 'confirmed');
  assert.deepEqual(await host.createProviderConversation(after, p.target, p.registry, before), refused);
  assert.equal(host.creation(after), null);
  const binding = host.creation(before).observation.binding.authority.binding;
  assert.throws(() => p.registry.capture(after, p.target, { scope: before, binding }), /^Error: Provider does not continue conversations$/u);
  assert.equal(p.creates.length, 1);
});

test('a stored successor is never dispatched to a provider that no longer declares the continuation hook', async t => {
  const f = fixture(t), host = f.open(), p = await providers(t);
  assert.equal((await host.createProviderConversation(before, p.target, p.registry)).kind, 'confirmed');
  const captured = p.registry.capture(after, p.target, { scope: before, binding: host.creation(before).observation.binding.authority.binding });
  delete p.presentation.continuation;
  let effects = 0;
  assert.deepEqual(await p.registry.execute(captured, true, () => { effects += 1; }), { kind: 'not-dispatched', source: 'create', evidence: null });
  assert.deepEqual(await p.registry.execute(captured, false, () => { effects += 1; }), { kind: 'uncertain', source: 'lookup', evidence: null });
  assert.equal(effects, 0);
  assert.equal(p.creates.length, 1);
  assert.equal(p.lookups.length, 0);
});

test('a successor confirmed on its predecessor\'s session settles uncertain on create and on lookup', async t => {
  const f = fixture(t), host = f.open(), p = await providers(t, { session: operation => operation.from?.binding.opaqueSessionId ?? operation.operationId });
  assert.equal((await host.createProviderConversation(before, p.target, p.registry)).kind, 'confirmed');
  assert.deepEqual(await host.createProviderConversation(after, p.target, p.registry, before), { kind: 'uncertain', source: 'create', evidence: null });
  assert.deepEqual(await host.createProviderConversation(after, p.target, p.registry), { kind: 'uncertain', source: 'lookup', evidence: null });
  assert.equal(host.creation(after).observation.kind, 'uncertain');
  assert.equal(p.creates[1].from.binding.opaqueSessionId, p.creates[0].operationId);
  assert.equal(p.lookups.length, 1);
});

test('only a successor binding keeps the turn that carried its predecessor; any other binding naming one settles uncertain', async t => {
  let carrying = () => undefined;
  const f = fixture(t), host = f.open(), p = await providers(t, { carrying: operation => carrying(operation) });
  assert.equal((await host.createProviderConversation(before, p.target, p.registry)).kind, 'confirmed');
  assert.deepEqual(Object.keys(host.creation(before).observation.binding).sort(), ['authority', 'creation', 'kind']);
  carrying = () => 'carrying-turn';
  assert.equal((await host.createProviderConversation(after, p.target, p.registry, before)).kind, 'confirmed');
  assert.equal(host.creation(after).observation.binding.carryingTurn, 'carrying-turn');
  const plain = { hostId: before.hostId, conversationId: 'conversation-plain' };
  assert.deepEqual(await host.createProviderConversation(plain, p.target, p.registry), { kind: 'uncertain', source: 'create', evidence: null });
  assert.equal(host.creation(plain).observation.kind, 'uncertain');
});

test('a saved successor whose predecessor was altered is refused when read', async t => {
  const f = fixture(t), p = await providers(t);
  let host = f.open();
  await host.createProviderConversation(before, p.target, p.registry);
  await host.createProviderConversation(after, p.target, p.registry, before);
  host.close(); await host.drained;
  const saved = read(f.path, db => db.prepare('SELECT original FROM provider_creations WHERE conversation=?').get(after.conversationId).original);
  for (const [path, value] of [['$.intent.from.scope.hostId', 'host-b'], ['$.intent.from.scope.conversationId', after.conversationId],
    ['$.intent.from.binding.installationId', 'other'], ['$.intent.from.binding.namespace', 'other']]) {
    read(f.path, db => db.prepare('UPDATE provider_creations SET original=json_set(original,?,?) WHERE conversation=?').run(path, value, after.conversationId));
    host = f.open();
    assert.throws(() => host.creation(after), /^Error: Foreign creation predecessor$/u, path);
    host.close(); await host.drained;
    read(f.path, db => db.prepare('UPDATE provider_creations SET original=? WHERE conversation=?').run(saved, after.conversationId));
  }
  host = f.open();
  assert.equal(host.creation(after).observation.kind, 'confirmed');
});

test('the unchanged format 7 opener refuses a format 8 database before file or WAL mutation', async t => {
  assert.equal(digest(readFileSync(new URL('./fixtures/sqlite-format7.ts', import.meta.url))), format7OpenerSha256);
  const f = fixture(t), old = openFormat7(f.path); old.close();
  const host = f.open(); host.close(); await host.drained;
  assert.equal(read(f.path, db => db.prepare('PRAGMA user_version').get().user_version), 8);
  const bytes = readFileSync(f.path);
  assert.throws(() => openFormat7(f.path), /Unsupported database version/);
  assert.deepEqual(readFileSync(f.path), bytes);
  assert.equal(existsSync(f.path + '-wal'), false); assert.equal(existsSync(f.path + '-shm'), false);
});

test('a format 7 database gains the predecessor index once without rewriting creation rows', async t => {
  const f = fixture(t), host = f.open(), p = await providers(t);
  await host.createProviderConversation(before, p.target, p.registry);
  await host.createProviderConversation(after, p.target, p.registry, before);
  host.close(); await host.drained;
  const rows = read(f.path, db => {
    db.exec('DROP INDEX provider_creations_from; PRAGMA user_version=7');
    return db.prepare('SELECT * FROM provider_creations ORDER BY rowid').all();
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = new SqliteStore(f.path, projection, budgets());
    try {
      assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 8);
      assert.deepEqual(store.db.prepare('SELECT * FROM provider_creations ORDER BY rowid').all(), rows);
      assert.deepEqual(store.db.prepare(successors).all(before.hostId, before.conversationId).map(row => row.conversation), [after.conversationId]);
    } finally { store.close(); }
  }
});

for (const [name, damage] of [['missing', 'DROP INDEX provider_creations_from'],
  ['changed', 'DROP INDEX provider_creations_from; CREATE INDEX provider_creations_from ON provider_creations(host)']]) {
  test(`format 8 refuses a ${name} predecessor index without repairing it`, async t => {
    const f = fixture(t), host = f.open(); host.close(); await host.drained;
    const schema = read(f.path, db => { db.exec(damage); return db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(); });
    assert.throws(() => f.open(), /^Error: Invalid provider creation schema$/u);
    read(f.path, db => {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
      assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
    });
  });
}
