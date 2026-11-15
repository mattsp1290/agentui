import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { budgets } from '../../packages/host/dist/durable-model.js';
import { fixture, scope, installed, projection, note } from './fixture.mjs';

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
  const db = new DatabaseSync(f.path); db.exec('DROP TABLE frontend_receipts; DROP TABLE provider_creations'); db.close();
  const before = readFileSync(f.path);
  assert.throws(() => f.open(), /Incomplete database schema version 2: missing frontend_receipts/);
  assert.deepEqual(readFileSync(f.path), before);
});
