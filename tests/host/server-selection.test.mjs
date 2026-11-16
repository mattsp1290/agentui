import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createServerSelection } from '../../apps/host/build/tsc/server-selection.js';

function fixture(t) {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const open = () => createServerSelection({ database: { database, hostId: 'selection-test-host' }, entries: [],
    runtime: () => ({ kind: 'empty' }), isClosing: () => false });
  return { database, open };
}

function snapshot(database) {
  const schema = database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  return { schema, rows: schema.filter(row => row.type === 'table').map(row =>
    database.prepare(`SELECT * FROM "${row.name.replaceAll('"', '""')}"`).all()) };
}

test('missing boot history withholds an existing selection without replay or schema repair', async t => {
  const { database, open } = fixture(t);
  const original = await open();
  database.prepare('INSERT INTO service_extension_boots(id,selection,outcome) VALUES(?,?,?)')
    .run('lost-attempt', 'startup', '{"kind":"applying"}');
  await original.close();
  database.exec('DROP TABLE service_extension_boots');
  const schema = database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all();
  const selections = database.prepare('SELECT * FROM service_extension_selections').all();
  const changes = database.prepare('SELECT total_changes() AS count').get().count;
  const reopened = await open();
  let activations = 0;
  await reopened.activate(async () => { activations++; return { kind: 'replaced', generation: null }; });
  assert.equal(activations, 0);
  assert.deepEqual(reopened.status(), { kind: 'journal-invalid' });
  await assert.rejects(reopened.select({ id: 'retry', expectedRevision: 0, selection: { version: 1, artifacts: [] } }), /unavailable/);
  assert.deepEqual(database.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(), schema);
  assert.deepEqual(database.prepare('SELECT * FROM service_extension_selections').all(), selections);
  assert.equal(database.prepare('SELECT total_changes() AS count').get().count, changes);
  await reopened.close();
});

const tables = ['service_extension_selection_schema', 'service_extension_selections', 'service_extension_boots'];
for (const [name, damage] of [
  ...tables.map(table => [`missing ${table}`, `DROP TABLE ${table}`]),
  ...tables.map(table => [`only ${table}`, tables.filter(other => other !== table).map(other => `DROP TABLE ${other}`).join(';')]),
  ...tables.map(table => [`view instead of ${table}`, `DROP TABLE ${table}; CREATE VIEW ${table} AS SELECT 1`]),
  ['missing marker', 'DELETE FROM service_extension_selection_schema'],
  ['unseeded schema missing marker', 'DELETE FROM service_extension_selections; DELETE FROM service_extension_selection_schema'],
  ['unknown version', 'UPDATE service_extension_selection_schema SET version=2'],
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
  const { database, open } = fixture(t);
  await (await open()).close();
  database.exec(damage);
  const before = snapshot(database), changes = database.prepare('SELECT total_changes() AS count').get().count;
  const owner = await open();
  let activations = 0;
  await owner.activate(async () => { activations++; return { kind: 'replaced', generation: null }; });
  assert.equal(activations, 0);
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
    await owner.activate(async () => assert.fail('Invalid journal activated'));
    assert.deepEqual(owner.status(), { kind: 'journal-invalid' });
    assert.deepEqual(snapshot(database), before);
    assert.equal(database.prepare('SELECT total_changes() AS count').get().count, 0);
    await owner.close();
  });
}

test('fresh, fully initialized unseeded and settled empty journals activate normally', async t => {
  const { database, open } = fixture(t);
  database.exec('CREATE TABLE serviceXextensionYfuture(value TEXT)');
  let owner = await open();
  assert.equal(owner.status().desired.id, 'startup');
  await owner.close();
  database.exec('DELETE FROM service_extension_selections');
  for (let attempt = 0; attempt < 2; attempt++) {
    owner = await open();
    let activations = 0;
    await owner.activate(async () => { activations++; return { kind: 'replaced', generation: null }; });
    assert.equal(activations, 1);
    assert.equal(owner.status().desired.id, 'startup');
    assert.equal(owner.status().desiredRevision, 0);
    assert.equal(owner.status().runtime.kind, 'applied-empty');
    await owner.close();
  }
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM service_extension_selections').get().count, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM service_extension_boots').get().count, 2);
});
