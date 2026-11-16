import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '@agentui/contracts';
import { providerTarget, providerObservation } from '../../packages/host/dist/provider-commands.js';
import { fixture, create, stored, send, offered, unavailable, aguiExtension } from './provider-send-fixture.mjs';

for (const commandFor of [send, offered]) test(`AG-UI ${commandFor.name} rejects forged restored run evidence`, async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f), command = commandFor(scope);
  await f.client.conversation(scope).submit(command);
  const forged = forgeRun(JSON.parse(stored(f, 'chat').observation));
  f.inspect(db => db.prepare('UPDATE commands SET observation=?').run(canonicalJson(forged)));
  await f.restart([a]);
  await unavailable(f.client.conversation(scope).receipt(command.clientCommandId));
  assert.equal(a.calls.submits.length, 1);
});

test('AG-UI offered capture and dispatch each decode the authored input once', async t => {
  let decodes = 0;
  const a = aguiExtension({ decode(value) { decodes++; return value; } });
  const f = await fixture(t, [a]), scope = await create(f);
  assert.equal((await f.client.conversation(scope).submit(offered(scope))).receipt.state.kind, 'completed');
  assert.equal(decodes, 2);
  assert.equal(a.calls.translations, 1);
  assert.equal(a.calls.submits.length, 1);
});

for (const commandFor of [send, offered]) test(`AG-UI ${commandFor.name} retains raw tagged bytes and private provenance across restart`, async t => {
  const raw = { runId: 'raw-run', threadId: 'raw-thread', messages: [], state: null, custom: { preserved: true } };
  const a = aguiExtension({ request: () => raw }), f = await fixture(t, [a]), scope = await create(f), command = commandFor(scope);
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'completed');
  const original = stored(f, 'chat'), target = JSON.parse(original.target);
  const expected = command.version === 2 ? { ...raw, tools: command.body.frontend.tools.map(tool => tool.definition) } : raw;
  assert.equal(target.operation.protocol, 'ag-ui');
  assert.equal(canonicalJson(target.operation.request), canonicalJson(expected));
  assert.equal(canonicalJson(providerTarget(target, scope)), original.target);
  assert.equal(JSON.parse(original.observation).evidence.correlation, original.target);
  assert.deepEqual(a.calls.submits[0].request, expected);
  assert.equal(Object.hasOwn(a.calls.submits[0], 'protocol'), false);
  await f.restart([a]);
  assert.equal((await f.client.conversation(scope).receipt(command.clientCommandId)).state.kind, 'completed');
  assert.deepEqual(stored(f, 'chat'), original);
});

function untagHistory(f) {
  const row = stored(f, 'chat'), target = JSON.parse(row.target), observation = JSON.parse(row.observation);
  delete target.operation.protocol;
  observation.evidence.correlation = canonicalJson(target);
  f.inspect(db => db.prepare('UPDATE commands SET target=?,observation=?').run(canonicalJson(target), canonicalJson(observation)));
  return stored(f, 'chat');
}
function forgeRun(observation) {
  observation.evidence.source.run.identity.runId = 'foreign-run';
  observation.evidence.source.run.reference.ref.opaqueId = 'foreign-run';
  observation.evidence.operation.id = canonicalJson(observation.evidence.source.run.reference);
  return observation;
}
for (const commandFor of [send, offered]) test(`untagged historical ${commandFor.name} keeps saved correlation and its original run policy`, async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f), command = commandFor(scope);
  await f.client.conversation(scope).submit(command);
  const original = untagHistory(f), target = JSON.parse(original.target);
  assert.equal(canonicalJson(providerTarget(target, scope)), original.target);
  await f.restart([a]);
  assert.equal((await f.client.conversation(scope).receipt(command.clientCommandId)).state.kind, 'completed');
  assert.deepEqual(stored(f, 'chat'), original);
  if (command.version === 2) assert.equal((await f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' })).kind, 'bound');
  f.inspect(db => db.prepare('UPDATE commands SET observation=?').run(canonicalJson(forgeRun(JSON.parse(original.observation)))));
  if (command.version === 2) await unavailable(f.client.conversation(scope).receipt(command.clientCommandId));
  else assert.equal((await f.client.conversation(scope).receipt(command.clientCommandId)).state.kind, 'completed');
});

test('untagged historical offered targets still require the exact authored offer', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f), command = offered(scope);
  await f.client.conversation(scope).submit(command);
  const original = untagHistory(f), target = JSON.parse(original.target), observation = JSON.parse(original.observation);
  target.operation.request.tools[0].description = 'Changed';
  observation.evidence.correlation = canonicalJson(target);
  f.inspect(db => db.prepare('UPDATE commands SET target=?,observation=?').run(canonicalJson(target), canonicalJson(observation)));
  await unavailable(f.client.conversation(scope).receipt(command.clientCommandId));
});

for (const commandFor of [send, offered]) test(`tagged ${commandFor.name} refuses a generic live replacement before lookup`, async t => {
  const a = aguiExtension({ submit: () => ({ kind: 'pending', evidence: {} }) }), f = await fixture(t, [a]), scope = await create(f), command = commandFor(scope);
  await f.client.conversation(scope).submit(command);
  const original = stored(f, 'chat');
  let decodes = 0;
  const generic = aguiExtension({ agui: false, decode(value) { decodes++; return value; } });
  await f.restart([generic]);
  assert.equal((await f.client.reconcile(scope, command.clientCommandId)).state.kind, 'pending');
  assert.equal(generic.calls.reconciles.length, 0);
  assert.equal(decodes, 0);
  assert.equal(stored(f, 'chat').target, original.target);
});

for (const commandFor of [send, offered]) test(`tagged ${commandFor.name} refuses fresh and lookup evidence for another run`, async t => {
  const wrong = (operation, { effect }) => effect(operation, 'completed', 'foreign-run');
  const a = aguiExtension({ submit: wrong, reconcile: wrong }), f = await fixture(t, [a]), scope = await create(f), command = commandFor(scope);
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'uncertain');
  assert.equal((await f.client.reconcile(scope, command.clientCommandId)).state.kind, 'uncertain');
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM runs').get().n), 0);
});

test('generic v1 remains generic with AG-UI-shaped raw input on fresh and restored lookup', async t => {
  const a = aguiExtension({ agui: false, submit: (operation, { effect }) => effect(operation, 'accepted', 'generic-run'),
    reconcile: (operation, { effect }) => effect(operation, 'completed', 'generic-run') });
  const f = await fixture(t, [a]), scope = await create(f), command = send(scope);
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'accepted');
  const original = stored(f, 'chat');
  assert.equal(Object.hasOwn(JSON.parse(original.target).operation, 'protocol'), false);
  await f.restart([a]);
  assert.equal((await f.client.conversation(scope).receipt(command.clientCommandId)).state.kind, 'accepted');
  assert.equal((await f.client.reconcile(scope, command.clientCommandId)).state.kind, 'completed');
  assert.equal(stored(f, 'chat').target, original.target);
});

test('untagged v1 live AG-UI lookup preserves its legacy run check', async t => {
  const a = aguiExtension({ submit: (operation, { effect }) => effect(operation, 'accepted', operation.request.runId),
    reconcile: (operation, { effect }) => effect(operation, 'completed', 'foreign-run') });
  const f = await fixture(t, [a]), scope = await create(f), command = send(scope);
  await f.client.conversation(scope).submit(command);
  const original = untagHistory(f);
  await f.restart([a]);
  assert.equal((await f.client.reconcile(scope, command.clientCommandId)).state.kind, 'accepted');
  assert.deepEqual(stored(f, 'chat'), original);
  assert.equal(a.calls.reconciles.length, 1);
});

test('durable AG-UI target grammar validates the literal and raw schema without changing bytes', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f);
  await f.client.conversation(scope).submit(send(scope));
  const original = JSON.parse(stored(f, 'chat').target);
  for (const protocol of [undefined, null, '', 'generic', true]) {
    const target = structuredClone(original); target.operation.protocol = protocol;
    assert.throws(() => providerTarget(target, scope));
  }
  for (const change of [target => { target.operation.extra = true; }, target => { target.operation.request.runId = ''; },
    target => { target.operation.request.tools = [{ name: 'duplicate', description: 'One' }, { name: 'duplicate', description: 'Two' }]; },
    target => { target.operation = { kind: 'cancel', operationId: target.operation.operationId, binding: target.operation.binding,
      run: JSON.parse(stored(f, 'chat').observation).evidence.source.run.reference, protocol: 'ag-ui' }; }]) {
    const target = structuredClone(original); change(target); assert.throws(() => providerTarget(target, scope));
  }
  const forged = forgeRun(JSON.parse(stored(f, 'chat').observation));
  assert.throws(() => providerObservation(forged, original, 'foreign-run'), /run identity/u);
});

for (const commandFor of [send, offered]) test(`AG-UI ${commandFor.name} capture rechecks provider authority after its decoder`, async t => {
  let f;
  const a = aguiExtension({ decode(value) { f.inspect(db => db.exec('UPDATE service_provider_credentials SET revoked=1')); return value; } });
  f = await fixture(t, [a]); const scope = await create(f);
  assert.equal((await f.client.conversation(scope).submit(commandFor(scope))).kind, 'rejected');
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM commands').get().n), 0);
  assert.equal(a.calls.submits.length, 0);
});

test('offered pending before admission retains exact-ID retry and requires no producer', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f), command = offered(scope);
  assert.deepEqual(await f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' }), { kind: 'pending', id: command.clientCommandId });
  assert.equal(a.calls.translations, 0);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_runs').get().n), 0);
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'completed');
  assert.deepEqual((await f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' })).command, command);
  assert.equal(a.calls.submits.length, 1);
});

test('AG-UI lookup and bound recovery each decode once without rebuilding the request', async t => {
  let decodes = 0;
  const a = aguiExtension({ decode(value) { decodes++; return value; },
    submit: (operation, { effect }) => effect(operation, 'accepted', operation.request.runId) });
  const f = await fixture(t, [a]), scope = await create(f), command = offered(scope);
  await f.client.conversation(scope).submit(command);
  assert.equal(decodes, 2);
  assert.equal((await f.client.reconcile(scope, command.clientCommandId)).state.kind, 'completed');
  assert.equal(decodes, 3);
  assert.equal((await f.client.frontendBinding({ scope, id: command.clientCommandId, action: 'recover' })).kind, 'bound');
  assert.equal(decodes, 4);
  assert.equal(a.calls.translations, 1);
});
