import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  for (const id of ['old-0', 'old-1']) assert.deepEqual(owner.status({ kind: 'attempt', id }).operation.outcome, { kind: 'interrupted' });
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

for (const seeded of [true, false]) test(`v1 migration refuses an ignored version marker update: ${seeded ? 'populated' : 'unseeded'}`, async t => {
  const { database, open } = oldJournal(t, { seeded });
  database.exec(`CREATE TRIGGER suppress_migration_version BEFORE UPDATE ON service_extension_selection_schema BEGIN SELECT RAISE(IGNORE); END`);
  const before = snapshot(database);
  await assert.rejects(open(), error => error.message === (seeded ? 'Selection migration failed' : 'Invalid selection journal'));
  assert.deepEqual(snapshot(database), before);
  assert.equal(database.prepare('SELECT version FROM service_extension_selection_schema').get().version, 1);
});

for (const kind of ['pending', 'applying']) test(`later v2 retry cannot authorize original ${kind} history before normalization`, async t => {
  const { owner, database } = await fixture(t); await owner.close();
  database.exec(`INSERT INTO service_extension_attempts(id,selection,intent,outcome) VALUES
    ('unresolved','startup','{"kind":"boot"}','{"kind":"${kind}"}'),
    ('bad','startup','{"afterAttemptId":"unresolved","expectedRevision":0,"kind":"retry","requestId":"bad","selectionId":"startup"}','{"kind":"interrupted"}')`);
  const before = snapshot(database), changes = database.prepare('SELECT total_changes() AS n').get().n;
  const reopened = await createServerSelection({ database: { database, hostId: 'attempt-test' }, entries: [], runtime: () => ({ kind: 'empty' }),
    isClosing: () => false, replace: async () => assert.fail('Invalid journal activated'), stopRuntime() {} });
  assert.deepEqual(reopened.status(), { kind: 'journal-invalid' }); await reopened.activate();
  assert.deepEqual(snapshot(database), before); assert.equal(database.prepare('SELECT total_changes() AS n').get().n, changes);
  await reopened.close();
});

for (const outcomes of [ ['pending'], ['applying'], ['applied-empty', 'pending', 'interrupted', 'applying', 'grant-mismatch'] ]) {
  for (const failure of ['abort', 'ignore', 'commit']) test(`v2 recovery ${failure} failure rolls back ${outcomes.join('/')} history`, async t => {
    const { owner, database } = await fixture(t); await owner.close();
    for (const [index, kind] of outcomes.entries()) database.prepare('INSERT INTO service_extension_attempts(id,selection,intent,outcome) VALUES(?,?,?,?)')
      .run('recovery-' + index, 'startup', '{"kind":"boot"}', JSON.stringify({ kind }));
    const failedId = 'recovery-' + outcomes.findLastIndex(kind => kind === 'pending' || kind === 'applying');
    if (failure === 'commit') database.exec(`CREATE TABLE recovery_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE recovery_child (id INTEGER REFERENCES recovery_parent(id) DEFERRABLE INITIALLY DEFERRED)`);
    database.exec(`CREATE TRIGGER recovery_failure BEFORE UPDATE ON service_extension_attempts WHEN OLD.id='${failedId}' BEGIN
      ${failure === 'commit' ? 'INSERT INTO recovery_child VALUES(1)' : `SELECT RAISE(${failure === 'abort' ? "ABORT,'PRIVATE_RECOVERY'" : 'IGNORE'})`}; END`);
    const before = snapshot(database);
    let effects = 0, stops = 0;
    await assert.rejects(createServerSelection({ database: { database, hostId: 'attempt-test' }, entries: [],
      runtime: () => ({ kind: 'empty' }), isClosing: () => false,
      replace: async () => { effects++; return { kind: 'replaced', generation: null }; }, stopRuntime() { stops++; } }),
    error => error.message === 'Selection recovery failed');
    assert.deepEqual(snapshot(database), before);
    assert.equal(database.prepare('SELECT version FROM service_extension_selection_schema').get().version, 2);
    assert.equal(effects, 0); assert.equal(stops, 0);
  });
}

for (const damage of ['outcome', 'selection', 'intent', 'earlier-row', 'deleted-row']) test(`v2 recovery refuses post-update ${damage} damage before mirroring`, async t => {
  const { owner, database } = await fixture(t);
  await owner.select({ id: 'other', expectedRevision: 0, selection: empty }); await owner.close();
  database.exec(`INSERT INTO service_extension_attempts(id,selection,intent,outcome) VALUES
    ('first','startup','{"kind":"boot"}','{"kind":"pending"}'),
    ('second','startup','{"kind":"boot"}','{"kind":"applying"}')`);
  const mutations = {
    outcome: `UPDATE service_extension_attempts SET outcome='{"kind":"applying"}' WHERE id=NEW.id`,
    selection: "UPDATE service_extension_attempts SET selection='other' WHERE id=NEW.id",
    intent: `UPDATE service_extension_attempts SET intent='{}' WHERE id=NEW.id`,
    'earlier-row': `UPDATE service_extension_attempts SET outcome='{"kind":"pending"}' WHERE id='first'`,
    'deleted-row': 'DELETE FROM service_extension_attempts WHERE id=NEW.id',
  };
  database.exec(`CREATE TRIGGER damage_recovery AFTER UPDATE ON service_extension_attempts
    WHEN NEW.id='second' AND NEW.outcome='{"kind":"interrupted"}' BEGIN ${mutations[damage]}; END`);
  const before = snapshot(database);
  let effects = 0;
  await assert.rejects(createServerSelection({ database: { database, hostId: 'attempt-test' }, entries: [],
    runtime: () => ({ kind: 'empty' }), isClosing: () => false,
    replace: async () => { effects++; return { kind: 'replaced', generation: null }; }, stopRuntime() {} }),
  error => error.message === 'Selection recovery failed');
  assert.deepEqual(snapshot(database), before); assert.equal(effects, 0);
});

test('v2 recovery mirrors exactly the interrupted worklist and leaves terminal bytes untouched', async t => {
  const { owner, database } = await fixture(t); await owner.close();
  const outcomes = [ { kind: 'applied' }, { kind: 'pending' }, { kind: 'applied-empty' }, { kind: 'applying' },
    { kind: 'interrupted' }, { kind: 'grant-mismatch' }, { kind: 'deferred', reason: 'active-work' },
    { kind: 'failed', failure: 'cleanup', recovery: 'restart' } ];
  for (const [index, outcome] of outcomes.entries()) database.prepare('INSERT INTO service_extension_attempts(id,selection,intent,outcome) VALUES(?,?,?,?)')
    .run('recovery-' + index, 'startup', '{"kind":"boot"}', ' ' + JSON.stringify(outcome) + ' ');
  database.exec(`CREATE TRIGGER terminal_unchanged BEFORE UPDATE ON service_extension_attempts
    WHEN json_extract(OLD.outcome,'$.kind') NOT IN ('pending','applying') BEGIN SELECT RAISE(ABORT,'TERMINAL_CHANGED'); END`);
  const before = database.prepare('SELECT * FROM service_extension_attempts ORDER BY sequence').all();
  const changes = database.prepare('SELECT total_changes() AS n').get().n;
  const reopened = await createServerSelection({ database: { database, hostId: 'attempt-test' }, entries: [],
    runtime: () => ({ kind: 'empty' }), isClosing: () => false, replace: async () => assert.fail('Recovery activated'), stopRuntime() {} });
  t.after(() => reopened.close());
  const after = database.prepare('SELECT * FROM service_extension_attempts ORDER BY sequence').all();
  for (const [index, row] of before.entries()) {
    const outcome = ['pending', 'applying'].includes(outcomes[index].kind) ? { kind: 'interrupted' } : outcomes[index];
    assert.deepEqual({ ...after[index] }, { ...row, outcome: outcome.kind === 'interrupted' && outcomes[index].kind !== 'interrupted' ? JSON.stringify(outcome) : row.outcome });
    assert.deepEqual(reopened.status({ kind: 'attempt', id: row.id }).operation.outcome, outcome);
  }
  assert.equal(database.prepare('SELECT total_changes() AS n').get().n - changes, 2);
  assert.equal(reopened.status().lastApplied.attemptId, 'recovery-2');
  assert.deepEqual(reopened.status().runtime, { kind: 'withheld' });
  await reopened.activate();
  assert.deepEqual(database.prepare('SELECT * FROM service_extension_attempts ORDER BY sequence').all(), after);
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

async function diskFixture(t, replace = async () => ({ kind: 'replaced', generation: null })) {
  const directory = await mkdtemp(join(tmpdir(), 'selection-admission-'));
  const database = new DatabaseSync(join(directory, 'journal.sqlite'));
  const external = new DatabaseSync(join(directory, 'journal.sqlite'));
  const owners = [];
  let effects = 0, stops = 0;
  t.after(async () => {
    for (const owner of owners) await owner.close();
    external.close(); database.close(); await rm(directory, { recursive: true, force: true });
  });
  const open = async (entries = []) => {
    const owner = await createServerSelection({ database: { database, hostId: 'admission-test' }, entries,
      runtime: () => ({ kind: 'empty' }), isClosing: () => false,
      replace: async () => { effects++; return replace(); }, stopRuntime() { stops++; } });
    owners.push(owner); return owner;
  };
  return { database, external, open, effects: () => effects, stops: () => stops };
}

for (const changed of ['applied-empty', 'applying', 'unknown', 'new-predecessor']) test(`transaction admission decodes persisted predecessor after load: ${changed}`, async t => {
  const f = await diskFixture(t, async () => ({ kind: 'deferred', reason: 'active-work' }));
  const owner = await f.open();
  await owner.live({ kind: 'apply', requestId: 'first', selectionId: 'startup', expectedRevision: 0 });
  if (changed === 'new-predecessor') f.external.exec(`INSERT INTO service_extension_attempts(id,selection,intent,outcome)
    VALUES('external','startup','{"kind":"boot"}','{"kind":"interrupted"}')`);
  else f.external.prepare('UPDATE service_extension_attempts SET outcome=? WHERE id=?').run(JSON.stringify({ kind: changed }), 'first');
  await assert.rejects(owner.live({ kind: 'retry', requestId: 'second', selectionId: 'startup', expectedRevision: 0, afterAttemptId: 'first' }),
    changed === 'unknown' ? /unavailable/ : /attempt-conflict/);
  assert.equal(f.database.prepare("SELECT count(*) AS n FROM service_extension_attempts WHERE id='second'").get().n, 0);
  assert.equal(f.effects(), 1); assert.equal(f.stops(), Number(changed === 'unknown'));
});

for (const outcome of [
  { kind: 'pending' }, { kind: 'applying' }, { kind: 'interrupted' }, { kind: 'deferred', reason: 'active-work' },
  { kind: 'grant-mismatch' }, { kind: 'failed', failure: 'cleanup', recovery: 'restart' }, { kind: 'unknown' },
]) test(`boot admission rereads a settled predecessor changed after load to ${outcome.kind}`, async t => {
  const f = await diskFixture(t), original = await f.open();
  await original.activate(); await original.close();
  const owner = await f.open();
  f.external.prepare('UPDATE service_extension_attempts SET outcome=?').run(JSON.stringify(outcome));
  const before = snapshot(f.database);
  if (outcome.kind === 'unknown') await assert.rejects(owner.activate(), /unavailable/);
  else await owner.activate();
  assert.equal(f.effects(), 1); assert.equal(f.stops(), Number(outcome.kind === 'unknown'));
  assert.deepEqual(snapshot(f.database), before);
  assert.equal(owner.status().runtime.kind, 'withheld');
});

test('boot admission withholds a newer persisted unsettled predecessor after load', async t => {
  const f = await diskFixture(t), original = await f.open();
  await original.activate(); await original.close();
  const owner = await f.open();
  f.external.exec(`INSERT INTO service_extension_attempts(id,selection,intent,outcome)
    VALUES('external','startup','{"kind":"boot"}','{"kind":"interrupted"}')`);
  const before = snapshot(f.database);
  await owner.activate();
  assert.equal(f.effects(), 1); assert.equal(f.stops(), 0);
  assert.deepEqual(snapshot(f.database), before);
});

test('retry admission uses persisted grant mismatch and restored binding after restart', async t => {
  let deferred = true;
  const f = await diskFixture(t, async () => deferred ? { kind: 'deferred', reason: 'active-work' } : { kind: 'replaced', generation: null });
  const original = await f.open();
  const first = { kind: 'apply', requestId: 'first', selectionId: 'startup', expectedRevision: 0 };
  await original.live(first); await original.close();
  const owner = await f.open(golden.entries);
  f.external.prepare('UPDATE service_extension_attempts SET outcome=? WHERE id=?').run('{"kind":"grant-mismatch"}', 'first');
  const retry = { kind: 'retry', requestId: 'second', selectionId: 'startup', expectedRevision: 0, afterAttemptId: 'first' };
  const before = snapshot(f.database);
  await assert.rejects(owner.live(retry), /attempt-conflict/);
  assert.deepEqual(snapshot(f.database), before);
  assert.equal(f.effects(), 1); assert.equal(f.stops(), 0);
  await owner.close();
  const restored = await f.open(); deferred = false;
  await restored.activate(); assert.equal(f.effects(), 1);
  assert.equal((await restored.live(retry)).outcome.kind, 'applied-empty');
  assert.equal((await restored.live(first)).outcome.kind, 'grant-mismatch');
  assert.equal(f.effects(), 2);
});

for (const [phase, error, persisted, effects] of [
  ['insert', 'unavailable', undefined, 0],
  ['applying', 'unavailable', 'pending', 0],
  ['grant-mismatch', 'unavailable', 'pending', 0],
  ['authority', 'unavailable', 'pending', 0],
  ['observation', 'uncertain', 'failed', 1],
  ['observation-record', 'uncertain', 'applying', 1],
  ['final', 'uncertain', 'applying', 1],
]) test(`execution failure at ${phase} preserves its durable phase and stops once`, async t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  let calls = 0, stops = 0, closing = false;
  const open = entries => createServerSelection({ database: { database, hostId: 'phase-test' }, entries,
    runtime: () => ({ kind: 'empty' }), isClosing: () => closing,
    replace: async () => {
      calls++;
      if (phase.startsWith('observation')) throw new Error('PRIVATE_OBSERVATION');
      return { kind: 'replaced', generation: null };
    }, stopRuntime() { stops++; closing = true; } });
  let owner = await open([]);
  if (phase === 'grant-mismatch') { await owner.close(); owner = await open(golden.entries); }
  t.after(() => owner.close());
  if (phase === 'authority') database.exec(`CREATE TRIGGER authority_damage AFTER UPDATE ON service_extension_attempts
    WHEN json_extract(NEW.outcome,'$.kind')='applying' BEGIN UPDATE service_extension_selections SET revision=revision+1; END`);
  else if (phase !== 'observation') {
    const outcome = phase === 'final' ? 'applied-empty' : phase === 'observation-record' ? 'failed' : phase;
    database.exec(`CREATE TRIGGER fail_write BEFORE ${phase === 'insert' ? 'INSERT' : 'UPDATE'} ON service_extension_attempts
      ${phase === 'insert' ? '' : `WHEN json_extract(NEW.outcome,'$.kind')='${outcome}'`} BEGIN SELECT RAISE(ABORT,'PRIVATE_WRITE'); END`);
  }
  await assert.rejects(owner.live({ kind: 'apply', requestId: 'failed', selectionId: 'startup', expectedRevision: 0 }),
    caught => caught.message === `Selection ${error}`);
  assert.equal(calls, effects); assert.equal(stops, 1);
  const row = database.prepare("SELECT outcome FROM service_extension_attempts WHERE id='failed'").get();
  assert.equal(row && JSON.parse(row.outcome).kind, persisted);
  if (phase === 'authority') assert.equal(database.prepare("SELECT revision FROM service_extension_selections WHERE id='startup'").get().revision, 0);
  if (phase === 'observation') assert.deepEqual(JSON.parse(row.outcome), { kind: 'failed', failure: 'discovery', recovery: 'replace' });
  assert.equal(owner.status().runtime.kind, error === 'uncertain' ? 'uncertain' : 'closed');
});

for (const damage of ['authority', 'outcome']) test(`final outcome trigger damage rolls back before acknowledgement: ${damage}`, async t => {
  const f = await diskFixture(t), owner = await f.open();
  const change = damage === 'authority'
    ? 'UPDATE service_extension_selections SET revision=revision+1 WHERE id=NEW.selection'
    : `UPDATE service_extension_attempts SET outcome='{"kind":"interrupted"}' WHERE id=NEW.id`;
  f.database.exec(`CREATE TRIGGER damage_final AFTER UPDATE ON service_extension_attempts
    WHEN json_extract(NEW.outcome,'$.kind')='applied-empty' BEGIN ${change}; END`);
  await assert.rejects(owner.live({ kind: 'apply', requestId: 'final', selectionId: 'startup', expectedRevision: 0 }),
    error => error.message === 'Selection uncertain');
  assert.equal(f.effects(), 1); assert.equal(f.stops(), 1);
  assert.equal(f.database.prepare("SELECT revision FROM service_extension_selections WHERE id='startup'").get().revision, 0);
  assert.equal(f.database.prepare("SELECT outcome FROM service_extension_attempts WHERE id='final'").get().outcome, '{"kind":"applying"}');
  const status = owner.status();
  assert.deepEqual(status.runtime, { kind: 'uncertain' });
  assert.deepEqual(status.operation.outcome, { kind: 'applying' });
  assert.equal(status.lastApplied, null);
});

test('first apply records changed grants, exact replay precedes fresh retry refusal', async t => {
  const f = await diskFixture(t), original = await f.open();
  await original.close();
  const owner = await f.open(golden.entries);
  const request = { kind: 'apply', requestId: 'first', selectionId: 'startup', expectedRevision: 0 };
  const mismatch = await owner.live(request);
  assert.equal(mismatch.outcome.kind, 'grant-mismatch');
  assert.deepEqual(await owner.live(request), mismatch);
  const before = snapshot(f.database);
  await assert.rejects(owner.live({ ...request, kind: 'retry', requestId: 'retry', afterAttemptId: 'first' }), /attempt-conflict/);
  assert.deepEqual(snapshot(f.database), before);
  assert.equal(f.effects(), 0); assert.equal(f.stops(), 0);
});

test('historical replay precedes current cleanup refusal and restart enables explicit retry', async t => {
  const database = new DatabaseSync(':memory:'); t.after(() => database.close());
  let state = { kind: 'empty' }, effects = 0, stops = 0;
  const failure = { kind: 'failed', failure: 'cleanup', recovery: 'restart' };
  const open = () => createServerSelection({ database: { database, hostId: 'cleanup-test' }, entries: [],
    runtime: () => state, isClosing: () => false, replace: async () => { effects++; state = failure; return failure; }, stopRuntime() { stops++; } });
  const owner = await open(); t.after(() => owner.close());
  const first = { kind: 'apply', requestId: 'first', selectionId: 'startup', expectedRevision: 0 };
  const failed = await owner.live(first);
  assert.deepEqual(await owner.live(first), failed);
  const retry = { kind: 'retry', requestId: 'retry', selectionId: 'startup', expectedRevision: 0, afterAttemptId: 'first' };
  const before = snapshot(database);
  await assert.rejects(owner.live(retry), /attempt-conflict/);
  assert.deepEqual(snapshot(database), before); assert.equal(stops, 0); assert.equal(effects, 1);
  await owner.close(); state = { kind: 'empty' };
  const restarted = await open(); t.after(() => restarted.close());
  await restarted.activate(); assert.equal(effects, 1);
  assert.deepEqual(await restarted.live(first), failed);
  assert.deepEqual((await restarted.live(retry)).outcome, failure);
  assert.equal(effects, 2);
});
