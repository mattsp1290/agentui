import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerSelection, assertNoSelectionJournal } from '../../apps/host/build/tsc/server-selection.js';
import { parseRefreshRequest } from '../../apps/host/build/tsc/refresh-jobs.js';
import { SelectionRefusal } from '../../apps/host/build/tsc/selection-protocol.js';
import { databaseFixture, request, source, rows, deferred } from './refresh-support.mjs';

test('unavailable builder records a finite failure, exact replay, and immutable source identity', async t => {
  const f = databaseFixture(t), owner = await f.open();
  const result = await owner.request(request('unavailable'));
  assert.equal(result.job.build.kind, 'failed');
  assert.equal(result.job.build.failure, 'unavailable');
  assert.equal(result.job.promotion.kind, 'not-built');
  assert.deepEqual(await owner.request(request('unavailable')), result);
  await assert.rejects(owner.request(request('unavailable', { ...source, commit: 'b'.repeat(40) })), /id-conflict/);
  await assert.rejects(owner.promote('unavailable'), /not-built/);
  assert.equal(rows(f.database).length, 1);
  assert.equal(f.replacements(), 0);
  assert.equal(f.stops(), 0);
  await owner.close();
  const reopened = await f.open();
  assert.equal((await reopened.inspect('unavailable')).job.build.failure, 'unavailable');
});

test('committed references normalize once and reject credentials, traversal, extra fields and symbolic commits', () => {
  const parsed = parseRefreshRequest(request('canonical', { repository: './source', commit: 'A'.repeat(40), subdirectory: './server' }));
  assert.equal(parsed.reference.repository, new URL('../../source', import.meta.url).pathname.replace(/\/$/, ''));
  assert.equal(parsed.reference.commit, 'a'.repeat(40));
  assert.equal(parsed.reference.subdirectory, 'server');
  for (const reference of [
    { ...source, commit: 'main' }, { ...source, subdirectory: '../escape' }, { ...source, repository: 'https://user:secret@example.test/repo' },
    { ...source, extra: true }, { ...source, subdirectory: '.git' },
  ]) assert.throws(() => parseRefreshRequest(request('bad', reference)));
  assert.throws(() => parseRefreshRequest({ ...request('bad'), extra: true }));
});

test('composed ownership fences unguarded selectors, transient startup and reserved commands', async t => {
  const f = databaseFixture(t), owner = await f.open();
  assert.throws(() => assertNoSelectionJournal(f.access), /durable artifact ownership/);
  await assert.rejects(owner.selection.select({ id: 'refresh.missing', expectedRevision: 0, selection: { version: 1, artifacts: [] } }),
    error => error instanceof SelectionRefusal && error.reason === 'refresh-intent-conflict');
  await owner.selection.select({ id: 'manual', expectedRevision: 0, selection: { version: 1, artifacts: [] } });
  assert.equal(f.stops(), 0);
  await owner.close();
  const plain = await createServerSelection({ database: f.access, ...f.selection });
  assert.equal(plain.status().kind, 'journal-invalid');
  await plain.close();
  const reopened = await f.open();
  assert.equal(reopened.selection.status().desired.id, 'manual');
  assert.equal(f.database.prepare('SELECT host FROM service_extension_refresh_owner').get().host, f.access.hostId);
});

test('valid ordinary selection history acquires refresh ownership without changing revision or receipt', async t => {
  const f = databaseFixture(t), plain = await createServerSelection({ database: f.access, ...f.selection });
  await plain.select({ id: 'legacy-manual', expectedRevision: 0, selection: { version: 1, artifacts: [] } });
  const before = plain.status();
  await plain.close();
  const owner = await f.open();
  assert.deepEqual(owner.selection.status(), before);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_extension_refresh_owner').get().n, 1);
});

for (const [name, damage] of [
  ['refresh marker', 'DROP TABLE host_refresh_schema'],
  ['refresh jobs', 'DROP TABLE host_refresh_jobs'],
  ['refresh version', 'UPDATE host_refresh_schema SET version=2'],
  ['foreign refresh host', "UPDATE host_refresh_schema SET host='foreign'"],
  ['canonical ownership marker', 'DROP TABLE service_extension_refresh_owner'],
  ['foreign canonical owner', "UPDATE service_extension_refresh_owner SET host='foreign'"],
  ['empty canonical owner', 'DELETE FROM service_extension_refresh_owner'],
  ['unknown refresh object', 'CREATE TABLE HOST_REFRESH_future(value TEXT)'],
  ['damaged request', "UPDATE host_refresh_jobs SET body='{}'"],
]) test(`damaged ${name} fails closed without rebuilding or repairing ownership`, async t => {
  const f = databaseFixture(t), owner = await f.open();
  await owner.request(request('first')); await owner.close();
  f.database.exec(damage);
  const before = f.database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  const changes = f.database.prepare('SELECT total_changes() AS n').get().n;
  await assert.rejects(f.open(), /Invalid refresh/);
  assert.deepEqual(f.database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), before);
  assert.equal(f.database.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(f.replacements(), 0);
});

test('complete refresh namespace loss cannot recreate ownership under an existing canonical marker', async t => {
  const f = databaseFixture(t), owner = await f.open();
  await owner.close(); f.database.exec('DROP TABLE host_refresh_jobs; DROP TABLE host_refresh_schema');
  await assert.rejects(f.open(), /Invalid refresh journal/);
  assert.throws(() => assertNoSelectionJournal(f.access), /durable artifact ownership/);
});

test('lost canonical ownership cannot reseed an initialized refresh namespace', async t => {
  const f = databaseFixture(t), owner = await f.open();
  await owner.close();
  f.database.exec('DROP TABLE service_extension_attempts; DROP TABLE service_extension_selections; DROP TABLE service_extension_selection_schema; DROP TABLE service_extension_refresh_owner');
  await assert.rejects(f.open(), /Invalid refresh journal/);
});

test('initial selection SQL failure rolls back marker and interrupted initialization can recover', async t => {
  const f = databaseFixture(t);
  const plain = await createServerSelection({ database: f.access, ...f.selection }); await plain.close();
  const definitions = f.database.prepare("SELECT sql FROM sqlite_schema WHERE name GLOB 'service_extension_*' AND type='table'").all();
  f.database.exec('DROP TABLE service_extension_attempts; DROP TABLE service_extension_selections; DROP TABLE service_extension_selection_schema');
  for (const { sql } of definitions) f.database.exec(sql);
  f.database.prepare('INSERT INTO service_extension_selection_schema VALUES(1,1,?)').run(f.access.hostId);
  f.database.exec('DROP TABLE service_extension_attempts; CREATE TABLE service_extension_boots (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, selection TEXT NOT NULL REFERENCES service_extension_selections(id), outcome TEXT NOT NULL)');
  f.database.exec("CREATE TRIGGER reject_seed BEFORE INSERT ON service_extension_selections BEGIN SELECT RAISE(ABORT, 'PRIVATE'); END");
  await assert.rejects(f.open(), /Invalid refresh selection/);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='service_extension_refresh_owner'").get().n, 0);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name GLOB 'host_refresh_*'").get().n, 0);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM service_extension_selections').get().n, 0);
  f.database.exec('DROP TRIGGER reject_seed');
  const owner = await f.open();
  assert.equal(owner.selection.status().desiredRevision, 0);
});

test('admission SQL failure never invokes builder or advances accepted source', async t => {
  const f = databaseFixture(t), owner = await f.open();
  f.database.exec("CREATE TRIGGER reject_refresh BEFORE INSERT ON host_refresh_jobs BEGIN SELECT RAISE(ABORT, 'PRIVATE_SOURCE'); END");
  await assert.rejects(owner.request(request('first')), /^Error: Refresh unavailable$/);
  assert.equal(rows(f.database).length, 0);
  assert.equal(f.stops(), 1);
  assert.equal(owner.selection.status().desiredRevision, 0);
});

test('reopen marks persisted unfinished builds interrupted and never adopts an output or reruns', async t => {
  const wait = deferred(), started = deferred();
  let calls = 0, closes = 0;
  const builder = { kind: 'ready', identity: { kind: 'ready', node: process.execPath, entrySha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64),
    builder: { identity: 'c'.repeat(64), esbuildVersion: 'test' } }, run: async () => { calls++; started.resolve(); return wait.promise; }, close: async () => { closes++; } };
  const f = databaseFixture(t, builder), owner = await f.open();
  const pending = owner.request(request('interrupted'));
  await started.promise;
  const closing = owner.close();
  assert.equal(owner.close(), closing);
  let drained = false;
  void closing.then(() => { drained = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false, 'close must drain the still-owned run');
  } finally { wait.resolve({ kind: 'failed', failure: 'build' }); }
  await Promise.all([closing, assert.rejects(pending, /unavailable/)]);
  const reopened = await f.open();
  assert.equal((await reopened.inspect('interrupted')).job.build.kind, 'interrupted');
  assert.equal((await reopened.request(request('interrupted'))).job.build.kind, 'interrupted');
  assert.equal((await reopened.inspect('interrupted')).job.build.kind, 'interrupted');
  assert.equal(calls, 1); assert.equal(closes, 1);
});

test('a decorated promise and malformed admission results cannot pass canonical selection', async t => {
  for (const admission of [Promise.resolve({ kind: 'allow' }), Object.assign(Promise.resolve(), { kind: 'allow' }), { kind: 'allow', extra: true },
    { kind: 'other' }, { kind: 'refuse', reason: 'unexpected' }]) {
    const f = databaseFixture(t);
    let enabled = false;
    const owner = await createServerSelection({ database: f.access, ...f.selection,
      refreshOwnership: { recover: () => ({ kind: 'allow' }), admit: () => enabled ? admission : { kind: 'allow' } } });
    enabled = true;
    await assert.rejects(owner.select({ id: 'bad', expectedRevision: 0, selection: { version: 1, artifacts: [] } }), /unavailable/);
    assert.equal(owner.status().desiredRevision, 0); assert.equal(f.stops(), 1);
    await owner.close();
  }
});

test('invalid canonical history retains withheld inspection while refresh cannot admit or repair', async t => {
  const f = databaseFixture(t), owner = await f.open();
  await owner.request(request('existing')); await owner.close();
  f.database.exec('DELETE FROM service_extension_selections');
  const before = rows(f.database), changes = f.database.prepare('SELECT total_changes() AS n').get().n;
  const reopened = await f.open();
  assert.deepEqual(reopened.selection.status(), { kind: 'journal-invalid' });
  await assert.rejects(reopened.request(request('new')), /unavailable/);
  await assert.rejects(reopened.promote('existing'), /unavailable/);
  assert.deepEqual(rows(f.database), before);
  assert.equal(f.database.prepare('SELECT total_changes() AS n').get().n, changes);
});

test('a caller cannot mutate persisted request identity through a receipt', async t => {
  const f = databaseFixture(t), owner = await f.open();
  const receipt = await owner.request(request('immutable'));
  receipt.job.request.reference.commit = 'b'.repeat(40);
  receipt.job.build.command.source.repository = '/changed';
  assert.equal((await owner.inspect('immutable')).job.request.reference.commit, source.commit);
  assert.equal(f.stops(), 0);
});

test('loss of the canonical ownership marker during operation refuses new work before admission', async t => {
  const f = databaseFixture(t), owner = await f.open();
  f.database.exec('DROP TABLE service_extension_refresh_owner');
  await assert.rejects(owner.request(request('must-not-start')), /unavailable/);
  assert.equal(rows(f.database).length, 0);
  assert.equal(f.stops(), 1);
});

test('closing immediately after admission prevents the builder from starting and closes it once', async t => {
  let calls = 0, closes = 0;
  const builder = { kind: 'ready', identity: { kind: 'ready', node: process.execPath, entrySha256: 'a'.repeat(64), lockSha256: 'b'.repeat(64),
    builder: { identity: 'c'.repeat(64), esbuildVersion: 'test' } }, run: async () => { calls++; return { kind: 'failed', failure: 'build' }; },
    close: async () => { closes++; } };
  const f = databaseFixture(t, builder), owner = await f.open();
  const pending = owner.request(request('stop-before-effect'));
  const closed = owner.close();
  assert.equal(owner.close(), closed);
  await Promise.all([closed, assert.rejects(pending, /unavailable/)]);
  assert.equal(calls, 0); assert.equal(closes, 1);
  assert.equal(JSON.parse(rows(f.database)[0].body).build.kind, 'interrupted');
});
