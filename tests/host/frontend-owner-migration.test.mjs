import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { openLocalHost } from '@agentui/host';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { frontendToolsFor } from '@agentui/host/frontend-tools';
import { openDatabase as openOriginal5 } from './fixtures/sqlite-format5.ts';
import { openDatabase as openOriginal6 } from './fixtures/sqlite-format6.ts';
import { fixture } from './fixture.mjs';

const provenance = JSON.parse(readFileSync(new URL('./fixtures/released-owner5.json', import.meta.url)));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const actor = { id: 'trusted-owner', platform: 'desktop', authorized: () => true };
function original(t) {
  const f = fixture(t), compressed = readFileSync(new URL('./fixtures/released-owner5.sqlite.gz', import.meta.url));
  assert.equal(digest(compressed), provenance.compressedSha256);
  const data = gunzipSync(compressed); assert.equal(digest(data), provenance.databaseSha256); writeFileSync(f.path, data);
  return f;
}
function snapshot(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return { version: db.prepare('PRAGMA user_version').get().user_version,
    schema: db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(),
    tables: Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()])) }; }
  finally { db.close(); }
}
function open(path) { return openLocalHost({ path, projection: transcriptProjection, driver: [], authorize: () => true }); }

test('authentic released owner5 upgrades to8 and reopens with every original row and image byte intact', async t => {
  const f = original(t), before = snapshot(f.path); assert.equal(before.version, 5);
  for (let attempt = 0; attempt < 2; attempt++) {
    const host = open(f.path);
    try {
      for (const conversation of before.tables.conversations) {
        const scope = { hostId: conversation.host, conversationId: conversation.conversation };
        assert.deepEqual(host.inspect(scope).snapshot.document, JSON.parse(conversation.document));
        assert.deepEqual(host.installation(scope), JSON.parse(conversation.installation));
      }
      for (const command of before.tables.commands) {
        const scope = { hostId: command.host, conversationId: command.conversation };
        assert.deepEqual(await host.conversation(scope, actor).receipt(command.id), JSON.parse(command.receipt));
      }
      for (const image of before.tables.images) {
        const value = host.readImage({ hostId: image.host, conversationId: image.conversation }, image.id);
        assert.deepEqual(value.bytes, Buffer.from(image.payload)); assert.equal(digest(value.bytes), image.digest);
      }
      for (const owner of before.tables.frontend_send_owners) {
        const scope = { hostId: owner.host, conversationId: owner.conversation }, key = { threadId: owner.thread_id, runId: owner.run_id };
        const view = frontendToolsFor(host).client(scope, actor).inspect(key);
        assert.equal(view.status, owner.state === 'available' ? 'ready' : 'blocked');
      }
    } finally { host.close(); await host.drained; }
    const after = snapshot(f.path);
    assert.equal(after.version, 8);
    for (const [table, rows] of Object.entries(before.tables)) assert.deepEqual(after.tables[table], rows);
    assert.deepEqual(after.schema.filter(row => !row.name.includes('frontend_observation') && row.name !== 'provider_creations_from'), before.schema);
    assert.deepEqual(after.tables.frontend_observation_runs, []); assert.deepEqual(after.tables.frontend_observation_events, []);
  }
});

test('the unchanged genuine5 opener refuses8 before file or WAL mutation', async t => {
  assert.equal(digest(readFileSync(new URL('./fixtures/sqlite-format5.ts', import.meta.url))), provenance.openerSha256);
  const f = original(t), old = openOriginal5(f.path); old.close();
  const host = open(f.path); host.close(); await host.drained;
  const before = readFileSync(f.path);
  assert.throws(() => openOriginal5(f.path), /Unsupported database version/);
  assert.deepEqual(readFileSync(f.path), before);
  assert.equal(existsSync(f.path + '-wal'), false); assert.equal(existsSync(f.path + '-shm'), false);
});

for (const damage of ['owner-schema', 'history-index', 'image-schema']) test(`genuine5 ${damage} migration refusal preserves version and data`, t => {
  const f = original(t), db = new DatabaseSync(f.path);
  if (damage === 'owner-schema') db.exec('ALTER TABLE frontend_send_owners ADD COLUMN invalid TEXT');
  else if (damage === 'history-index') db.exec('DROP INDEX commands_tagged_send_key');
  else db.exec('DROP TABLE command_images');
  db.close(); const before = snapshot(f.path);
  assert.throws(() => open(f.path), /Invalid frontend ownership schema|no such index|Incomplete database schema/);
  assert.deepEqual(snapshot(f.path), before); assert.equal(before.version, 5);
});

test('genuine5 permits keep their original receipt after8 withdrawal while untouched calls refuse', async t => {
  const f = original(t), before = snapshot(f.path);
  const owner = before.tables.frontend_send_owners.find(owner => owner.state === 'available');
  const scope = { hostId: owner.host, conversationId: owner.conversation }, key = { threadId: owner.thread_id, runId: owner.run_id };
  const run = JSON.parse(before.tables.frontend_runs.find(run => run.run === key.runId).data);
  const permitted = run.calls.find(call => call.state.kind === 'permitted'), untouched = run.calls.find(call => call.state.kind === 'ready');
  const activationId = run.bindings.find(binding => binding.name === untouched.name).activationId;
  const host = open(f.path), client = frontendToolsFor(host).client(scope, actor);
  try {
    assert.equal((await host.frontendBinding({ scope, id: owner.command_id, action: 'unavailable' }, actor,
      () => { assert.fail('No producer for withdrawal'); })).reason, 'closures-unavailable');
    assert.equal(client.claim(key, permitted.id, activationId).kind, 'uncertain');
    assert.equal(client.claim(key, untouched.id, activationId).kind, 'unavailable');
    assert.equal(client.receipt(key, permitted.state.permitId, { kind: 'completed', output: 'injected original fixture receipt' }), 'recorded');
    assert.equal(client.receipt(key, permitted.state.permitId, { kind: 'completed', output: 'injected original fixture receipt' }), 'duplicate');
    assert.equal(client.claim(key, untouched.id, activationId).kind, 'unavailable');
  } finally { host.close(); await host.drained; }
});

const provenance6 = JSON.parse(readFileSync(new URL('./fixtures/released-owner6.json', import.meta.url)));
function original6(t) {
  const f = fixture(t), compressed = readFileSync(new URL('./fixtures/released-owner6.sqlite.gz', import.meta.url));
  assert.equal(digest(compressed), provenance6.compressedSha256);
  const data = gunzipSync(compressed); assert.equal(digest(data), provenance6.databaseSha256); writeFileSync(f.path, data);
  return f;
}
test('genuine released6 migrates and reopens8 preserving every old row, public transcript, image, receipt and permit', async t => {
  const f = original6(t), before = snapshot(f.path); assert.equal(before.version, 6);
  for (let attempt = 0; attempt < 2; attempt++) {
    const host = open(f.path);
    try {
      for (const row of before.tables.conversations) {
        const scope = { hostId: row.host, conversationId: row.conversation };
        assert.deepEqual(host.inspect(scope).snapshot.document, JSON.parse(row.document));
      }
      for (const row of before.tables.commands) assert.deepEqual(await host.conversation({ hostId: row.host, conversationId: row.conversation }, { ...actor, id: before.tables.frontend_send_owners.find(owner => owner.command_id === row.id)?.actor_id ?? actor.id }).receipt(row.id), JSON.parse(row.receipt));
      for (const row of before.tables.images) assert.deepEqual(host.readImage({ hostId: row.host, conversationId: row.conversation }, row.id).bytes, Buffer.from(row.payload));
      for (const row of before.tables.frontend_runs) {
        const run = JSON.parse(row.data), scope = { hostId: row.host, conversationId: row.conversation }, key = { threadId: row.thread, runId: row.run };
        const client = frontendToolsFor(host).client(scope, { ...actor, id: before.tables.frontend_send_owners.find(owner => owner.run_id === key.runId)?.actor_id ?? actor.id });
        const view = client.inspect(key); assert.equal(view.status, run.status);
        for (const call of run.calls.filter(call => call.state.kind === 'permitted')) assert.equal(client.claim(key, call.id, call.state.activationId).kind, 'uncertain');
      }
    } finally { host.close(); await host.drained; }
    const after = snapshot(f.path); assert.equal(after.version, 8);
    for (const [table, rows] of Object.entries(before.tables)) assert.deepEqual(after.tables[table], rows);
  }
  for (const [openOld, filename, provenance] of [[openOriginal5, 'sqlite-format5.ts', JSON.parse(readFileSync(new URL('./fixtures/released-owner5.json', import.meta.url)))], [openOriginal6, 'sqlite-format6.ts', provenance6]]) {
    assert.equal(digest(readFileSync(new URL('./fixtures/' + filename, import.meta.url))), provenance.openerSha256);
    const bytes = readFileSync(f.path);
    assert.throws(() => openOld(f.path), /Unsupported database version/); assert.deepEqual(readFileSync(f.path), bytes);
    assert.equal(existsSync(f.path + '-wal'), false); assert.equal(existsSync(f.path + '-shm'), false);
  }
});
for (const damage of ['missing', 'changed']) test(`format7 observation schema ${damage} refuses reopen without recreating evidence`, async t => {
  const f = original6(t), host = open(f.path); host.close(); await host.drained;
  const db = new DatabaseSync(f.path);
  db.exec(damage === 'missing' ? 'DROP TABLE frontend_observation_events' : 'ALTER TABLE frontend_observation_events ADD COLUMN unexpected TEXT'); db.close();
  const before = snapshot(f.path); assert.throws(() => open(f.path), /Invalid frontend observation schema/); assert.deepEqual(snapshot(f.path), before);
});

test('genuine6 journal migration failure rolls back schema creation and preserves format6 rows',t=>{
  const f=original6(t),db=new DatabaseSync(f.path);db.exec('CREATE TABLE frontend_observation_events (sentinel TEXT)');db.close();
  const before=snapshot(f.path);assert.throws(()=>open(f.path),/already exists/);assert.deepEqual(snapshot(f.path),before);assert.equal(before.version,6);
});
