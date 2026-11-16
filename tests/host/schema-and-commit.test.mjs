import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase as openVersionTwoDatabase } from './fixtures/sqlite-format2.ts';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { budgets } from '../../packages/host/dist/durable-model.js';
import { fixture, scope, installed, projection, note, command, run, question } from './fixture.mjs';

test('opening incomplete version one refuses without guessing a migration or changing file bytes', t => {
  const f = fixture(t);
  const db = new DatabaseSync(f.path);
  db.exec('PRAGMA user_version=1; CREATE TABLE sentinel(value TEXT);');
  db.close();
  const before = readFileSync(f.path);
  assert.throws(() => f.open(), /Incomplete database schema version 1: missing .*host_limits/);
  assert.deepEqual(readFileSync(f.path), before);
  const reopened = new DatabaseSync(f.path);
  try { assert.equal(reopened.prepare("SELECT name FROM sqlite_schema WHERE name='host_limits'").get(), undefined); }
  finally { reopened.close(); }
});

test('opening version one missing a command table refuses before mutation', t => {
  const f = fixture(t), host = f.open();
  host.close();
  const db = new DatabaseSync(f.path);
  db.exec('DROP TABLE commands');
  db.close();
  const before = readFileSync(f.path);
  assert.throws(() => f.open(), /Incomplete database schema version 1: missing commands/);
  assert.deepEqual(readFileSync(f.path), before);
});

test('store notifies only successful write commits after other connections can observe them', t => {
  const f = fixture(t), store = new SqliteStore(f.path, projection, budgets());
  t.after(() => store.close());
  const heads = [];
  store.onCommit = () => {
    const reader = new DatabaseSync(f.path);
    try { heads.push(reader.prepare('SELECT head FROM conversations').get()?.head); }
    finally { reader.close(); }
  };
  store.create(scope, installed);
  assert.deepEqual(heads, [0]);
  store.plan(scope, null, 1);
  assert.deepEqual(heads, [0]);
  store.append(scope, note('committed'));
  assert.deepEqual(heads, [0, 1]);
  assert.throws(() => store.append(scope, note('projector-failure')), /Projection rejected/);
  assert.deepEqual(heads, [0, 1]);
  assert.equal(store.head(scope), 1);
});


test('opening incomplete version two refuses before adding provider creation metadata', t => {
  const f = fixture(t), host = f.open(); host.close();
  const db = new DatabaseSync(f.path); db.exec('PRAGMA user_version=2; DROP TABLE command_images; DROP TABLE images; DROP TABLE frontend_receipts; DROP TABLE provider_creations'); db.close();
  const before = readFileSync(f.path);
  assert.throws(() => f.open(), /Incomplete database schema version 2: missing frontend_receipts/);
  assert.deepEqual(readFileSync(f.path), before);
});

for (const [failure, mutate, options, message] of [
  ['corrupt JSON', "UPDATE conversations SET document='invalid json'", {}, /Corrupt stored JSON/],
  ['projection mismatch', 'UPDATE conversations SET version=99', {}, /Incompatible projection/],
  ['budget mismatch', '', { budgets: { maxEventBytes: budgets().maxEventBytes + 1 } }, /Incompatible persistent host budgets/],
]) {
  test(`pre-feature version two ${failure} refuses without adding provider metadata or changing file bytes`, t => {
    const f = fixture(t), host = f.open(); host.createConversation(scope, installed); host.close();
    const db = new DatabaseSync(f.path); db.exec(`PRAGMA user_version=2; DROP TABLE command_images; DROP TABLE images; DROP TABLE provider_creations; ${mutate}`); db.close();
    const before = readFileSync(f.path);
    assert.throws(() => f.open(options), message);
    const reader = new DatabaseSync(f.path);
    try { assert.equal(reader.prepare("SELECT name FROM sqlite_schema WHERE name='provider_creations'").get(), undefined); }
    finally { reader.close(); }
    assert.deepEqual(readFileSync(f.path), before);
  });
}

test('corrupt existing provider metadata refuses before migrating a legacy transcript', t => {
  const f = fixture(t), host = f.open({ projection: transcriptProjection }); host.createConversation(scope, installed); host.close();
  const db = new DatabaseSync(f.path);
  db.exec("UPDATE conversations SET version=1; INSERT INTO provider_creations VALUES ('host-a','bad','invalid json','reserved',NULL)");
  db.close();
  const before = readFileSync(f.path);
  assert.throws(() => f.open({ projection: transcriptProjection }), /Corrupt creation metadata/);
  assert.deepEqual(readFileSync(f.path), before);
});

test('version two upgrades preserve pending decisions and uncertain commands and the older opener refuses format four', async t => {
  const f = fixture(t, { async afterAcceptance() { throw new Error('Reply lost'); } }), host = f.open();
  host.createConversation(scope, installed);
  host.append(scope, { ...note('saved'), runs: [run()], decisions: [question()] });
  await host.conversation(scope).submit(command('uncertain'));
  host.close(); await host.drained;
  const db = new DatabaseSync(f.path);
  db.exec('PRAGMA user_version=2; DROP TABLE command_images; DROP TABLE images;');
  const saved = ['conversations', 'runs', 'commands', 'pending_decisions', 'events', 'host_limits']
    .map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]);
  assert.equal(JSON.parse(saved.find(([name]) => name === 'commands')[1][0].receipt).state.kind, 'uncertain');
  db.close();
  const reopened = f.open();
  const reader = new DatabaseSync(f.path);
  assert.equal(reader.prepare('PRAGMA user_version').get().user_version, 4);
  for (const [table, rows] of saved) assert.deepEqual(reader.prepare(`SELECT * FROM ${table}`).all(), rows);
  reader.close(); reopened.close(); await reopened.drained;
  const bytes = readFileSync(f.path);
  assert.throws(() => openVersionTwoDatabase(f.path), /Unsupported database version/);
  assert.deepEqual(readFileSync(f.path), bytes);
});

test('many processes opening the same new database all reach WAL mode', { timeout: 60000 }, async t => {
  const f = fixture(t), opener = new URL('../../packages/host/dist/sqlite-schema.js', import.meta.url).href;
  const script = `const { openDatabase } = await import(process.argv[1]);
    const { createInterface } = await import('node:readline');
    process.stdout.write('ready\\n');
    for await (const line of createInterface({ input: process.stdin })) {
      const [path, start] = JSON.parse(line);
      while (Date.now() < start) {}
      try { openDatabase(path).close(); process.stdout.write('opened\\n'); }
      catch (error) { process.stdout.write(JSON.stringify(String(error)) + '\\n'); }
    }`;
  const children = Array.from({ length: 10 }, () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, opener], { stdio: ['pipe', 'pipe', 'inherit'] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    return { child, next: async () => (await lines.next()).value };
  });
  t.after(() => children.forEach(({ child }) => child.kill()));
  assert.deepEqual(await Promise.all(children.map(c => c.next())), children.map(() => 'ready'));
  for (let round = 0; round < 80; round++) {
    const path = join(f.dir, `concurrent-${round}.sqlite`), start = Date.now() + 50;
    for (const { child } of children) child.stdin.write(JSON.stringify([path, start]) + '\n');
    assert.deepEqual(await Promise.all(children.map(c => c.next())), children.map(() => 'opened'));
    const db = new DatabaseSync(path);
    try {
      assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    } finally { db.close(); }
  }
});
