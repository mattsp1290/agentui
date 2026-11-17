import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@agentui/contracts';
import { frontendToolsFor } from '@agentui/host/frontend-tools';
import { fixture, installed, run, scope } from '../fixture.mjs';
const key = { threadId: 'thread', runId: 'run-a' };
const start = { type: 'RUN_STARTED', ...key }, finish = { type: 'RUN_FINISHED', ...key };
const bytes = value => Buffer.byteLength(canonicalJson(value));
function setup(t, padding = 0) {
  const f = fixture(t), host = f.open(); host.createConversation(scope, installed);
  const producer = frontendToolsFor(host).producer(scope), db = new DatabaseSync(f.path); t.after(() => db.close());
  producer.register({ identity: run().identity, threadId: key.threadId, platform: 'desktop', bindings: [
    { name: 'demo__work', activationId: 'original', definition: { name: 'demo__work', description: 'x'.repeat(padding) } },
  ] });
  const dump = () => Object.fromEntries(['frontend_runs', 'frontend_events', 'frontend_receipts'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { ...f, host, producer, db, dump };
}
function history(size = 62000, end = false) {
  const events = [start];
  for (let i = 0; i < 16; i++) {
    events.push({ type: 'TOOL_CALL_START', toolCallId: `call-${i}`, toolCallName: 'demo__work' },
      { type: 'TOOL_CALL_ARGS', toolCallId: `call-${i}`, delta: '"' + 'x'.repeat(size - 2) + '"' });
    if (end) events.push({ type: 'TOOL_CALL_END', toolCallId: `call-${i}` });
  }
  if (end) events.push(finish);
  return events;
}
test('public producer returns faulted for candidate capacity and retains the pre-event run', t => {
  for (const padding of [0, 10000]) {
    const f = setup(t, padding), list = history();
    for (const [index, event] of list.entries()) {
      const before = JSON.parse(f.dump().frontend_runs[0].data);
      const expected = padding && index === 32 ? 'faulted' : 'accepted';
      assert.equal(f.producer.observe(key, index + 1, event), expected);
      if (expected === 'faulted') assert.deepEqual(JSON.parse(f.dump().frontend_runs[0].data), { ...before, status: 'faulted' });
    }
    assert.equal(f.dump().frontend_events.length, padding ? 32 : 33);
    assert.throws(() => f.producer.observe({ ...key, runId: 'unknown' }, 1, start), /Unknown frontend run/);
    assert.throws(() => f.producer.register({ identity: run().identity, threadId: 'other', platform: 'desktop', bindings: [{ name: 'demo__work', activationId: 'x', definition: { name: 'wrong', description: 'invalid binding' } }] }), /Invalid frontend binding/);
  }
});

test('a publicly produced 1000000-byte ready run faults with two status bytes of headroom', t => {
  const measure = setup(t), events = history(60000, true);
  for (const [index, event] of events.entries()) assert.equal(measure.producer.observe(key, index + 1, event), 'accepted');
  const padding = 1_000_000 - Buffer.byteLength(measure.dump().frontend_runs[0].data);
  assert(padding > 0 && padding < 128000);
  const f = setup(t, padding);
  for (const [index, event] of events.entries()) assert.equal(f.producer.observe(key, index + 1, event), 'accepted');
  const before = JSON.parse(f.dump().frontend_runs[0].data); assert.equal(bytes(before), 1_000_000); assert.equal(before.status, 'ready');
  assert.equal(f.producer.observe(key, events.length + 1, { type: 'RAW', event: 'contradiction' }), 'faulted');
  const after = JSON.parse(f.dump().frontend_runs[0].data); assert.equal(bytes(after), 1_000_002);
  assert.deepEqual(after, { ...before, status: 'faulted' });
});

test('faulting a ready run preserves issued permits and independently recorded receipts across reopen', async t => {
  const f = setup(t), list = history(20, true);
  for (const [index, event] of list.entries()) assert.equal(f.producer.observe(key, index + 1, event), 'accepted');
  const client = frontendToolsFor(f.host).client(scope, { id: 'owner', platform: 'desktop', authorized: () => true });
  for (const call of f.producer.inspect(key).calls.slice(0, 2)) f.producer.decide(key, call.id, 'allow', 'original', call.argumentsDigest);
  const one = client.claim(key, 'call-0', 'original'), two = client.claim(key, 'call-1', 'original');
  assert.equal(one.kind, 'permit'); assert.equal(two.kind, 'permit');
  assert.equal(client.receipt(key, one.permitId, { kind: 'completed', output: 'recorded fixture result' }), 'recorded');
  const before = f.dump(), runBefore = JSON.parse(before.frontend_runs[0].data);
  assert.equal(f.producer.observe(key, list.length + 1, { type: 'RAW', event: 'after-finish' }), 'faulted');
  assert.deepEqual(JSON.parse(f.dump().frontend_runs[0].data), { ...runBefore, status: 'faulted' });
  assert.deepEqual(f.dump().frontend_receipts, before.frontend_receipts);
  f.host.close(); await f.host.drained;
  const reopened = f.open(), recovered = frontendToolsFor(reopened).client(scope, { id: 'owner', platform: 'desktop', authorized: () => true });
  assert.equal(recovered.receipt(key, one.permitId, { kind: 'completed', output: 'recorded fixture result' }), 'duplicate');
  assert.equal(recovered.receipt(key, two.permitId, { kind: 'completed', output: 'late fixture result' }), 'recorded');
  assert.equal(recovered.claim(key, 'call-2', 'original').kind, 'unavailable');
});

for (const failure of ['event', 'run', 'receipt', 'capacity-fault']) test(`public producer propagates ${failure} SQL failure and exact retry`, t => {
  const f = setup(t, failure === 'capacity-fault' ? 10000 : 0);
  let list = failure === 'capacity-fault' ? history() : [start, { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'demo__work' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: '{' }, { type: 'TOOL_CALL_END', toolCallId: 'a' }, finish];
  if (failure !== 'capacity-fault' && failure !== 'receipt') list = [start];
  for (const [index, event] of list.slice(0, -1).entries()) assert.equal(f.producer.observe(key, index + 1, event), 'accepted');
  const before = f.dump(), table = failure === 'event' ? 'frontend_events' : failure === 'receipt' ? 'frontend_receipts' : 'frontend_runs';
  f.db.exec(`CREATE TRIGGER fail_capacity BEFORE ${table === 'frontend_runs' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT,'producer SQL failure'); END`);
  assert.throws(() => f.producer.observe(key, list.length, list.at(-1)), /producer SQL failure/); assert.deepEqual(f.dump(), before);
  f.db.exec('DROP TRIGGER fail_capacity');
  assert.equal(f.producer.observe(key, list.length, list.at(-1)), failure === 'capacity-fault' ? 'faulted' : 'accepted');
});
