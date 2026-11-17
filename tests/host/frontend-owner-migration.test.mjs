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

test('authentic released owner5 upgrades to6 and reopens with every original row and image byte intact', async t => {
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
    assert.deepEqual(snapshot(f.path), { ...before, version: 6 });
  }
});

test('the unchanged genuine5 opener refuses6 before file or WAL mutation', async t => {
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

test('genuine5 permits keep their original receipt after6 withdrawal while untouched calls refuse', async t => {
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
