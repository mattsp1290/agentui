import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../packages/host/dist/durable-model.js';
import { IMAGE_HOST_MAX_BYTES, IMAGE_HOST_MAX_COUNT, IMAGE_MAX_BYTES } from '@agentui/contracts/image';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { fixture, projection, scope, other, installed, command } from './fixture.mjs';
import { chunk, png, screenshotPng } from './image-fixtures.mjs';

function storeFixture(t) {
  const f = fixture(t), stores = [];
  const open = () => { const store = new SqliteStore(f.path, projection, budgets()); stores.push(store); return store; };
  t.after(() => { for (const store of stores) if (store.db.isOpen) store.close() });
  const store = open();
  store.create(scope, installed); store.create(other, installed);
  return { ...f, store, open };
}
const upload = (store, bytes = png(), options = {}) => store.uploadImage(options.scope ?? scope, options.principal ?? 'paired-owner', options.id ?? randomUUID(), options.name ?? 'Screenshot.png', bytes, options.imageInput ?? { kind: 'supported', format: 'png-jpeg-v1' });

test('immutable upload survives restart, lost reply and independent connection retries', t => {
  const f = storeFixture(t), bytes = screenshotPng(), id = randomUUID();
  const attachment = upload(f.store, bytes, { id });
  const reader = f.open();
  assert.deepEqual(upload(reader, bytes, { id }), attachment);
  assert.deepEqual(reader.readImage(scope, attachment.imageId), { attachment, bytes });
  assert.equal(reader.db.prepare('SELECT count(*) AS n FROM images').get().n, 1);
  assert.throws(() => upload(reader, bytes, { id, name: 'different.png' }), { code: 'image-upload-conflict' });
  assert.throws(() => upload(reader, png(), { id }), { code: 'image-upload-conflict' });
  assert.throws(() => reader.db.exec("UPDATE images SET name='changed'"), /immutable/);
  assert.throws(() => reader.db.exec('DELETE FROM images'), /retained/);
  f.store.close(); reader.close();
  const reopened = f.open();
  assert.deepEqual(upload(reopened, bytes, { id }), attachment);
  assert.deepEqual(reopened.readImage(scope, attachment.imageId).bytes, bytes);
  const changed = reopened.readImage(scope, attachment.imageId); changed.bytes.fill(0);
  assert.deepEqual(reopened.readImage(scope, attachment.imageId).bytes, bytes);
});

test('upload idempotency belongs to the uploader and conversation, reads belong to the conversation', t => {
  const f = storeFixture(t), id = randomUUID();
  const a = upload(f.store, png(), { id });
  const b = upload(f.store, png(), { id, principal: 'repaired-owner' });
  const c = upload(f.store, png(), { id, scope: other });
  assert.equal(new Set([a.imageId, b.imageId, c.imageId]).size, 3);
  assert.ok(f.store.readImage(scope, a.imageId).bytes.length);
  for (const wrong of [other, { ...scope, hostId: 'wrong-host' }, { ...scope, conversationId: 'missing' }]) {
    assert.throws(() => f.store.readImage(wrong, a.imageId), { code: 'image-scope' });
  }
  assert.throws(() => upload(f.store, png(), { scope: { ...scope, conversationId: 'missing' } }), { code: 'image-scope' });
  assert.throws(() => f.store.readImage(scope, randomUUID()), { code: 'image-scope' });
});

test('image scope honors the persisted service host identity', t => {
  const f = fixture(t), access = openAccessDatabase(f.path);
  t.after(() => access.database.close());
  const store = new SqliteStore(f.path, projection, budgets()); t.after(() => store.close());
  const serviceScope = { ...scope, hostId: access.hostId };
  store.create(serviceScope, installed); store.create(scope, installed);
  const attachment = upload(store, png(), { scope: serviceScope });
  assert.ok(store.readImage(serviceScope, attachment.imageId));
  assert.throws(() => upload(store), { code: 'image-scope' });
});

test('validation and failed transaction return no reference and retain no partial upload', t => {
  const f = storeFixture(t), id = randomUUID();
  assert.throws(() => upload(f.store, Buffer.from('invalid'), { id }), { code: 'invalid-image' });
  f.store.db.exec("CREATE TRIGGER reject_image AFTER INSERT ON images BEGIN SELECT RAISE(ABORT,'injected commit failure'); END");
  assert.throws(() => upload(f.store, png(), { id }), /injected commit failure/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM images').get().n, 0);
  f.store.db.exec('DROP TRIGGER reject_image');
  assert.ok(upload(f.store, png(), { id }).imageId);
});

for (const [label, mutation] of [
  ['digest', "UPDATE images SET digest=printf('%064d',0)"],
  ['payload', "UPDATE images SET payload=zeroblob(byte_length)"],
  ['byte length', 'PRAGMA ignore_check_constraints=ON; UPDATE images SET byte_length=byte_length+1'],
]) {
  test(`scoped read and exact retry reject stored ${label} corruption`, t => {
    const f = storeFixture(t), id = randomUUID(), bytes = png();
    const attachment = upload(f.store, bytes, { id });
    f.store.db.exec(`DROP TRIGGER images_no_update; ${mutation}`);
    assert.throws(() => f.store.readImage(scope, attachment.imageId), { code: 'image-integrity' });
    assert.throws(() => upload(f.store, bytes, { id }), { code: 'image-integrity' });
  });
}

test('retained row budget includes abandoned selections across conversations and allows exact retries', t => {
  const f = storeFixture(t), bytes = png(), id = randomUUID();
  const attachment = upload(f.store, bytes, { id });
  const insert = f.store.db.prepare('INSERT INTO images SELECT ?,host,?,uploader,?,name,media_type,byte_length,width,height,digest,payload FROM images WHERE id=?');
  f.store.transaction(() => {
    for (let i = 1; i < IMAGE_HOST_MAX_COUNT; i++) insert.run(randomUUID(), other.conversationId, randomUUID(), attachment.imageId);
  });
  assert.throws(() => upload(f.store, bytes, { imageInput: { kind: 'unsupported', reason: 'Unavailable' } }), { code: 'image-unsupported' });
  assert.throws(() => upload(f.store), { code: 'image-capacity' });
  assert.deepEqual(upload(f.store, bytes, { id }), attachment);
  const foreignHost = { ...scope, hostId: 'second-host' }; f.store.create(foreignHost, installed);
  assert.ok(upload(f.store, bytes, { scope: foreignHost }));
});

test('retained payload budget is transactional and includes every stored byte', t => {
  const f = storeFixture(t), id = randomUUID(), small = png();
  const text = Buffer.alloc(IMAGE_MAX_BYTES - small.length - 12, 0x61); text.write('Padding\0');
  const padding = chunk('tEXt', text);
  const bytes = Buffer.concat([small.subarray(0, 33), padding, small.subarray(33)]);
  const attachment = upload(f.store, bytes, { id });
  const insert = f.store.db.prepare('INSERT INTO images SELECT ?,host,conversation,uploader,?,name,media_type,byte_length,width,height,digest,payload FROM images WHERE id=?');
  f.store.transaction(() => {
    for (let i = 1; i < IMAGE_HOST_MAX_BYTES / IMAGE_MAX_BYTES; i++) insert.run(randomUUID(), randomUUID(), attachment.imageId);
  });
  assert.equal(f.store.db.prepare('SELECT SUM(byte_length) AS bytes FROM images').get().bytes, IMAGE_HOST_MAX_BYTES);
  assert.throws(() => upload(f.store), { code: 'image-capacity' });
  assert.deepEqual(upload(f.store, bytes, { id }), attachment);
  assert.equal(f.store.db.prepare('SELECT SUM(byte_length) AS bytes FROM images').get().bytes, IMAGE_HOST_MAX_BYTES);
});

test('version three migration preserves all preexisting tables and exact row values', t => {
  const f = fixture(t), access = openAccessDatabase(f.path), hostId = access.hostId;
  access.database.close();
  const store = new SqliteStore(f.path, projection, budgets());
  const savedScope = { hostId, conversationId: 'saved' }; store.create(savedScope, installed);
  store.db.exec("CREATE TABLE selection_sentinel (data BLOB); INSERT INTO selection_sentinel VALUES (x'0001ff'); DROP TABLE frontend_observation_events; DROP TABLE frontend_observation_runs; DROP INDEX commands_tagged_send_key; DROP TABLE frontend_send_owners; DROP TABLE frontend_send_tombstones; DROP TABLE command_images; DROP TABLE images; PRAGMA user_version=3");
  const tables = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all().map(row => row.name);
  const before = tables.map(table => [table, store.db.prepare(`SELECT * FROM ${table}`).all()]);
  store.close();
  const reopened = new SqliteStore(f.path, projection, budgets()); t.after(() => reopened.close());
  for (const [table, rows] of before) assert.deepEqual(reopened.db.prepare(`SELECT * FROM ${table}`).all(), rows);
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, 7);
  assert.ok(upload(reopened, png(), { scope: savedScope }));
  assert.equal(reopened.db.prepare('SELECT version FROM service_schema').get().version, 2);
});

test('invalid pre-image database is refused before image migration changes its bytes', t => {
  const f = storeFixture(t); f.store.close();
  const db = new DatabaseSync(f.path);
  db.exec("DROP TABLE frontend_observation_events; DROP TABLE frontend_observation_runs; DROP INDEX commands_tagged_send_key; DROP TABLE frontend_send_owners; DROP TABLE frontend_send_tombstones; DROP TABLE command_images; DROP TABLE images; PRAGMA user_version=3; UPDATE conversations SET document='invalid JSON'"); db.close();
  const before = createHash('sha256').update(readFileSync(f.path)).digest('hex');
  assert.throws(() => f.open(), /Corrupt stored JSON/);
  assert.equal(createHash('sha256').update(readFileSync(f.path)).digest('hex'), before);
});

function concurrentUpload(path, id) {
  const script = `
    import { parentPort, workerData } from 'node:worker_threads';
    import { SqliteStore } from ${JSON.stringify(new URL('../../packages/host/dist/sqlite-store.js', import.meta.url).href)};
    import { budgets } from ${JSON.stringify(new URL('../../packages/host/dist/durable-model.js', import.meta.url).href)};
    import { projection, scope } from ${JSON.stringify(new URL('./fixture.mjs', import.meta.url).href)};
    const store = new SqliteStore(workerData.path, projection, budgets());
    try { parentPort.postMessage({ kind: 'uploaded', attachment: store.uploadImage(scope, 'paired-owner', workerData.id, 'Screenshot.png', workerData.bytes, { kind: 'supported', format: 'png-jpeg-v1' }) }); }
    catch (error) { parentPort.postMessage({ kind: 'failed', code: error.code }); }
    finally { store.close(); }
  `;
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(script)}`), { workerData: { path, id, bytes: png() } });
  return new Promise((resolve, reject) => {
    let result;
    worker.once('message', value => { result = value; });
    worker.once('error', reject);
    worker.once('exit', code => { if (code === 0 && result) resolve(result); else reject(new Error(`Upload worker exited ${code}`)); });
  });
}

test('simultaneous upload retries commit one image and return the same reference', async t => {
  const f = storeFixture(t), id = randomUUID();
  const results = await Promise.all([concurrentUpload(f.path, id), concurrentUpload(f.path, id)]);
  assert.equal(results[0].kind, 'uploaded');
  assert.deepEqual(results[1], results[0]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM images').get().count, 1);
});

test('simultaneous new uploads cannot exceed the final retained row slot', async t => {
  const f = storeFixture(t), attachment = upload(f.store);
  const insert = f.store.db.prepare('INSERT INTO images SELECT ?,host,conversation,uploader,?,name,media_type,byte_length,width,height,digest,payload FROM images WHERE id=?');
  f.store.transaction(() => {
    for (let i = 1; i < IMAGE_HOST_MAX_COUNT - 1; i++) insert.run(randomUUID(), randomUUID(), attachment.imageId);
  });
  const results = await Promise.all([concurrentUpload(f.path, randomUUID()), concurrentUpload(f.path, randomUUID())]);
  assert.equal(results.filter(value => value.kind === 'uploaded').length, 1);
  assert.deepEqual(results.find(value => value.kind === 'failed'), { kind: 'failed', code: 'image-capacity' });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM images').get().count, IMAGE_HOST_MAX_COUNT);
});

test('failed additive migration rolls back image table creation and format advancement', t => {
  const f = storeFixture(t);
  f.store.db.exec("DROP TABLE frontend_observation_events; DROP TABLE frontend_observation_runs; DROP INDEX commands_tagged_send_key; DROP TABLE frontend_send_owners; DROP TABLE frontend_send_tombstones; DROP TABLE command_images; DROP TABLE images; PRAGMA user_version=3; CREATE TRIGGER images_no_update BEFORE UPDATE ON conversations BEGIN SELECT 1; END");
  f.store.close();
  assert.throws(() => f.open(), /trigger images_no_update already exists/);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='images'").get(), undefined);
});

test('image sends admit only through image-capable drivers and imageIds in the same conversation', async t => {
  const f = fixture(t), capable = { ...f.driver, imageInput: true };
  const host = f.open({ driver: capable });
  host.createConversation(scope, installed); host.createConversation(other, installed);
  const own = host.uploadImage(scope, 'owner', randomUUID(), 'Screen.png', png());
  const foreign = host.uploadImage(other, 'owner', randomUUID(), 'Screen.png', png());
  const send = (id, imageId) => command(id, { kind: 'send', text: '', imageId });
  const rows = () => {
    const db = new DatabaseSync(f.path);
    try { return { commands: db.prepare('SELECT id FROM commands ORDER BY rowid').all().map(row => row.id),
      links: db.prepare('SELECT host, conversation, command, image FROM command_images').all().map(row => ({ ...row })) }; }
    finally { db.close(); }
  };
  for (const [id, imageId] of [['foreign', foreign.imageId], ['unknown', randomUUID()]]) {
    assert.deepEqual(await host.conversation(scope).submit(send(id, imageId)), { kind: 'rejected', reason: 'This image is not available in this conversation. Attach it again.' });
  }
  const accepted = await host.conversation(scope).submit(send('image', own.imageId));
  assert.equal(accepted.kind, 'receipt');
  assert.deepEqual(rows(), { commands: ['image'], links: [{ host: scope.hostId, conversation: scope.conversationId, command: 'image', image: own.imageId }] });
  host.close(); await host.drained;
  const textOnly = f.open();
  assert.deepEqual(await textOnly.conversation(scope).submit(send('image', own.imageId)), accepted);
  assert.deepEqual(await textOnly.conversation(scope).submit(send('other-image', own.imageId)), { kind: 'rejected', reason: 'This model cannot read images.' });
  assert.equal((await textOnly.conversation(scope).submit(command('text'))).kind, 'receipt');
  assert.deepEqual(rows().commands, ['image', 'text']);
  assert.equal(rows().links.length, 1);
});

test('a failed image link rolls back its command, receipt, snapshot and event together', t => {
  const f = storeFixture(t), image = upload(f.store);
  const tables = ['commands', 'command_images', 'events', 'conversations', 'frontend_send_owners', 'frontend_send_tombstones'];
  const rows = () => tables.map(table => [table, f.store.db.prepare(`SELECT * FROM ${table}`).all()]);
  const before = rows(), send = command('image-link', { kind: 'send', text: '', imageId: image.imageId });
  f.store.db.exec("CREATE TRIGGER reject_link AFTER INSERT ON command_images BEGIN SELECT RAISE(ABORT,'late-image-link'); END");
  assert.throws(() => f.store.admit(send, { kind: 'supported' }), /late-image-link/);
  assert.deepEqual(rows(), before);
  assert.deepEqual(f.store.readImage(scope, image.imageId).attachment, image);
  f.store.db.exec('DROP TRIGGER reject_link');
  assert.equal(f.store.admit(send, { kind: 'supported' }).kind, 'owned');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM command_images').get().n, 1);
});

const unsupported = { kind: 'unsupported', reason: 'This model cannot read images.' };

test('new image refusal follows scope, exact retry, conflict and integrity and precedes quota', t => {
  const f = storeFixture(t), bytes = png(), id = randomUUID(), attachment = upload(f.store, bytes, { id });
  f.store.close();
  const reader = f.open(), peer = f.open();
  for (const store of [reader, peer]) {
    assert.deepEqual(upload(store, bytes, { id, imageInput: unsupported }), attachment);
    assert.deepEqual(store.readImage(scope, attachment.imageId), { attachment, bytes });
    assert.throws(() => upload(store, bytes, { id, name: 'Changed', imageInput: unsupported }), { code: 'image-upload-conflict' });
    assert.throws(() => upload(store, png({ width: 3 }), { id, imageInput: unsupported }), { code: 'image-upload-conflict' });
    assert.throws(() => upload(store, bytes, { imageInput: unsupported }), { code: 'image-unsupported' });
    assert.throws(() => upload(store, bytes, { scope: { ...scope, conversationId: 'missing' }, imageInput: unsupported }), { code: 'image-scope' });
  }
  reader.db.exec("DROP TRIGGER images_no_update; UPDATE images SET digest=printf('%064d',0)");
  assert.throws(() => upload(peer, bytes, { id, imageInput: unsupported }), { code: 'image-integrity' });
  assert.equal(reader.db.prepare('SELECT COUNT(*) n FROM images').get().n, 1);
});

test('missing driver after restart preserves upload identity, read and old receipt but refuses fresh input', async t => {
  const f = fixture(t), host = f.open({ driver: { ...f.driver, imageInput: true } });
  host.createConversation(scope, installed);
  const id = randomUUID(), bytes = png(), attachment = host.uploadImage(scope, 'owner', id, 'Screen.png', bytes);
  const sent = command('image-before-loss', { kind: 'send', text: '', imageId: attachment.imageId });
  const receipt = await host.conversation(scope).submit(sent);
  host.close(); await host.drained;
  const reopened = f.open({ driver: [] });
  assert.equal(reopened.imageInput(installed).kind, 'unsupported');
  assert.deepEqual(reopened.uploadImage(scope, 'owner', id, 'Screen.png', bytes), attachment);
  assert.deepEqual(reopened.readImage(scope, attachment.imageId), { attachment, bytes });
  assert.deepEqual(await reopened.conversation(scope).submit(sent), receipt);
  assert.throws(() => reopened.uploadImage(scope, 'owner', randomUUID(), 'Screen.png', bytes), { code: 'image-unsupported' });
  assert.equal((await reopened.conversation(scope).submit(command('new-image', sent.body))).kind, 'rejected');
});

test('busy image-capable driver accepts retained upload while send readiness remains separate', async t => {
  const f = fixture(t), host = f.open({ driver: { ...f.driver, imageInput: true, capability: () => ({ kind: 'unsupported', reason: 'Busy' }) } });
  host.createConversation(scope, installed);
  assert.deepEqual(host.imageInput(installed), { kind: 'supported', format: 'png-jpeg-v1' });
  const attachment = host.uploadImage(scope, 'owner', randomUUID(), 'Screen.png', png());
  assert.deepEqual(await host.conversation(scope).submit(command('busy', { kind: 'send', text: '', imageId: attachment.imageId })), { kind: 'rejected', reason: 'Busy' });
  assert.deepEqual(host.readImage(scope, attachment.imageId).attachment, attachment);
});
