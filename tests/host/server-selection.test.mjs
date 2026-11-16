import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { assertNoSelectionJournal, createServerSelection } from '../../apps/host/build/tsc/server-selection.js';

const legacy = JSON.parse(await fs.readFile(new URL('./extensions/fixtures/selection-journal-v1.json', import.meta.url), 'utf8'));
function unseededV1(database) {
  for (const table of legacy.tables) database.exec(table.sql);
  database.prepare('INSERT INTO service_extension_selection_schema VALUES(1,1,?)').run('selection-test-host');
}

function fixture(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  let activations = 0;
  const open = (entries = []) => createServerSelection({ database: { database, hostId: 'selection-test-host' }, entries,
    runtime: () => ({ kind: 'empty' }), isClosing: () => false, replace: async () => { activations++; return { kind: 'replaced', generation: null }; }, stopRuntime() {} });
  return { database, open, activations: () => activations };
}

function snapshot(database) {
  const schema = database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  return { schema, rows: schema.filter(row => row.type === 'table').map(row =>
    database.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}"`).all()) };
}

for (const existing of [false, true]) test(`failed startup verification preserves ${existing ? 'old unseeded journal ownership' : 'a fresh namespace'}`, async t => {
  const { database, open } = fixture(t);
  if (existing) {
    unseededV1(database);
  }
  const before = snapshot(database), changes = database.prepare('SELECT total_changes() AS count').get().count;
  await assert.rejects(open([{ kind: 'artifact', directory: '/missing-selection-artifact', artifactId: 'a'.repeat(64), installations: [] }]), /Invalid artifact selection/);
  assert.deepEqual(snapshot(database), before);
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changes);
  const access = { database, hostId: 'selection-test-host' };
  if (existing) assert.throws(() => assertNoSelectionJournal(access), /requires durable artifact ownership/);
  else assert.doesNotThrow(() => assertNoSelectionJournal(access));
  const owner = await open();
  assert.equal(owner.status().desiredRevision, 0);
  assert.equal(owner.status().desired.id, 'startup');
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM service_extension_selections').get().count, 1);
  await owner.close();
});

for (const [name, existing, change] of [
  ['new unknown object', false, 'CREATE TABLE service_extension_future(value TEXT)'],
  ['removed old marker', true, 'DELETE FROM service_extension_selection_schema'],
  ['new orphan boot', true, `INSERT INTO service_extension_boots(id,selection,outcome) VALUES('orphan','startup','{"kind":"pending"}')`],
]) test(`startup rechecks ${name} after verification without holding a transaction`, async t => {
  const { database, open } = fixture(t);
  if (existing) {
    unseededV1(database);
  }
  if (name === 'new orphan boot') database.exec('PRAGMA foreign_keys=OFF');
  const opening = open();
  database.exec(`BEGIN IMMEDIATE; ${change}; COMMIT`);
  const before = snapshot(database), changes = database.prepare('SELECT total_changes() AS count').get().count;
  await assert.rejects(opening, /Invalid selection journal/);
  assert.deepEqual(snapshot(database), before);
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changes);
});

test('competing fresh starts accept only one revision-zero selection', async t => {
  const { database, open } = fixture(t);
  const results = await Promise.allSettled([open(), open()]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /revision-conflict/);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM service_extension_selections').get().count, 1);
  await results.find(result => result.status === 'fulfilled').value.close();
});

test('missing boot history withholds an existing selection without replay or schema repair', async t => {
  const { database, open, activations } = fixture(t);
  const original = await open();
  database.prepare('INSERT INTO service_extension_attempts(id,selection,intent,outcome) VALUES(?,?,?,?)')
    .run('lost-attempt', 'startup', '{"kind":"boot"}', '{"kind":"applying"}');
  await original.close();
  database.exec('DROP TABLE service_extension_attempts');
  const schema = database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  const selections = database.prepare('SELECT * FROM service_extension_selections').all();
  const changes = database.prepare('SELECT total_changes() AS count').get().count;
  const reopened = await open();
  await reopened.activate();
  assert.equal(activations(), 0);
  assert.deepEqual(reopened.status(), { kind: 'journal-invalid' });
  await assert.rejects(reopened.select({ id: 'retry', expectedRevision: 0, selection: { version: 1, artifacts: [] } }), /unavailable/);
  assert.deepEqual(database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), schema);
  assert.deepEqual(database.prepare('SELECT * FROM service_extension_selections').all(), selections);
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changes);
  await reopened.close();
});

const tables = ['service_extension_selection_schema', 'service_extension_selections', 'service_extension_attempts'];
for (const [name, damage] of [
  ...tables.map(table => [`missing ${table}`, `DROP TABLE ${table}`]),
  ...tables.map(table => [`only ${table}`, tables.filter(other => other !== table).map(other => `DROP TABLE ${other}`).join(';')]),
  ...tables.map(table => [`view instead of ${table}`, `DROP TABLE ${table}; CREATE VIEW ${table} AS SELECT 1`]),
  ['missing marker', 'DELETE FROM service_extension_selection_schema'],
  ['unseeded schema missing marker', 'DELETE FROM service_extension_selections; DELETE FROM service_extension_selection_schema'],
  ['unknown version', 'UPDATE service_extension_selection_schema SET version=3'],
  ['wrong host', "UPDATE service_extension_selection_schema SET host='different-host'"],
  ['wrong singleton', `DROP TABLE service_extension_selection_schema;
    CREATE TABLE service_extension_selection_schema(singleton INTEGER, version INTEGER, host TEXT);
    INSERT INTO service_extension_selection_schema VALUES(2,1,'selection-test-host')`],
  ['unknown table', 'CREATE TABLE service_extension_future(value TEXT)'],
  ['unknown view', 'CREATE VIEW service_extension_future AS SELECT 1'],
  ['unknown index', 'CREATE INDEX service_extension_future ON service_extension_selections(intent)'],
  ['unknown trigger', 'CREATE TRIGGER service_extension_future AFTER INSERT ON service_extension_selections BEGIN SELECT 1; END'],
  ['mixed-case namespace', 'CREATE TABLE Service_Extension_Future(value TEXT)'],
]) test(`invalid journal with ${name} refuses activation and selection without writes`, async t => {
  const { database, open, activations } = fixture(t);
  await (await open()).close();
  database.exec(damage);
  const before = snapshot(database), changes = database.prepare('SELECT total_changes() AS count').get().count;
  const owner = await open();
  await owner.activate();
  assert.equal(activations(), 0);
  assert.deepEqual(owner.status(), { kind: 'journal-invalid' });
  await assert.rejects(owner.select({ id: 'retry', expectedRevision: 0, selection: { version: 1, artifacts: [] } }), /unavailable/);
  assert.deepEqual(snapshot(database), before);
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changes);
  await owner.close();
});

for (const object of ['TABLE service_extension_future(value TEXT)', 'VIEW Service_Extension_Future AS SELECT 1']) {
  test(`unrecognized journal containing only ${object} is not initialized`, async t => {
    const { database, open } = fixture(t);
    database.exec(`CREATE ${object}`);
    const before = snapshot(database);
    const owner = await open();
    await owner.activate();
    assert.deepEqual(owner.status(), { kind: 'journal-invalid' });
    assert.deepEqual(snapshot(database), before);
    assert.equal(database.prepare('SELECT total_changes() AS count').get().count, 0);
    await owner.close();
  });
}

for (const existing of [false, true]) test(`${existing ? 'unseeded v1' : 'fresh'} and settled empty journals activate normally`, async t => {
  const { database, open, activations } = fixture(t);
  database.exec('CREATE TABLE serviceXextensionYfuture(value TEXT)');
  if (existing) unseededV1(database);
  let owner;
  for (let attempt = 0; attempt < 2; attempt++) {
    owner = await open();
    const before = activations();
    await owner.activate();
    assert.equal(activations(), before + 1);
    assert.equal(owner.status().desired.id, 'startup');
    assert.equal(owner.status().desiredRevision, 0);
    assert.equal(owner.status().runtime.kind, 'applied-empty');
    await owner.close();
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM service_extension_selections').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM service_extension_attempts').get().count, 2);
});

for (const badPin of [false, true]) test(`lost v2 histories refuse all mutations without ${badPin ? 'reading invalid launch pins' : 'reseeding or activation'}`, async t => {
  const { database, open, activations } = fixture(t);
  const original = await open();
  await original.select({ id: 'disable', expectedRevision: 0, selection: { version: 1, artifacts: [] } });
  await original.activate();
  await original.close();
  database.exec('DELETE FROM service_extension_attempts; DELETE FROM service_extension_selections');
  const before = snapshot(database), changes = database.prepare('SELECT total_changes() AS count').get().count;
  const directory = '/missing-selection-artifact', reads = [], readFile = fs.readFile;
  const mock = t.mock.method(fs, 'readFile', async (path, ...args) => {
    if (String(path).startsWith(directory)) reads.push(String(path));
    return readFile(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const owner = await open(badPin ? [{ kind: 'artifact', directory, artifactId: 'a'.repeat(64), installations: [] }] : []);
    await owner.activate();
    assert.deepEqual(owner.status(), { kind: 'journal-invalid' });
    await assert.rejects(owner.select({ id: 'later', expectedRevision: 0, selection: { version: 1, artifacts: [] } }), /unavailable/);
    const request = { kind: 'apply', requestId: 'apply-later', selectionId: 'startup', expectedRevision: 0 };
    await assert.rejects(owner.live(request), /unavailable/);
    await assert.rejects(owner.live({ ...request, kind: 'retry', requestId: 'retry-later', afterAttemptId: 'lost' }), /unavailable/);
    assert.equal(activations(), 1);
    assert.deepEqual(reads, []);
    assert.deepEqual(snapshot(database), before);
    assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changes);
    await owner.close();
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

for (const populated of [false, true]) test(`fresh startup rechecks concurrent ${populated ? 'populated' : 'empty'} v2 before any seed writes`, async t => {
  const { database, open, activations } = fixture(t);
  const original = await open();
  const definitions = database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name GLOB 'service_extension_*'").all();
  const seed = database.prepare('SELECT * FROM service_extension_selections').get();
  await original.close();
  database.exec('DROP TABLE service_extension_attempts; DROP TABLE service_extension_selections; DROP TABLE service_extension_selection_schema');
  const opening = open();
  for (const { sql } of definitions) database.exec(sql);
  database.prepare('INSERT INTO service_extension_selection_schema VALUES(1,2,?)').run('selection-test-host');
  if (populated) {
    database.prepare('INSERT INTO service_extension_selections VALUES(?,?,?,?,?)').run(...Object.values(seed));
    database.exec(`INSERT INTO service_extension_attempts(id,selection,intent,outcome) VALUES('concurrent','startup','{"kind":"boot"}','{"kind":"pending"}')`);
  }
  const before = snapshot(database), changes = database.prepare('SELECT total_changes() AS count').get().count;
  await assert.rejects(opening, populated ? /revision-conflict/ : /Invalid selection journal/);
  assert.equal(activations(), 0);
  assert.deepEqual(snapshot(database), before);
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changes);
});

test('selection commit after total namespace loss remains unavailable without recreating the journal', async t => {
  const { database, open, activations } = fixture(t);
  const owner = await open();
  const selecting = owner.select({ id: 'later', expectedRevision: 0, selection: { version: 1, artifacts: [] } });
  database.exec('DROP TABLE service_extension_attempts; DROP TABLE service_extension_selections; DROP TABLE service_extension_selection_schema');
  const before = snapshot(database), changes = database.prepare('SELECT total_changes() AS count').get().count;
  await assert.rejects(selecting, /unavailable/);
  await assert.rejects(owner.select({ id: 'another', expectedRevision: 0, selection: { version: 1, artifacts: [] } }), /unavailable/);
  assert.equal(activations(), 0);
  assert.deepEqual(snapshot(database), before);
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changes);
  await owner.close();
});
