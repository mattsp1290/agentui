import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openRecordedHost, recordedInstallation } from '@agentui/host/recorded';

const scope = { hostId: 'shutdown-host', conversationId: 'shutdown-conversation' };
const command = id => ({ version: 1, scope, clientCommandId: id, body: { kind: 'send', text: 'Finish this run.' } });
function fixture(t, progressMs = 10) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-shutdown-'));
  const options = { path: join(directory, 'host.sqlite'), backendPath: join(directory, 'recorded.jsonl'),
    hostId: scope.hostId, progressMs };
  const host = openRecordedHost(options);
  host.createConversation(scope, recordedInstallation);
  t.after(async () => { host.close(); await host.drained.catch(() => {}); rmSync(directory, { recursive: true, force: true }); });
  const entries = () => existsSync(options.backendPath) ? readFileSync(options.backendPath, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { directory, options, host, port: host.conversation(scope), entries };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Recorded acceptance timed out');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test('shutdown retains ownership until accepted playback settles and storage closes', async t => {
  const f = fixture(t, 50);
  const ownerPath = join(f.directory, 'owner.sqlite');
  const owner = new DatabaseSync(ownerPath), contender = new DatabaseSync(ownerPath);
  owner.exec('BEGIN EXCLUSIVE');
  t.after(() => contender.close());
  const submission = f.port.submit(command('accepted'));
  await until(() => f.entries().length === 1);
  let released = false;
  const release = f.host.drained.then(() => { owner.close(); released = true; });
  f.host.close();
  f.host.close();
  assert.throws(() => f.host.createConversation({ ...scope, conversationId: 'late' }, recordedInstallation), /closed/);
  assert.equal((await f.port.submit(command('late'))).kind, 'rejected');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(released, false);
  assert.throws(() => contender.exec('BEGIN EXCLUSIVE'), /locked/);
  assert.equal((await submission).receipt.state.kind, 'completed');
  await release;
  assert.equal(released, true);
  contender.exec('BEGIN EXCLUSIVE');
  contender.exec('ROLLBACK');
  assert.equal(f.entries().length, 1);
  const reopened = openRecordedHost(f.options);
  try {
    assert.equal((await reopened.conversation(scope).receipt('accepted')).state.kind, 'completed');
    assert.equal(await reopened.conversation(scope).receipt('late'), null);
    assert.equal((await reopened.conversation(scope).submit(command('accepted'))).receipt.state.kind, 'completed');
    assert.equal(f.entries().length, 1);
  } finally { reopened.close(); await reopened.drained; }
});

test('progress storage failures preserve the recorded conclusive result', async t => {
  const f = fixture(t), db = new DatabaseSync(f.options.path);
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail_progress BEFORE INSERT ON events
    WHEN json_extract(NEW.payload, '$.event.event.role') = 'assistant'
      AND json_extract(NEW.payload, '$.event.event.revision') < 3
    BEGIN SELECT RAISE(ABORT, 'injected progress storage failure'); END`);
  const submitted = await f.port.submit(command('progress-failure'));
  assert.equal(submitted.receipt.state.kind, 'completed');
  assert.equal((await f.port.receipt('progress-failure')).state.kind, 'completed');
  assert.equal(f.entries().length, 1);
  assert.equal(f.entries()[0].kind, 'conclusive');
  const document = JSON.parse(db.prepare('SELECT document FROM conversations').get().document);
  assert.ok(document.domain.messages.every(message => message.complete));
  assert.equal(document.domain.messages.length, 2);
});

test('final settlement storage failures still reject the command', async t => {
  const f = fixture(t), db = new DatabaseSync(f.options.path);
  t.after(() => db.close());
  db.exec(`CREATE TRIGGER fail_settlement BEFORE INSERT ON events
    WHEN json_extract(NEW.payload, '$.event.event.role') = 'assistant'
      AND json_extract(NEW.payload, '$.event.event.revision') = 3
    BEGIN SELECT RAISE(ABORT, 'injected final settlement failure'); END`);
  await assert.rejects(f.port.submit(command('settlement-failure')), /injected final settlement failure/);
  assert.equal(f.entries()[0].kind, 'conclusive');
  f.host.close();
  await f.host.drained;
});

test('idle close is idempotent and drained rejects when storage cannot close', async t => {
  const f = fixture(t);
  const failure = new Error('injected database close failure');
  let database;
  const close = t.mock.method(DatabaseSync.prototype, 'close', function () { database = this; throw failure; });
  const rejected = assert.rejects(f.host.drained, error => error === failure);
  f.host.close();
  f.host.close();
  await rejected;
  assert.equal(close.mock.callCount(), 1);
  close.mock.restore();
  database.close();
});

test('oversized playback delays still finish within the request deadline', { timeout: 10_000 }, async t => {
  const f = fixture(t, 60_000);
  assert.equal((await f.port.submit(command('bounded-playback'))).receipt.state.kind, 'completed');
  f.host.close();
  await f.host.drained;
});
