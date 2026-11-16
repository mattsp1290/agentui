import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createServerSelection } from '../../apps/host/build/tsc/server-selection.js';
const empty = { version: 1, artifacts: [] };
async function fixture(t, replace = async () => ({ kind: 'replaced', generation: null })) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const owner = await createServerSelection({ database: { database, hostId: 'attempt-test' }, entries: [],
    runtime: () => ({ kind: 'empty' }), isClosing: () => false, replace, stopRuntime() {} });
  t.after(() => owner.close());
  return { database, owner };
}
test('live apply uses one durable request and exact historical lookup after supersession', async t => {
  let effects = 0;
  const { owner, database } = await fixture(t, async () => { effects++; return { kind: 'replaced', generation: null }; });
  await owner.select({ id: 'disable', expectedRevision: 0, selection: empty });
  const request = { kind: 'apply', requestId: 'apply-disable', selectionId: 'disable', expectedRevision: 1 };
  const applied = await owner.live(request);
  assert.equal(applied.outcome.kind, 'applied-empty');
  assert.equal(applied.attemptId, request.requestId);
  await owner.select({ id: 'later', expectedRevision: 1, selection: empty });
  assert.deepEqual(await owner.live(request), applied);
  assert.deepEqual(owner.status({ kind: 'attempt', id: request.requestId }).operation, applied);
  assert.equal(effects, 1);
  assert.equal(database.prepare('SELECT version FROM service_extension_selection_schema').get().version, 2);
});
test('deferred attempt requires an exact predecessor and request dedup never repeats effects', async t => {
  let effects = 0;
  const { owner } = await fixture(t, async () => ++effects === 1 ? { kind: 'deferred', reason: 'active-work' } : { kind: 'replaced', generation: null });
  await owner.select({ id: 'disable', expectedRevision: 0, selection: empty });
  const apply = { kind: 'apply', requestId: 'first', selectionId: 'disable', expectedRevision: 1 };
  assert.equal((await owner.live(apply)).outcome.kind, 'deferred');
  const retry = { kind: 'retry', requestId: 'second', selectionId: 'disable', expectedRevision: 1, afterAttemptId: 'first' };
  assert.equal((await owner.live(retry)).outcome.kind, 'applied-empty');
  assert.equal((await owner.live(apply)).outcome.kind, 'deferred');
  assert.equal((await owner.live(retry)).outcome.kind, 'applied-empty');
  await assert.rejects(owner.live({ ...retry, requestId: 'third' }));
  await assert.rejects(owner.live({ ...apply, expectedRevision: 0 }), /id-conflict/);
  assert.equal(effects, 2);
});

const golden = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('./extensions/fixtures/selection-journal-v1.json', import.meta.url), 'utf8'));
function oldJournal(t, { seeded = true } = {}) {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  for (const table of golden.tables) database.exec(table.sql);
  for (const table of [...golden.tables].sort((a, b) => (a.name === 'service_extension_boots') - (b.name === 'service_extension_boots'))) {
    if (!seeded && table.name !== 'service_extension_selection_schema') continue;
    for (const row of table.rows) database.prepare(`INSERT INTO ${table.name} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  }
  const open = (entries = []) => createServerSelection({ database: { database, hostId: golden.hostId }, entries,
    runtime: () => ({ kind: 'empty' }), isClosing: () => false, replace: async () => assert.fail('Unresolved history activated'), stopRuntime() {} });
  return { database, open };
}
function snapshot(database) {
  const schema = database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  return { schema, rows: schema.filter(row => row.type === 'table').map(row => database.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}"`).all()) };
}
test('v1 migration preserves exact selections, receipts, history and legacy colliding lookup dimensions', async t => {
  const { database, open } = oldJournal(t);
  database.exec("UPDATE service_extension_boots SET id='disable' WHERE sequence=1");
  const outcomes = [ { kind: 'pending' }, { kind: 'applying' }, { kind: 'interrupted' }, { kind: 'grant-mismatch' },
    ...['load', 'authorization', 'activation', 'discovery'].map(failure => ({ kind: 'failed', failure, recovery: 'replace' })), { kind: 'failed', failure: 'cleanup', recovery: 'restart' } ];
  for (const [i, outcome] of outcomes.entries()) database.prepare('INSERT INTO service_extension_boots(id,selection,outcome) VALUES(?,?,?)').run('old-' + i, 'disable', JSON.stringify(outcome));
  const selections = database.prepare('SELECT * FROM service_extension_selections ORDER BY revision').all();
  const boots = database.prepare('SELECT * FROM service_extension_boots ORDER BY sequence').all();
  const owner = await open();
  assert.deepEqual(database.prepare('SELECT * FROM service_extension_selections ORDER BY revision').all(), selections);
  assert.deepEqual(database.prepare('SELECT sequence,id,selection,outcome FROM service_extension_attempts ORDER BY sequence').all().map(row => ({ ...row })), boots.map(row =>
    ['pending', 'applying'].includes(JSON.parse(row.outcome).kind) ? { ...row, outcome: '{"kind":"interrupted"}' } : { ...row }));
  assert.equal(database.prepare('SELECT version FROM service_extension_selection_schema').get().version, 2);
  assert.equal(owner.status({ kind: 'selection', id: 'disable' }).operation.id, 'disable');
  assert.equal(owner.status({ kind: 'attempt', id: 'disable' }).operation.id, 'startup');
  await owner.activate();
  await assert.rejects(owner.live({ kind: 'apply', requestId: 'disable', selectionId: 'disable', expectedRevision: 1 }), /id-conflict/);
  await owner.close();
});

test('valid unseeded v1 with bad startup pins makes zero changes, then seeds and migrates atomically', async t => {
  const { database, open } = oldJournal(t, { seeded: false });
  const before = snapshot(database), changes = database.prepare('SELECT total_changes() AS n').get().n;
  await assert.rejects(open([{ kind: 'artifact', directory: '/missing-v1-pin', artifactId: 'a'.repeat(64), installations: [] }]));
  assert.deepEqual(snapshot(database), before); assert.equal(database.prepare('SELECT total_changes() AS n').get().n, changes);
  const owner = await open();
  assert.equal(owner.status().desiredRevision, 0); assert.equal(database.prepare('SELECT version FROM service_extension_selection_schema').get().version, 2);
  await owner.close();
});

for (const damage of [
  "INSERT INTO service_extension_boots(id,selection,outcome) VALUES('late','disable','{\"kind\":\"unknown\"}')",
  "INSERT INTO service_extension_boots(id,selection,outcome) VALUES('late','missing','{\"kind\":\"pending\"}')",
  "UPDATE service_extension_selections SET receipt=receipt||' ' WHERE id='disable'",
  "UPDATE service_extension_selections SET intent='{}' WHERE id='disable'",
  'ALTER TABLE service_extension_boots ADD COLUMN surprise TEXT',
  `ALTER TABLE service_extension_selection_schema RENAME TO saved_marker;
    CREATE TABLE service_extension_selection_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL, host TEXT NOT NULL);
    INSERT INTO service_extension_selection_schema SELECT * FROM saved_marker; DROP TABLE saved_marker`,
  'CREATE UNIQUE INDEX outsider ON service_extension_selections(digest)',
]) test(`invalid v1 history refuses without even transient reconciliation writes: ${damage}`, async t => {
  const { database, open } = oldJournal(t);
  database.exec("UPDATE service_extension_boots SET outcome='{\"kind\":\"pending\"}' WHERE sequence=1");
  database.exec('PRAGMA foreign_keys=OFF');
  database.exec(damage);
  const before = snapshot(database), changes = database.prepare('SELECT total_changes() AS n').get().n;
  const owner = await open();
  assert.deepEqual(owner.status(), { kind: 'journal-invalid' }); await owner.activate();
  assert.deepEqual(snapshot(database), before); assert.equal(database.prepare('SELECT total_changes() AS n').get().n, changes);
  await owner.close();
});

test('a failed v1 schema migration rolls back every copied row and old namespace object', async t => {
  const { database, open } = oldJournal(t);
  database.exec("CREATE TRIGGER migration_failure BEFORE UPDATE ON service_extension_selection_schema BEGIN SELECT RAISE(ABORT,'PRIVATE_MIGRATION'); END");
  const before = snapshot(database);
  await assert.rejects(open(), error => error.message === 'Selection migration failed');
  assert.deepEqual(snapshot(database), before);
});

test('malformed later v2 request leaves earlier unresolved rows completely untouched', async t => {
  const { owner, database } = await fixture(t); await owner.close();
  database.exec(`INSERT INTO service_extension_attempts(id,selection,intent,outcome) VALUES
    ('unresolved','startup','{"kind":"boot"}','{"kind":"pending"}'),
    ('bad','startup','{"afterAttemptId":"missing","expectedRevision":0,"kind":"retry","requestId":"bad","selectionId":"startup"}','{"kind":"interrupted"}')`);
  const before = snapshot(database), changes = database.prepare('SELECT total_changes() AS n').get().n;
  const reopened = await createServerSelection({ database: { database, hostId: 'attempt-test' }, entries: [], runtime: () => ({ kind: 'empty' }),
    isClosing: () => false, replace: async () => assert.fail('Invalid journal activated'), stopRuntime() {} });
  assert.deepEqual(reopened.status(), { kind: 'journal-invalid' }); await reopened.activate();
  assert.deepEqual(snapshot(database), before); assert.equal(database.prepare('SELECT total_changes() AS n').get().n, changes);
  await reopened.close();
});

test('pre-effect journal loss stops admission and post-effect uncertainty outranks closed status', async () => {
  for (const effect of [false, true]) {
    const database = new DatabaseSync(':memory:');
    let closed = false, calls = 0;
    const owner = await createServerSelection({ database: { database, hostId: 'failure-test' }, entries: [], runtime: () => ({ kind: 'empty' }),
      isClosing: () => closed, replace: async () => { calls++; return { kind: 'replaced', generation: null }; }, stopRuntime() { closed = true; } });
    database.exec(effect ? `CREATE TRIGGER fail_write BEFORE UPDATE ON service_extension_attempts WHEN json_extract(NEW.outcome,'$.kind')='applied-empty' BEGIN SELECT RAISE(ABORT,'PRIVATE_WRITE'); END`
      : `CREATE TRIGGER fail_write BEFORE INSERT ON service_extension_attempts BEGIN SELECT RAISE(ABORT,'PRIVATE_WRITE'); END`);
    await assert.rejects(owner.live({ kind: 'apply', requestId: 'failure', selectionId: 'startup', expectedRevision: 0 }), error => error.message === `Selection ${effect ? 'uncertain' : 'unavailable'}`);
    assert.equal(closed, true); assert.equal(calls, Number(effect));
    assert.equal(owner.status().runtime.kind, effect ? 'uncertain' : 'closed');
    await assert.rejects(owner.select({ id: 'later', expectedRevision: 0, selection: empty }), /unavailable/);
    await owner.close(); database.close();
  }
});

for (const damage of ['missing-check', 'outside-unique']) test(`schema damage during replacement is uncertain: ${damage}`, async t => {
  const { owner, database } = await fixture(t, async () => {
    database.exec(damage === 'outside-unique' ? 'CREATE UNIQUE INDEX outsider ON service_extension_selections(digest)' :
      `ALTER TABLE service_extension_selection_schema RENAME TO saved_marker;
       CREATE TABLE service_extension_selection_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL, host TEXT NOT NULL);
       INSERT INTO service_extension_selection_schema SELECT * FROM saved_marker; DROP TABLE saved_marker`);
    return { kind: 'replaced', generation: null };
  });
  await assert.rejects(owner.live({ kind: 'apply', requestId: 'damaged', selectionId: 'startup', expectedRevision: 0 }), /uncertain/);
  assert.equal(owner.status().runtime.kind, 'uncertain');
  assert.equal(JSON.parse(database.prepare("SELECT outcome FROM service_extension_attempts WHERE id='damaged'").get().outcome).kind, 'applying');
});

test('out-of-prefix nonunique indexes and fault triggers remain permitted', async t => {
  const { owner, database } = await fixture(t);
  database.exec(`CREATE INDEX outsider ON service_extension_selections(digest);
    CREATE TRIGGER observer AFTER UPDATE ON service_extension_attempts BEGIN SELECT 1; END`);
  assert.equal((await owner.live({ kind: 'apply', requestId: 'allowed', selectionId: 'startup', expectedRevision: 0 })).outcome.kind, 'applied-empty');
});

for (const changed of ['applied-empty', 'applying', 'unknown', 'new-predecessor']) test(`transaction admission decodes persisted predecessor after cached precheck: ${changed}`, async t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  let alter = false, effects = 0, stops = 0;
  const owner = await createServerSelection({ database: { database, hostId: 'admission-test' }, entries: [], isClosing: () => false,
    runtime() {
      if (alter) {
        alter = false;
        if (changed === 'new-predecessor') database.exec(`INSERT INTO service_extension_attempts(id,selection,intent,outcome)
          VALUES('external','startup','{"kind":"boot"}','{"kind":"interrupted"}')`);
        else database.prepare('UPDATE service_extension_attempts SET outcome=? WHERE id=?').run(JSON.stringify({ kind: changed }), 'first');
      }
      return { kind: 'empty' };
    }, replace: async () => { effects++; return { kind: 'deferred', reason: 'active-work' }; }, stopRuntime() { stops++; } });
  t.after(() => owner.close());
  await owner.live({ kind: 'apply', requestId: 'first', selectionId: 'startup', expectedRevision: 0 });
  alter = true;
  await assert.rejects(owner.live({ kind: 'retry', requestId: 'second', selectionId: 'startup', expectedRevision: 0, afterAttemptId: 'first' }),
    changed === 'unknown' ? /unavailable/ : /attempt-conflict/);
  assert.equal(database.prepare("SELECT count(*) AS n FROM service_extension_attempts WHERE id='second'").get().n, 0);
  assert.equal(effects, 1); assert.equal(stops, Number(changed === 'unknown'));
});
