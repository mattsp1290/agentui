import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { foldDocument } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { openLocalHost } from '@agentui/host';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../packages/host/dist/durable-model.js';
import { openDatabase as openReleasedMain } from './fixtures/sqlite-format4.ts';
import { fixture } from './fixture.mjs';

const provenance = JSON.parse(readFileSync(new URL('./fixtures/released-image4.json', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const rows = db => Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT IN ('frontend_send_owners','frontend_send_tombstones') ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
const schema = db => db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all();
function released(t) {
  const f = fixture(t), compressed = readFileSync(new URL('./fixtures/released-image4.sqlite.gz', import.meta.url));
  assert.equal(digest(compressed), provenance.compressedSha256);
  const bytes = gunzipSync(compressed);
  assert.equal(digest(bytes), provenance.databaseSha256);
  writeFileSync(f.path, bytes);
  return f;
}

test('authentic released image4 upgrades once preserving raw rows, image replay and uncertain retry', async t => {
  const f = released(t), old = new DatabaseSync(f.path);
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 4);
  const before = rows(old), scope = JSON.parse(before.commands[0].intent).scope;
  const original = JSON.parse(before.conversations[0].document);
  assert.equal(before.images.length, 1); assert.equal(before.command_images.length, 2); assert.equal(before.frontend_receipts.length, 1);
  old.close();
  for (let attempt = 0; attempt < 2; attempt++) {
    const store = new SqliteStore(f.path, transcriptProjection, budgets());
    try {
      assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 8);
      assert.deepEqual(rows(store.db), { ...before, frontend_observation_runs: [], frontend_observation_events: [] });
      for (const table of ['frontend_send_owners', 'frontend_send_tombstones']) assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
      assert.deepEqual(store.snapshot(scope).document, original);
      let replay = { domain: transcriptProjection.initial(), receipts: {}, decisions: {} };
      for (const envelope of store.page(scope, 0, store.head(scope))) replay = foldDocument(replay, envelope.event, transcriptProjection);
      assert.deepEqual(replay, original);
      for (const message of replay.domain.messages.filter(message => message.image)) {
        const image = store.readImage(scope, message.image.imageId);
        assert.deepEqual(image.attachment, message.image);
        assert.deepEqual(image.bytes, Buffer.from(before.images[0].payload));
      }
    } finally { store.close(); }
    const host = openLocalHost({ path: f.path, projection: transcriptProjection, driver: [], authorize: () => true });
    try {
      for (const row of before.commands) {
        const command = JSON.parse(row.intent), receipt = JSON.parse(row.receipt);
        assert.deepEqual(await host.conversation(scope).submit(command), { kind: 'receipt', receipt });
      }
      assert.equal((await host.conversation(scope).receipt('released-image-uncertain')).state.kind, 'uncertain');
    } finally { host.close(); await host.drained; }
  }
  const reader = new DatabaseSync(f.path);
  try { assert.deepEqual(rows(reader), { ...before, frontend_observation_runs: [], frontend_observation_events: [] }); } finally { reader.close(); }
});

test('failed released image4 migration leaves every original row, image byte and schema object intact', t => {
  const f = released(t), db = new DatabaseSync(f.path);
  db.prepare("UPDATE commands SET target='invalid json' WHERE id=?").run('released-image-uncertain');
  const before = rows(db), beforeSchema = schema(db); db.close();
  assert.throws(() => new SqliteStore(f.path, transcriptProjection, budgets()), /malformed JSON/);
  const reader = new DatabaseSync(f.path);
  try {
    assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 4);
    assert.deepEqual(rows(reader), before);
    assert.deepEqual(schema(reader), beforeSchema);
  } finally { reader.close(); }
});

test('the exact released main opener refuses format8 before changing database bytes', t => {
  assert.equal(digest(readFileSync(new URL('./fixtures/sqlite-format4.ts', import.meta.url))), provenance.openerSha256);
  const f = released(t), old = openReleasedMain(f.path); old.close();
  const store = new SqliteStore(f.path, transcriptProjection, budgets()); store.close();
  const before = readFileSync(f.path);
  assert.throws(() => openReleasedMain(f.path), /Unsupported database version/);
  assert.deepEqual(readFileSync(f.path), before);
});

for (const table of ['frontend_send_owners', 'frontend_send_tombstones']) test(`released image4 ${table} creation failure rolls back the migration`, t => {
  const f = released(t), db = new DatabaseSync(f.path);
  db.exec(`CREATE TABLE ${table}(sentinel BLOB); INSERT INTO ${table} VALUES (x'0001ff')`);
  const before = rows(db), beforeSchema = schema(db), sentinel = db.prepare(`SELECT * FROM ${table}`).all(); db.close();
  assert.throws(() => new SqliteStore(f.path, transcriptProjection, budgets()), /already exists/);
  const reader = new DatabaseSync(f.path);
  try {
    assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 4);
    assert.deepEqual(rows(reader), before);
    assert.deepEqual(schema(reader), beforeSchema);
    assert.deepEqual(reader.prepare(`SELECT * FROM ${table}`).all(), sentinel);
  } finally { reader.close(); }
});
