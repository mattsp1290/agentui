import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../packages/host/dist/durable-model.js';
import { fixture, projection, scope, installed, command, note, run, question } from './fixture.mjs';

const predicate = `json_extract(target, '$.kind')='provider' AND json_extract(target, '$.operation.kind')='send' AND json_extract(target, '$.operation.protocol')='ag-ui'`;
const history = `SELECT 1 FROM commands INDEXED BY commands_tagged_send_key WHERE host=? AND conversation=? AND ${predicate}
  AND json_extract(target, '$.operation.request.threadId')=? AND json_extract(target, '$.operation.request.runId')=? LIMIT 1`;
const tables = ['conversations', 'runs', 'commands', 'pending_decisions', 'events', 'host_limits'];
const saved = db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));

for (const format of [2, 3]) test(`format ${format} upgrade builds tagged index without rewriting durable history`, async t => {
  const f = fixture(t, { async afterAcceptance() { throw new Error('Reply lost'); } }), host = f.open();
  host.createConversation(scope, installed);
  host.append(scope, { ...note('saved'), runs: [run()], decisions: [question()] });
  await host.conversation(scope).submit(command('uncertain'));
  host.close(); await host.drained;
  const db = new DatabaseSync(f.path);
  db.exec(`DROP TABLE frontend_observation_events; DROP TABLE frontend_observation_runs; DROP INDEX commands_tagged_send_key; DROP TABLE frontend_send_owners; DROP TABLE frontend_send_tombstones; DROP TABLE command_images; DROP TABLE images; PRAGMA user_version=${format}`);
  const before = saved(db); db.close();
  const store = new SqliteStore(f.path, projection, budgets());
  try {
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 9);
    assert.deepEqual(saved(store.db), before);
    assert.equal(store.db.prepare(history).get(scope.hostId, scope.conversationId, 'missing', 'missing'), undefined);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM commands INDEXED BY commands_tagged_send_key WHERE " + predicate).get().n, 0);
  } finally { store.close(); }
});

for (const format of [2, 3]) test(`format ${format} index failure rolls back owner schema and version publication`, t => {
  const f = fixture(t), store = new SqliteStore(f.path, projection, budgets());
  store.create(scope, installed);
  assert.equal(store.admit(command('saved'), { kind: 'supported' }).kind, 'owned');
  store.close();
  const db = new DatabaseSync(f.path);
  db.exec(`DROP TABLE frontend_observation_events; DROP TABLE frontend_observation_runs; DROP INDEX commands_tagged_send_key; DROP TABLE frontend_send_owners; DROP TABLE frontend_send_tombstones; DROP TABLE command_images; DROP TABLE images; PRAGMA user_version=${format}; UPDATE commands SET target='invalid json'`);
  const before = saved(db); db.close();
  assert.throws(() => new SqliteStore(f.path, projection, budgets()), /malformed JSON/);
  const reader = new DatabaseSync(f.path);
  try {
    assert.equal(reader.prepare('PRAGMA user_version').get().user_version, format);
    assert.deepEqual(saved(reader), before);
    for (const name of ['images', 'command_images', 'frontend_send_owners', 'frontend_send_tombstones', 'commands_tagged_send_key']) {
      assert.equal(reader.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(name), undefined);
    }
  } finally { reader.close(); }
});

test('existing current format refuses a missing or unusable required history index', t => {
  const f = fixture(t), store = new SqliteStore(f.path, projection, budgets()); store.close();
  const db = new DatabaseSync(f.path); db.exec('DROP INDEX commands_tagged_send_key'); db.close();
  assert.throws(() => new SqliteStore(f.path, projection, budgets()), /no such index/);
  const reader = new DatabaseSync(f.path);
  assert.equal(reader.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get('commands_tagged_send_key'), undefined);
  reader.exec('CREATE INDEX commands_tagged_send_key ON commands(host) WHERE conversation IS NULL'); reader.close();
  assert.throws(() => new SqliteStore(f.path, projection, budgets()), /no query solution/);
});

test('tagged key miss searches all four expression-index columns despite large historical targets', t => {
  const f = fixture(t), store = new SqliteStore(f.path, projection, budgets()); t.after(() => store.close());
  store.create(scope, installed);
  assert.equal(store.admit(command('seed'), { kind: 'supported' }).kind, 'owned');
  const insert = store.db.prepare(`INSERT INTO commands(host,conversation,id,operation,intent,target,observation,receipt)
    SELECT host,conversation,?,?,intent,?,observation,receipt FROM commands WHERE id='seed'`);
  store.transaction(() => {
    for (let index = 0; index < 400; index++) insert.run(`history-${index}`, `operation-${index}`, JSON.stringify({ kind: 'provider', operation: {
      kind: 'send', protocol: 'ag-ui', request: { threadId: 'thread', runId: `run-${index}`, history: 'x'.repeat(16_000) },
    } }));
  });
  const index = store.db.prepare("PRAGMA index_list('commands')").all().find(row => row.name === 'commands_tagged_send_key');
  assert.equal(index.unique, 0); assert.equal(index.partial, 1);
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${history}`).all(scope.hostId, scope.conversationId, 'thread', 'missing').map(row => row.detail).join('\n');
  assert.match(plan, /SEARCH commands USING (?:COVERING )?INDEX commands_tagged_send_key \(host=\? AND conversation=\? AND <expr>=\? AND <expr>=\?\)/);
  assert.equal(store.db.prepare(history).get(scope.hostId, scope.conversationId, 'thread', 'missing'), undefined);
  assert.ok(store.db.prepare(history).get(scope.hostId, scope.conversationId, 'thread', 'run-399'));
  assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM commands INDEXED BY commands_tagged_send_key WHERE ${predicate}`).get().n, 400);
});

function replaceTable(db, table, change) {
  const original = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table).sql;
  const damaged = change(original);
  assert.notEqual(damaged, original);
  db.exec(`DROP TABLE ${table}`);
  db.exec(damaged);
}
for (const [name, mutation, error] of [
  ['images', db => db.exec('DROP TABLE images'), /missing images/],
  ['command_images', db => db.exec('DROP TABLE command_images'), /missing command_images/],
  ['owners', db => db.exec('DROP TABLE frontend_send_owners'), /Invalid frontend ownership schema/],
  ['tombstones', db => db.exec('DROP TABLE frontend_send_tombstones'), /Invalid frontend ownership schema/],
  ['owner primary key', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace('PRIMARY KEY(host,conversation,command_id),', '')), /Invalid frontend ownership schema/],
  ['tombstone primary key', db => replaceTable(db, 'frontend_send_tombstones', sql => sql.replace('PRIMARY KEY(host,conversation,command_id,actor_id),', '')), /Invalid frontend ownership schema/],
  ['owner state constraint', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace(" CHECK(state IN ('available','unavailable'))", '')), /Invalid frontend ownership schema/],
  ['tombstone conversation cascade', db => replaceTable(db, 'frontend_send_tombstones', sql => sql.replace('REFERENCES conversations(host,conversation)', 'REFERENCES conversations(host,conversation) ON DELETE CASCADE')), /Invalid frontend ownership schema/],
  ['owner nullable key', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace('thread_id TEXT NOT NULL', 'thread_id TEXT')), /Invalid frontend ownership schema/],
  ['owner run uniqueness', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace('UNIQUE(host,conversation,thread_id,run_id),', '')), /Invalid frontend ownership schema/],
  ['wrong run columns', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace('UNIQUE(host,conversation,thread_id,run_id)', 'UNIQUE(host,conversation,thread_id,actor_id)')), /Invalid frontend ownership schema/],
  ['partial run uniqueness', db => {
    replaceTable(db, 'frontend_send_owners', sql => sql.replace('UNIQUE(host,conversation,thread_id,run_id),', ''));
    db.exec("CREATE UNIQUE INDEX partial_run ON frontend_send_owners(host,conversation,thread_id,run_id) WHERE state='available'");
  }, /Invalid frontend ownership schema/],
  ['missing command foreign key', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace(/,\s*FOREIGN KEY\(host,conversation,command_id\) REFERENCES commands\(host,conversation,id\) DEFERRABLE INITIALLY DEFERRED/, '')), /Invalid frontend ownership schema/],
  ['wrong command foreign key columns', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace('REFERENCES commands(host,conversation,id)', 'REFERENCES commands(host,id,conversation)')), /Invalid frontend ownership schema/],
  ['wrong command foreign key order', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace('FOREIGN KEY(host,conversation,command_id)', 'FOREIGN KEY(conversation,host,command_id)')), /Invalid frontend ownership schema/],
  ['command foreign key cascade', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace(' DEFERRABLE INITIALLY DEFERRED', ' ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED')), /Invalid frontend ownership schema/],
  ['command foreign key update', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace(' DEFERRABLE INITIALLY DEFERRED', ' ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED')), /Invalid frontend ownership schema/],
  ['immediate command foreign key', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace(' DEFERRABLE INITIALLY DEFERRED', '')), /Invalid frontend ownership schema/],
  ['deferred declaration in a block comment', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace(' DEFERRABLE INITIALLY DEFERRED', ' /* FOREIGN KEY(host,conversation,command_id) REFERENCES commands(host,conversation,id) DEFERRABLE INITIALLY DEFERRED */')), /Invalid frontend ownership schema/],
  ['deferred declaration in a line comment', db => replaceTable(db, 'frontend_send_owners', sql => sql.replace(' DEFERRABLE INITIALLY DEFERRED', ' -- FOREIGN KEY(host,conversation,command_id) REFERENCES commands(host,conversation,id) DEFERRABLE INITIALLY DEFERRED\n')), /Invalid frontend ownership schema/],
  ...['frontend_send_owners', 'frontend_send_tombstones'].map(table => [table + ' conversation foreign key', db => replaceTable(db, table, sql => sql.replace('REFERENCES conversations(host,conversation)', 'REFERENCES conversations(conversation,host)')), /Invalid frontend ownership schema/]),
  ['keyed tombstones', db => db.exec('ALTER TABLE frontend_send_tombstones ADD COLUMN run_id TEXT'), /Invalid frontend ownership schema/],
  ['private mixed owner schema', db => {
    db.exec('DROP TABLE frontend_send_owners; DROP TABLE frontend_send_tombstones; CREATE TABLE frontend_sends(host TEXT, conversation TEXT, command_id TEXT, actor_id TEXT, platform TEXT, state TEXT, thread_id TEXT, run_id TEXT)');
  }, /Invalid frontend ownership schema/],
]) test(`current format refuses ${name} damage without repairing its schema`, t => {
  const f = fixture(t), store = new SqliteStore(f.path, projection, budgets()); store.close();
  const db = new DatabaseSync(f.path); mutation(db);
  const schema = db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(); db.close();
  assert.throws(() => new SqliteStore(f.path, projection, budgets()), error);
  const reader = new DatabaseSync(f.path);
  try {
    assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 9);
    assert.deepEqual(reader.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all(), schema);
  } finally { reader.close(); }
});

test('owners require real unique keys while keyless tombstones remain actor-specific', t => {
  const store = new SqliteStore(fixture(t).path, projection, budgets()); t.after(() => store.close()); store.create(scope, installed);
  const insert = store.db.prepare('INSERT INTO frontend_send_owners VALUES (?,?,?,?,?,?,?)');
  for (const [state, thread, run] of [['available', null, null], ['unavailable', 'thread', null], ['available', null, 'run']]) {
    assert.throws(() => insert.run(scope.hostId, scope.conversationId, 'command', 'bad', state, thread, run), /NOT NULL constraint/);
  }
  assert.throws(() => insert.run(scope.hostId, scope.conversationId, 'command', 'bad', 'tombstone', 'thread', 'run'), /CHECK constraint/);
  const tombstone = store.db.prepare('INSERT INTO frontend_send_tombstones VALUES (?,?,?,?)');
  for (const actor of ['a', 'b']) tombstone.run(scope.hostId, scope.conversationId, 'command', actor);
  assert.throws(() => tombstone.run(scope.hostId, scope.conversationId, 'command', 'a'), /UNIQUE constraint/);
  assert.throws(() => store.db.prepare('SELECT thread_id,run_id FROM frontend_send_tombstones'), /no such column/);
  assert.throws(() => insert.run(scope.hostId, scope.conversationId, 'missing', 'owner', 'available', 'thread', 'run'), /FOREIGN KEY constraint/);
  assert.equal(store.admit(command('command'), { kind: 'supported' }).kind, 'owned');
  insert.run(scope.hostId, scope.conversationId, 'command', 'owner', 'unavailable', 'thread', 'run');
  assert.throws(() => insert.run(scope.hostId, scope.conversationId, 'command', 'other', 'available', 'thread2', 'run2'), /UNIQUE constraint/);
  assert.throws(() => insert.run(scope.hostId, scope.conversationId, 'another', 'other', 'available', 'thread', 'run'), /UNIQUE constraint/);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM frontend_send_owners').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM frontend_send_tombstones').get().n, 2);
});

test('private capture-only format four is refused rather than guessed or repaired', t => {
  const f = fixture(t), store = new SqliteStore(f.path, projection, budgets());
  store.db.exec('DROP TABLE frontend_observation_events; DROP TABLE frontend_observation_runs; DROP TABLE command_images; DROP TABLE images; PRAGMA user_version=4'); store.close();
  assert.throws(() => new SqliteStore(f.path, projection, budgets()), /Incomplete database schema version 4: missing images/);
  const reader = new DatabaseSync(f.path);
  try {
    assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 4);
    assert.equal(reader.prepare("SELECT 1 FROM sqlite_schema WHERE name='images'").get(), undefined);
  } finally { reader.close(); }
});
