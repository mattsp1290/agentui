import { frontendToolsFor } from '@agentui/host/frontend-tools';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createFrontendToolGeneration, pinFrontendTools } from '@agentui/sdk/tools';
import { fixture, scope, installed, run } from '../fixture.mjs';

const key = { threadId: 'thread', runId: 'run-a' };
const started = { type: 'RUN_STARTED', threadId: key.threadId, runId: key.runId };
const finished = outcome => ({ type: 'RUN_FINISHED', threadId: key.threadId, runId: key.runId, ...(outcome ? { outcome } : {}) });
const actor = (id, authorized = () => true) => ({ id, platform: 'desktop', authorized });
async function setup(t, effect = () => {}) {
  const f = fixture(t), host = f.open(); host.createConversation(scope, installed);
  const { generation } = await createFrontendToolGeneration({ namespace: 'demo', generation: 'same', platform: 'desktop',
    activate({ frontendTools }) { frontendTools.add({ definition: { name: 'work', description: 'work' }, decodeInput: value => value,
      async execute(value) { const output = effect(value); return typeof output === 'string' ? output : 'done'; } }); return { dispose() {} }; }, capture: () => undefined });
  const pin = pinFrontendTools({ generations: [generation], platform: 'desktop', run: run().identity, capabilities: { tools: { clientProvided: true } } });
  t.after(async () => { pin.release(); await generation.retire(); });
  const producer = frontendToolsFor(host).producer(scope);
  producer.register({ identity: pin.run, threadId: key.threadId, platform: 'desktop', bindings: pin.bindings.map(binding => ({ ...binding, definition: pin.definitions.find(d => d.name === binding.name) })) });
  const binding = pin.bindings[0];
  return { ...f, host, pin, producer, binding };
}
function stream(producer, calls = [{ id: 'a', args: '{}' }], outcome) {
  let cursor = 1; assert.equal(producer.observe(key, cursor++, started), 'accepted');
  for (const call of calls) {
    assert.equal(producer.observe(key, cursor++, { type: 'TOOL_CALL_START', toolCallId: call.id, toolCallName: 'demo__work' }), 'accepted');
    assert.equal(producer.observe(key, cursor++, { type: 'TOOL_CALL_ARGS', toolCallId: call.id, delta: call.args }), 'accepted');
    assert.equal(producer.observe(key, cursor++, { type: 'TOOL_CALL_END', toolCallId: call.id }), 'accepted');
  }
  assert.equal(producer.observe(key, cursor++, finished(outcome)), 'accepted');
}
function allow(producer, id, binding) {
  const call = producer.inspect(key).calls.find(call => call.id === id);
  producer.decide(key, id, 'allow', binding.activationId, call.argumentsDigest);
}
test('one durable permit gates effects and the complete result batch across reopen', async t => {
  let effects = 0; const f = await setup(t, () => effects++);
  stream(f.producer, [{ id: 'a', args: '{"x":1}' }, { id: 'b', args: '{}' }]);
  allow(f.producer, 'a', f.binding); allow(f.producer, 'b', f.binding);
  const one = frontendToolsFor(f.host).client(scope, actor('one')), otherHost = f.open();
  const two = frontendToolsFor(otherHost).client(scope, actor('two'));
  const permit = one.claim(key, 'a', f.binding.activationId);
  assert.equal(permit.kind, 'permit');
  assert.equal(two.claim(key, 'a', f.binding.activationId).kind, 'uncertain');
  const outcome = await f.pin.invoke(permit.name, permit.arguments, f.binding.activationId);
  assert.equal(effects, 1); f.host.close(); otherHost.close(); await Promise.all([f.host.drained, otherHost.drained]);
  const reopened = f.open();
  const recoveredTwo = frontendToolsFor(reopened).client(scope, actor('two'));
  assert.equal(recoveredTwo.inspect(key).calls[0].status, 'uncertain');
  assert.equal(recoveredTwo.claim(key, 'a', f.binding.activationId).kind, 'uncertain');
  assert.throws(() => recoveredTwo.receipt(key, permit.permitId, outcome), /permit/);
  const original = frontendToolsFor(reopened).client(scope, actor('one'));
  assert.equal(original.receipt(key, permit.permitId, outcome), 'recorded');
  assert.equal(original.receipt(key, permit.permitId, outcome), 'duplicate');
  assert.throws(() => original.receipt(key, permit.permitId, { kind: 'completed', output: 'different' }), /Conflicting/);
  const producer = frontendToolsFor(reopened).producer(scope);
  assert.equal(producer.results(key).kind, 'waiting');
  const second = recoveredTwo.claim(key, 'b', f.binding.activationId);
  assert.equal(second.kind, 'permit');
  recoveredTwo.receipt(key, second.permitId, await f.pin.invoke(second.name, second.arguments, f.binding.activationId));
  assert.deepEqual(producer.results(key), { kind: 'ready', identity: run().identity, threadId: key.threadId, batch: [
    { toolCallId: 'a', result: { kind: 'completed', output: 'done' } },
    { toolCallId: 'b', result: { kind: 'completed', output: 'done' } },
  ] });
  assert.equal(effects, 2);
});
test('replay, malformed arguments, denial, cancellation and live authorization fail closed', async t => {
  let effects = 0; const f = await setup(t, () => effects++);
  stream(f.producer, [{ id: 'a', args: '{' }, { id: 'b', args: '{}' }], { type: 'success', pendingToolCallIds: [] });
  assert.equal(f.producer.observe(key, 1, started), 'duplicate');
  const view = f.producer.inspect(key); const b = view.calls.find(call => call.id === 'b');
  f.producer.decide(key, 'b', 'deny', f.binding.activationId, b.argumentsDigest);
  assert.deepEqual(f.producer.results(key), { kind: 'ready', identity: run().identity, threadId: key.threadId, batch: [
    { toolCallId: 'a', result: { kind: 'refused', code: 'invalid-arguments' } },
    { toolCallId: 'b', result: { kind: 'refused', code: 'denied' } },
  ] });
  const client = frontendToolsFor(f.host).client(scope, actor('one', () => false));
  assert.throws(() => client.claim(key, 'b', f.binding.activationId), /Unauthorized/);
  f.producer.cancel(key); assert.equal(f.producer.results(key).kind, 'blocked');
  assert.equal(effects, 0);
});
test('conflicting replay, missing start and inconsistent pending set fault the run', async t => {
  const f = await setup(t); assert.equal(f.producer.observe(key, 1, started), 'accepted');
  assert.equal(f.producer.observe(key, 1, { ...started, threadId: 'other' }), 'faulted');
  assert.equal(f.producer.results(key).kind, 'blocked');
});
test('a complete version one database upgrades without losing conversations', t => {
  const f = fixture(t), host = f.open(); host.createConversation(scope, installed); host.close();
  const db = new DatabaseSync(f.path); db.exec('DROP TABLE frontend_receipts; DROP TABLE frontend_events; DROP TABLE frontend_runs; PRAGMA user_version=1;'); db.close();
  const upgraded = f.open(); assert.deepEqual(upgraded.installation(scope), installed);
  const verify = new DatabaseSync(f.path); assert.equal(verify.prepare('PRAGMA user_version').get().user_version, 4); verify.close();
});

test('terminal validation rejects incomplete, mismatched, cancelled, and subagent calls', async t => {
  for (const scenario of ['incomplete', 'mismatch', 'cancelled', 'subagent', 'missing-start', 'gap']) {
    await t.test(scenario, async t => {
      const f = await setup(t);
      if (scenario === 'missing-start') {
        assert.equal(f.producer.observe(key, 1, finished()), 'faulted');
      } else if (scenario === 'gap') {
        assert.equal(f.producer.observe(key, 2, started), 'faulted');
      } else {
        assert.equal(f.producer.observe(key, 1, started), 'accepted');
        const start = { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'demo__work' };
        if (scenario === 'subagent') {
          assert.equal(f.producer.observe(key, 2, { ...start, subagentRunId: 'child' }), 'faulted');
        } else {
          assert.equal(f.producer.observe(key, 2, start), 'accepted');
          if (scenario === 'incomplete') assert.equal(f.producer.observe(key, 3, finished()), 'faulted');
          else {
            assert.equal(f.producer.observe(key, 3, { type: 'TOOL_CALL_END', toolCallId: 'a' }), 'accepted');
            const outcome = scenario === 'cancelled' ? { type: 'cancelled' } : { type: 'success', pendingToolCallIds: ['other'] };
            assert.equal(f.producer.observe(key, 4, finished(outcome)), scenario === 'cancelled' ? 'accepted' : 'faulted');
          }
        }
      }
      assert.equal(f.producer.results(key).kind, 'blocked');
      assert.equal(frontendToolsFor(f.host).client(scope, actor('one')).claim(key, 'a', f.binding.activationId).kind, 'unavailable');
    });
  }
});

test('backend answers are excluded and repeated argument fragments retain their order', async t => {
  let received; const f = await setup(t, value => { received = value; });
  const events = [started,
    { type: 'TOOL_CALL_START', toolCallId: 'backend', toolCallName: 'server' },
    { type: 'TOOL_CALL_END', toolCallId: 'backend' },
    { type: 'TOOL_CALL_RESULT', toolCallId: 'backend', messageId: 'message', content: 'server result' },
    { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'demo__work' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: '{"x":"' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: 'z' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: 'z' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: '"}' },
    { type: 'TOOL_CALL_END', toolCallId: 'a' }, finished({ type: 'success', pendingToolCallIds: ['a'] })];
  for (const [index, event] of events.entries()) {
    assert.equal(f.producer.observe(key, index + 1, event), 'accepted');
    assert.equal(f.producer.observe(key, index + 1, event), 'duplicate');
  }
  allow(f.producer, 'a', f.binding);
  const client = frontendToolsFor(f.host).client(scope, actor('one'));
  const permit = client.claim(key, 'a', f.binding.activationId); assert.equal(permit.kind, 'permit');
  client.receipt(key, permit.permitId, await f.pin.invoke(permit.name, permit.arguments, f.binding.activationId));
  assert.deepEqual(received, { x: 'zz' });
  assert.deepEqual(f.producer.results(key), { kind: 'ready', identity: run().identity, threadId: key.threadId, batch: [{ toolCallId: 'a', result: { kind: 'completed', output: 'done' } }] });
});

test('wrong platform, generation and revoked authorization cannot acquire a permit', async t => {
  const f = await setup(t); stream(f.producer); allow(f.producer, 'a', f.binding);
  let enabled = true; const client = frontendToolsFor(f.host).client(scope, actor('one', request => enabled && request.activationId === f.binding.activationId));
  assert.throws(() => client.claim(key, 'a', f.binding.activationId + '-new'), /Unauthorized/);
  enabled = false; assert.throws(() => client.claim(key, 'a', f.binding.activationId), /Unauthorized/);
  const ios = frontendToolsFor(f.host).client(scope, { ...actor('ios'), platform: 'ios' });
  assert.equal(ios.claim(key, 'a', f.binding.activationId).kind, 'unavailable');
  f.producer.cancel(key); enabled = true;
  assert.equal(client.claim(key, 'a', f.binding.activationId).kind, 'unavailable');
});

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));
function worker(...args) {
  const child = spawn(process.execPath, [workerPath, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  return { child, get stdout() { return stdout; }, get stderr() { return stderr; } };
}
test('independent processes racing for one call issue exactly one permit', { timeout: 10000 }, async t => {
  const f = await setup(t); stream(f.producer); allow(f.producer, 'a', f.binding);
  const workers = [worker(f.path, 'race', 'one', f.binding.activationId), worker(f.path, 'race', 'two', f.binding.activationId)];
  t.after(() => workers.forEach(w => w.child.kill()));
  await Promise.all(workers.map(async w => {
    while (!w.stdout.includes('ready\n')) {
      await Promise.race([once(w.child.stdout, 'data'), once(w.child, 'exit').then(() => { throw new Error(w.stderr || 'Worker exited before readiness'); })]);
    }
  }));
  const exits = workers.map(w => once(w.child, 'exit'));
  workers.forEach(w => w.child.stdin.end('go'));
  const statuses = await Promise.all(exits);
  for (const [index, w] of workers.entries()) assert.equal(statuses[index][0], 0, w.stderr);
  assert.deepEqual(workers.map(w => JSON.parse(w.stdout.split('\n')[1]).kind).sort(), ['permit', 'uncertain']);
});
test('process death after an external effect leaves the call permanently uncertain', { timeout: 10000 }, async t => {
  const f = fixture(t), host = f.open(); host.createConversation(scope, installed); host.close(); await host.drained;
  const effect = join(f.dir, 'effect.txt'), w = worker(f.path, 'crash', 'original', effect);
  t.after(() => w.child.kill());
  const [code] = await once(w.child, 'exit'); assert.equal(code, 0, w.stderr);
  const { activationId } = JSON.parse(w.stdout.trim());
  assert.equal(readFileSync(effect, 'utf8'), 'effect\n');
  const reopened = f.open(), client = frontendToolsFor(reopened).client(scope, actor('replacement'));
  assert.equal(client.inspect(key).calls[0].status, 'uncertain');
  assert.equal(client.claim(key, 'a', activationId).kind, 'uncertain');
  assert.equal(frontendToolsFor(reopened).producer(scope).results(key).kind, 'waiting');
  assert.equal(readFileSync(effect, 'utf8'), 'effect\n');
});

test('concurrent first opens initialize the same database safely', { timeout: 10000 }, async t => {
  const f = fixture(t), workers = [worker(f.path, 'open', 'one'), worker(f.path, 'open', 'two')];
  t.after(() => workers.forEach(w => w.child.kill()));
  const statuses = await Promise.all(workers.map(w => once(w.child, 'exit')));
  for (const [index, w] of workers.entries()) { assert.equal(statuses[index][0], 0, w.stderr); assert.equal(w.stdout, 'opened\n'); }
  const host = f.open(); host.createConversation(scope, installed); assert.deepEqual(host.installation(scope), installed);
});

test('revocation blocks a receipt until the original actor is authorized again', async t => {
  const f = await setup(t); stream(f.producer); allow(f.producer, 'a', f.binding);
  let enabled = true;
  const client = frontendToolsFor(f.host).client(scope, actor('one', () => enabled));
  const permit = client.claim(key, 'a', f.binding.activationId);
  assert.equal(permit.kind, 'permit');
  const result = await f.pin.invoke(permit.name, permit.arguments, f.binding.activationId);
  enabled = false; assert.throws(() => client.receipt(key, permit.permitId, result), /Unauthorized/);
  assert.equal(f.producer.results(key).kind, 'waiting');
  enabled = true; assert.equal(client.receipt(key, permit.permitId, result), 'recorded');
  assert.equal(f.producer.results(key).kind, 'ready');
});


test('coordinator attaches only to original host handles and follows host lifecycle authorization', async t => {
  let authorized = true;
  const f = fixture(t), host = f.open({ authorize: () => authorized });
  host.createConversation(scope, installed);
  assert.equal('frontendTools' in host, false);
  for (const fake of [{}, { ...host }, Object.create(host)]) {
    assert.throws(() => frontendToolsFor(fake), /openLocalHost handle/);
  }
  const tools = frontendToolsFor(host), producer = tools.producer(scope), client = tools.client(scope, actor('one'));
  const registration = { identity: run().identity, threadId: key.threadId, platform: 'desktop', bindings: [] };
  producer.register(registration);
  authorized = false;
  assert.throws(() => producer.inspect(key), /Unauthorized scope/);
  assert.throws(() => client.inspect(key), /Unauthorized scope/);
  assert.throws(() => tools.producer(scope), /Unauthorized scope/);
  authorized = true;
  assert.equal(producer.inspect(key).status, 'collecting');
  host.close(); await host.drained;
  assert.throws(() => producer.inspect(key), /Host is closed/);
  assert.throws(() => client.inspect(key), /Host is closed/);
  assert.throws(() => frontendToolsFor(host).producer(scope), /Host is closed/);
});

test('trusted producer accepts a remote-provider run identity', t => {
  const f = fixture(t), host = f.open(); host.createConversation(scope, installed);
  const producer = frontendToolsFor(host).producer(scope);
  const identity = { ...run().identity, authority: { kind: 'remote-provider', binding: run().identity.authority.binding } };
  producer.register({ identity, threadId: key.threadId, platform: 'desktop', bindings: [] });
  assert.equal(producer.observe(key, 1, started), 'accepted');
  assert.equal(producer.observe(key, 2, finished()), 'accepted');
  assert.deepEqual(producer.results(key), { kind: 'ready', identity, threadId: key.threadId, batch: [] });
});


test('independent maximum receipts survive reopen with simultaneous permits and escaped outputs', async t => {
  let effectPath;
  const f = await setup(t, value => { appendFileSync(effectPath, `${value.index}\n`); return value.index % 2 ? '\0'.repeat(64000) : 'a'.repeat(64000); });
  effectPath = join(f.dir, 'effects.txt');
  const calls = Array.from({ length: 16 }, (_, index) => ({ id: `call-${index}`, args: JSON.stringify({ index }) }));
  stream(f.producer, calls);
  const client = frontendToolsFor(f.host).client(scope, actor('original'));
  const permits = calls.map(call => {
    allow(f.producer, call.id, f.binding);
    const permit = client.claim(key, call.id, f.binding.activationId);
    assert.equal(permit.kind, 'permit');
    return permit;
  });
  const outcomes = [];
  for (const permit of permits) {
    const outcome = await f.pin.invoke(permit.name, permit.arguments, f.binding.activationId);
    outcomes.push(outcome);
    assert.equal(client.receipt(key, permit.permitId, outcome), 'recorded');
  }
  assert.equal(readFileSync(effectPath, 'utf8'), calls.map((_, index) => `${index}\n`).join(''));
  f.host.close(); await f.host.drained;
  const reopened = f.open(), original = frontendToolsFor(reopened).client(scope, actor('original'));
  assert.equal(original.receipt(key, permits[15].permitId, outcomes[15]), 'duplicate');
  assert.throws(() => original.receipt(key, permits[15].permitId, { kind: 'completed', output: 'changed' }), /Conflicting/);
  assert.deepEqual(frontendToolsFor(reopened).producer(scope).results(key), {
    kind: 'ready', identity: run().identity, threadId: key.threadId,
    batch: calls.map((call, index) => ({ toolCallId: call.id, result: outcomes[index] })),
  });
});

test('event insert failure rolls back state and allows exact replay', async t => {
  const f = await setup(t), db = new DatabaseSync(f.path);
  t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_event BEFORE INSERT ON frontend_events BEGIN SELECT RAISE(ABORT, 'event failure'); END");
  assert.throws(() => f.producer.observe(key, 1, started), /event failure/);
  assert.equal(f.producer.inspect(key).status, 'collecting');
  const state = JSON.parse(db.prepare('SELECT data FROM frontend_runs').get().data);
  assert.equal(state.cursor, 0);
  assert.equal(db.prepare('SELECT count(*) AS count FROM frontend_events').get().count, 0);
  db.exec('DROP TRIGGER fail_event');
  assert.equal(f.producer.observe(key, 1, started), 'accepted');
  assert.equal(f.producer.observe(key, 1, started), 'duplicate');
});

test('receipt insert failure preserves the permit and permits the original receipt retry', async t => {
  let effects = 0; const f = await setup(t, () => { effects++; });
  stream(f.producer); allow(f.producer, 'a', f.binding);
  const original = frontendToolsFor(f.host).client(scope, actor('original'));
  const permit = original.claim(key, 'a', f.binding.activationId);
  assert.equal(permit.kind, 'permit');
  const outcome = await f.pin.invoke(permit.name, permit.arguments, f.binding.activationId);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON frontend_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
  assert.throws(() => original.receipt(key, permit.permitId, outcome), /receipt failure/);
  assert.equal(original.inspect(key).calls[0].status, 'uncertain');
  assert.equal(frontendToolsFor(f.host).client(scope, actor('other')).claim(key, 'a', f.binding.activationId).kind, 'uncertain');
  assert.equal(f.producer.results(key).kind, 'waiting');
  db.exec('DROP TRIGGER fail_receipt');
  assert.equal(original.receipt(key, permit.permitId, outcome), 'recorded');
  assert.equal(original.receipt(key, permit.permitId, outcome), 'duplicate');
  assert.equal(effects, 1);
});

test('refusal receipt write failures roll back event folding and decisions', async t => {
  const f = await setup(t), db = new DatabaseSync(f.path); t.after(() => db.close());
  const events = [started, { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'demo__work' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: '{' }, { type: 'TOOL_CALL_END', toolCallId: 'a' }];
  for (const [i, event] of events.entries()) assert.equal(f.producer.observe(key, i + 1, event), 'accepted');
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON frontend_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
  assert.throws(() => f.producer.observe(key, 5, finished()), /receipt failure/);
  assert.equal(JSON.parse(db.prepare('SELECT data FROM frontend_runs').get().data).cursor, 4);
  assert.equal(db.prepare('SELECT count(*) AS count FROM frontend_events').get().count, 4);
  db.exec('DROP TRIGGER fail_receipt');
  assert.equal(f.producer.observe(key, 5, finished()), 'accepted');
  assert.deepEqual(f.producer.results(key).batch[0].result, { kind: 'refused', code: 'invalid-arguments' });
});

test('missing or corrupt receipt cannot produce a result batch or confirm a retry', async t => {
  const f = await setup(t); stream(f.producer); allow(f.producer, 'a', f.binding);
  const client = frontendToolsFor(f.host).client(scope, actor('original'));
  const permit = client.claim(key, 'a', f.binding.activationId), outcome = { kind: 'completed', output: 'done' };
  assert.equal(client.receipt(key, permit.permitId, outcome), 'recorded');
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  db.prepare('UPDATE frontend_receipts SET data=?').run(JSON.stringify({ kind: 'completed', output: 'a'.repeat(64001) }));
  assert.throws(() => f.producer.results(key));
  assert.throws(() => client.receipt(key, permit.permitId, outcome));
  db.exec('DELETE FROM frontend_receipts');
  assert.throws(() => f.producer.results(key), /Missing frontend receipt/);
  assert.throws(() => client.receipt(key, permit.permitId, outcome), /Missing frontend receipt/);
});


test('denial receipt write failure leaves the decision retryable', async t => {
  const f = await setup(t); stream(f.producer);
  const digest = f.producer.inspect(key).calls[0].argumentsDigest;
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON frontend_receipts BEGIN SELECT RAISE(ABORT, 'receipt failure'); END");
  assert.throws(() => f.producer.decide(key, 'a', 'deny', f.binding.activationId, digest), /receipt failure/);
  assert.equal(f.producer.inspect(key).calls[0].status, 'pending');
  db.exec('DROP TRIGGER fail_receipt');
  f.producer.decide(key, 'a', 'deny', f.binding.activationId, digest);
  assert.deepEqual(f.producer.results(key).batch[0].result, { kind: 'refused', code: 'denied' });
});

test('invalid terminal event faults without retaining partial fold or receipts', async t => {
  const f = await setup(t), events = [started,
    { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'demo__work' },
    { type: 'TOOL_CALL_ARGS', toolCallId: 'a', delta: '{' }, { type: 'TOOL_CALL_END', toolCallId: 'a' },
    { type: 'TOOL_CALL_START', toolCallId: 'b', toolCallName: 'unknown' }, { type: 'TOOL_CALL_END', toolCallId: 'b' }];
  for (const [i, event] of events.entries()) assert.equal(f.producer.observe(key, i + 1, event), 'accepted');
  assert.equal(f.producer.observe(key, 7, finished()), 'faulted');
  assert.deepEqual(f.producer.inspect(key).calls.map(call => call.status), ['sealed', 'sealed']);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  assert.equal(db.prepare('SELECT count(*) AS count FROM frontend_receipts').get().count, 0);
  assert.equal(JSON.parse(db.prepare('SELECT data FROM frontend_runs').get().data).cursor, 6);
});
