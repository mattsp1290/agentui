import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '@agentui/contracts';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createFrontendToolGeneration, retainFrontendTools } from '@agentui/sdk/tools';
import { DatabaseSync } from 'node:sqlite';
import { createProviderRegistry } from '@agentui/host';
import { frontendToolsFor } from '@agentui/host/frontend-tools';
import { fixture, scope } from '../host/fixture.mjs';
import { offered, aguiExtension } from './provider-send-fixture.mjs';

const actor = { id: 'owner', platform: 'desktop', authorized: () => true };
async function setup(t, { effect, stream = true, version = 2, description = 'Inspect', calls = ['first', 'second'].map(id => ({ id, args: '{}' })), allow = true } = {}) {
  const extension = aguiExtension();
  const registry = createProviderRegistry([{ ...extension.value, authority: { credentials: {},
    issue: () => ({ credential: null, expectedAuthority: 'remote-provider', assertAuthorized() {} }), async close() {} } }]);
  await registry.activate(); t.after(() => registry.close());
  const [discovered] = await registry.discover();
  const target = { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance, agent: discovered.agents[0],
    presentationVersion: 1, expectedAuthority: discovered.expectedAuthority };
  const f = fixture(t), host = f.open({ providers: registry });
  await host.createProviderConversation(scope, target, registry);
  const command = offered(scope);
  command.body.frontend.tools[0].definition.description = description;
  let retained, generation;
  if (effect) {
    ({ generation } = await createFrontendToolGeneration({ namespace: 'test', generation: 'original', platform: 'desktop',
      activate({ frontendTools }) {
        frontendTools.add({ definition: { name: 'inspect', description: 'Inspect' }, decodeInput: value => value,
          execute: async value => { effect(value); return 'original closure completed'; } });
        return { dispose() {} };
      }, capture: () => undefined }));
    retained = retainFrontendTools({ generations: [generation], platform: 'desktop' });
    command.body.frontend.tools = retained.bindings.map(binding => ({ activationId: binding.activationId, definition: retained.definitions.find(item => item.name === binding.name) }));
    t.after(async () => { retained.release(); await generation.retire(); });
  }
  if (version === 1) { command.version = 1; delete command.body.frontend; }
  assert.equal((await host.conversation(scope, actor).submit(command)).receipt.state.kind, 'completed');
  const producer = frontendToolsFor(host).producer(scope);
  let bound;
  if (version === 2) {
    bound = await host.frontendBinding({ scope, id: 'offered', action: 'recover' }, actor, () => producer);
    assert.equal(bound.kind, 'bound');
  } else {
    const db = new DatabaseSync(f.path);
    const observation = JSON.parse(db.prepare("SELECT observation FROM commands WHERE id='offered'").get().observation); db.close();
    bound = { run: observation.evidence.source.run.identity, threadId: 'actual-thread', command: offered(scope) };
    producer.register({ identity: bound.run, threadId: bound.threadId, platform: 'desktop', bindings: offered(scope).body.frontend.tools.map(tool => ({ ...tool, name: tool.definition.name })) });
  }
  const key = { threadId: bound.threadId, runId: bound.run.runId };
  const events = [{ type: 'RUN_STARTED', ...key }];
  for (const { id, args } of calls) events.push(
    { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'test__inspect' },
    { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: args },
    { type: 'TOOL_CALL_END', toolCallId: id });
  events.push({ type: 'RUN_FINISHED', ...key });
  if (stream) for (const [index, event] of events.entries()) assert.equal(producer.observe(key, index + 1, event), 'accepted');
  if (allow) for (const call of producer.inspect(key).calls) producer.decide(key, call.id, 'allow', call.activationId, call.argumentsDigest);
  return { ...f, host, producer, key, events, bound, pin: retained?.bind(bound.run), activationId: bound.command.body.frontend.tools[0].activationId, client: frontendToolsFor(host).client(scope, actor) };
}

test('withdrawal acknowledges without producer callbacks and fences a retained client after reopen', async t => {
  const f = await setup(t); let callbackCalls = 0, acknowledgement, failure;
  try {
    acknowledgement = await f.host.frontendBinding({ scope, id: 'offered', action: 'unavailable' }, actor, () => {
      callbackCalls++; throw new Error('Producer callback unavailable');
    });
  } catch (error) { failure = error.message; }
  const db = new DatabaseSync(f.path);
  assert.equal(db.prepare('SELECT state FROM frontend_send_owners').get().state, 'unavailable'); db.close();
  const retainedClaim = f.client.claim(f.key, 'first', 'original-a');
  t.diagnostic(JSON.stringify({ callbackCalls, acknowledgement, failure, retainedClaim: retainedClaim.kind }));
  assert.equal(retainedClaim.kind, 'unavailable');
  assert.equal(callbackCalls, 0);
  assert.equal(failure, undefined);
  assert.deepEqual(acknowledgement, { kind: 'unavailable', id: 'offered', reason: 'closures-unavailable' });
  f.host.close(); await f.host.drained;
  const reopened = f.open(), client = frontendToolsFor(reopened).client(scope, actor);
  assert.equal(client.inspect(f.key).status, 'blocked');
  assert.equal(client.claim(f.key, 'second', 'original-a').kind, 'unavailable');
});

function rows(path) {
  const db = new DatabaseSync(path);
  try { return Object.fromEntries(['frontend_runs', 'frontend_events', 'frontend_receipts', 'frontend_send_owners', 'frontend_send_tombstones']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])); }
  finally { db.close(); }
}
const withdraw = f => f.host.frontendBinding({ scope, id: 'offered', action: 'unavailable' }, actor,
  () => { assert.fail('Withdrawal must not call a producer'); });

test('unavailable observations and reads preserve all stored coordinator evidence', async t => {
  const f = await setup(t); await withdraw(f);
  const before = rows(f.path), cyclic = {}; cyclic.self = cyclic;
  for (const input of [cyclic, { type: 'TEXT_MESSAGE_CONTENT', delta: 'x'.repeat(64001) }, { invalid: true }, { type: 'RUN_ERROR', message: 'late' }]) {
    assert.equal(f.producer.observe(f.key, 9, input), 'faulted');
    assert.deepEqual(rows(f.path), before);
  }
  for (const cursor of [0, -1, 1.5, '1', NaN]) assert.throws(() => f.producer.observe(f.key, cursor, f.events[0]), /Invalid cursor/);
  assert.equal(f.producer.observe(f.key, 1, f.events[0]), 'duplicate');
  assert.equal(f.producer.observe(f.key, 1, { ...f.events[0], runId: 'other' }), 'faulted');
  assert.equal(f.producer.inspect(f.key).status, 'blocked');
  assert.equal(f.client.inspect(f.key).calls.some(call => call.status === 'claimable'), false);
  assert.equal(f.producer.results(f.key).kind, 'blocked');
  assert.deepEqual(rows(f.path), before);
  const db = new DatabaseSync(f.path);
  db.exec('BEGIN IMMEDIATE');
  try {
    assert.equal(f.producer.inspect(f.key).status, 'blocked');
    assert.equal(f.producer.results(f.key).kind, 'blocked');
    assert.equal(f.client.inspect(f.key).status, 'blocked');
  } finally { db.exec('ROLLBACK'); db.close(); }
});

test('faulted diagnostics survive withdrawal and explicit cancellation still blocks', async t => {
  const f = await setup(t);
  assert.equal(f.producer.observe(f.key, 9, { bad: true }), 'faulted');
  await withdraw(f); const before = rows(f.path);
  assert.equal(f.producer.inspect(f.key).status, 'faulted');
  assert.equal(f.client.inspect(f.key).calls.some(call => call.status === 'claimable'), false);
  assert.equal(f.producer.results(f.key).kind, 'blocked');
  assert.deepEqual(rows(f.path), before);
  f.producer.cancel(f.key); assert.equal(f.producer.inspect(f.key).status, 'blocked');
});

test('registration after withdrawal remains blocked and never revives a matching original binding', async t => {
  const f = await setup(t, { stream: false }); await withdraw(f);
  const registration = { identity: f.bound.run, threadId: f.key.threadId, platform: 'desktop',
    bindings: f.bound.command.body.frontend.tools.map(tool => ({ ...tool, name: tool.definition.name })) };
  const before = rows(f.path); f.producer.register(registration); assert.deepEqual(rows(f.path), before);
  const db = new DatabaseSync(f.path); db.exec('DELETE FROM frontend_runs'); db.close();
  f.producer.register(registration);
  assert.equal(f.producer.inspect(f.key).status, 'blocked');
  assert.equal(f.producer.observe(f.key, 1, f.events[0]), 'faulted');
  assert.throws(() => f.producer.register({ ...registration, platform: 'ios' }), /Conflicting/);
});

for (const version of [1, 2]) test(`targeted owner lookup distinguishes tagged version ${version} from missing offered ownership`, async t => {
  const f = await setup(t, { version });
  const db = new DatabaseSync(f.path);
  db.exec('DELETE FROM frontend_send_owners');
  const target = JSON.parse(db.prepare("SELECT target FROM commands WHERE id='offered'").get().target);
  target.operation.request.threadId = 'unrelated';
  db.prepare("INSERT INTO commands(host,conversation,id,operation,intent,target,observation,receipt) SELECT host,conversation,'unrelated','unrelated-op','malformed intent',?,observation,receipt FROM commands WHERE id='offered'").run(JSON.stringify(target));
  db.close();
  if (version === 2) {
    assert.throws(() => f.producer.inspect(f.key), /frontend-owner-missing/);
    assert.throws(() => f.client.claim(f.key, 'first', f.activationId), /frontend-owner-missing/);
  } else assert.equal(f.client.claim(f.key, 'first', f.activationId).kind, 'permit');
});

for (const failure of ['owner', 'receipt']) test(`${failure} persistence failure rolls back the whole operation`, async t => {
  const f = await setup(t), db = new DatabaseSync(f.path);
  if (failure === 'owner') {
    db.exec("CREATE TRIGGER reject_owner BEFORE UPDATE ON frontend_send_owners BEGIN SELECT RAISE(ABORT,'owner refused'); END");
    const before = rows(f.path);
    await assert.rejects(withdraw(f), /owner refused/); assert.deepEqual(rows(f.path), before);
    assert.equal(f.client.claim(f.key, 'first', f.activationId).kind, 'permit');
  } else {
    const permit = f.client.claim(f.key, 'first', f.activationId); await withdraw(f);
    db.exec("CREATE TRIGGER reject_run BEFORE UPDATE ON frontend_runs BEGIN SELECT RAISE(ABORT,'run refused'); END");
    const before = rows(f.path);
    assert.throws(() => f.client.receipt(f.key, permit.permitId, { kind: 'completed', output: 'late original' }), /run refused/);
    assert.deepEqual(rows(f.path), before);
    db.exec('DROP TRIGGER reject_run');
    assert.equal(f.client.receipt(f.key, permit.permitId, { kind: 'completed', output: 'late original' }), 'recorded');
  }
  db.close();
});

async function worker(t, f) {
  const child = fork(new URL('./frontend-owner-worker.mjs', import.meta.url), [f.path, JSON.stringify(f.key), f.activationId], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  const [ready] = await once(child, 'message'); assert.equal(ready.kind, 'ready', errors);
  return { child, async request(action, data = {}) {
    const response = once(child, 'message'); child.send({ action, ...data });
    const [message] = await response; if (message.error) throw new Error(message.error);
    return message.value;
  } };
}
for (const order of ['withdrawal-first', 'claim-first', 'death-after-permit']) test(`independent retained clients obey ${order} ordering`, async t => {
  let effects = 0; const f = await setup(t, { effect: () => effects++ });
  const claimant = await worker(t, f), owner = await worker(t, f);
  let permit;
  if (order !== 'withdrawal-first') {
    permit = await claimant.request('claim', { callId: 'first' }); assert.equal(permit.kind, 'permit');
    assert.equal(effects, 0);
    if (order === 'death-after-permit') { claimant.child.kill(); await once(claimant.child, 'exit'); }
  }
  assert.deepEqual(await owner.request('withdraw'), { kind: 'unavailable', id: 'offered', reason: 'closures-unavailable' });
  const observer = order === 'death-after-permit' ? await worker(t, f) : claimant;
  assert.equal((await observer.request('claim', { callId: 'first' })).kind, permit ? 'uncertain' : 'unavailable');
  assert.equal((await observer.request('claim', { callId: 'second' })).kind, 'unavailable');
  if (order === 'claim-first') {
    const result = await f.pin.invoke(permit.name, permit.arguments, f.activationId);
    assert.equal(effects, 1);
    assert.equal(await observer.request('receipt', { permitId: permit.permitId, result }), 'recorded');
    assert.equal(await observer.request('receipt', { permitId: permit.permitId, result }), 'duplicate');
    assert.equal((await observer.request('claim', { callId: 'second' })).kind, 'unavailable');
  } else assert.equal(effects, 0);
  assert.equal(f.producer.results(f.key).kind, 'blocked');
  t.diagnostic(JSON.stringify({ order, effects, originalPermit: Boolean(permit), secondCall: 'unavailable' }));
});

for (const phase of ['before-transaction', 'inside-transaction']) test(`claim authorization ${phase} never overwrites a prior permit`, async t => {
  const f = await setup(t); let calls = 0, inner, nestedFailure;
  const client = frontendToolsFor(f.host).client(scope, { ...actor, authorized(request) {
    if (request.action !== 'claim') return true;
    calls++;
    if (calls === (phase === 'before-transaction' ? 1 : 2)) {
      try { inner = f.client.claim(f.key, 'first', f.activationId); }
      catch (error) { nestedFailure = error.message; }
    }
    return true;
  } });
  const result = client.claim(f.key, 'first', f.activationId);
  if (phase === 'before-transaction') {
    assert.equal(inner.kind, 'permit'); assert.equal(result.kind, 'uncertain');
    assert.equal(nestedFailure, undefined);
    assert.equal(f.client.receipt(f.key, inner.permitId, { kind: 'completed', output: 'original' }), 'recorded');
  } else {
    assert.match(nestedFailure, /transaction/); assert.equal(inner, undefined); assert.equal(result.kind, 'permit');
    assert.equal(f.client.receipt(f.key, result.permitId, { kind: 'completed', output: 'original' }), 'recorded');
  }
  assert.equal(f.client.claim(f.key, 'first', f.activationId).kind, 'uncertain');
});

test('receipt authorization rejects nested public writes and preserves the original permit on throw', async t => {
  const f = await setup(t), permit = f.client.claim(f.key, 'first', f.activationId);
  const before = rows(f.path); let nestedFailure;
  const client = frontendToolsFor(f.host).client(scope, { ...actor, authorized(request) {
    if (request.action === 'receipt') {
      try { f.client.claim(f.key, 'second', f.activationId); } catch (error) { nestedFailure = error.message; }
      throw new Error('Receipt authorization interrupted');
    }
    return true;
  } });
  assert.throws(() => client.receipt(f.key, permit.permitId, { kind: 'completed', output: 'original' }), /authorization interrupted/);
  assert.match(nestedFailure, /transaction/); assert.deepEqual(rows(f.path), before);
  await withdraw(f);
  assert.equal(f.client.receipt(f.key, permit.permitId, { kind: 'completed', output: 'original' }), 'recorded');
  assert.equal(f.client.receipt(f.key, permit.permitId, { kind: 'completed', output: 'original' }), 'duplicate');
});

for (const excess of [0, 1]) test(`public observation constructs the ${1000000 + excess}-byte ready boundary atomically`, async t => {
  const calls = Array.from({ length: 16 }, (_, index) => ({ id: `call-${index}`, args: JSON.stringify({ text: 'x'.repeat(60000) }) }));
  const calibration = await setup(t, { stream: false, description: '', calls, allow: false });
  const raw = JSON.parse(rows(calibration.path).frontend_runs[0].data);
  raw.cursor = calibration.events.length;
  raw.eventBytes = calibration.events.reduce((bytes, event) => bytes + Buffer.byteLength(canonicalJson(event)), 0);
  raw.status = 'ready'; raw.pending = calls.map(call => call.id);
  raw.calls = calls.map(call => ({ id: call.id, name: 'test__inspect', state: { kind: 'ready', args: JSON.parse(call.args),
    digest: createHash('sha256').update(canonicalJson(JSON.parse(call.args))).digest('hex'), decision: 'pending' } }));
  const padding = 1000000 + excess - Buffer.byteLength(canonicalJson(raw));
  assert.ok(padding > 0 && padding < 64000);
  const f = await setup(t, { stream: false, description: 'p'.repeat(padding), calls, allow: false });
  for (const [index, event] of f.events.slice(0, -1).entries()) assert.equal(f.producer.observe(f.key, index + 1, event), 'accepted');
  const before = rows(f.path);
  if (excess) {
    assert.throws(() => f.producer.observe(f.key, f.events.length, f.events.at(-1)), /capacity/);
    assert.deepEqual(rows(f.path), before);
  } else {
    assert.equal(f.producer.observe(f.key, f.events.length, f.events.at(-1)), 'accepted');
    assert.equal(Buffer.byteLength(rows(f.path).frontend_runs[0].data), 1000000);
    await withdraw(f);
    assert.equal(f.producer.inspect(f.key).status, 'blocked');
    f.producer.cancel(f.key);
    assert.equal(Buffer.byteLength(rows(f.path).frontend_runs[0].data), 1000002);
    f.host.close(); await f.host.drained;
    assert.equal(frontendToolsFor(f.open()).producer(scope).inspect(f.key).status, 'blocked');
  }
});

test('over-cap stored metadata remains readable but a blocked write above 1000002 refuses atomically', async t => {
  const f = await setup(t), db = new DatabaseSync(f.path);
  const raw = JSON.parse(rows(f.path).frontend_runs[0].data); raw.status = 'blocked';
  raw.bindings[0].definition.description += 'x'.repeat(1000003 - Buffer.byteLength(canonicalJson(raw)));
  db.prepare('UPDATE frontend_runs SET data=?').run(canonicalJson(raw)); db.close();
  const before = rows(f.path);
  assert.equal(Buffer.byteLength(before.frontend_runs[0].data), 1000003);
  assert.equal(f.producer.inspect(f.key).status, 'blocked');
  assert.throws(() => f.producer.cancel(f.key), /capacity/);
  assert.deepEqual(rows(f.path), before);
});
