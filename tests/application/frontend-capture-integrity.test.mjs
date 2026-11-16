import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { createProviderRegistry } from '@agentui/host';
import { fixture as hostFixture, scope as hostScope } from '../host/fixture.mjs';
import { fixture, create, offered, send, actualInput, aguiExtension, unavailable } from './provider-send-fixture.mjs';

const tables = ['commands', 'frontend_sends', 'events', 'conversations'];
const durable = f => f.inspect(db => Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));

test('command insertion failure after new owner insertion rolls back the whole admission', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f), before = durable(f);
  f.inspect(db => db.exec(`CREATE TRIGGER fail_command AFTER INSERT ON commands BEGIN
    SELECT CASE WHEN (SELECT COUNT(*) FROM frontend_sends WHERE command_id=NEW.id AND state='available')=1
      AND (SELECT COUNT(*) FROM commands INDEXED BY commands_tagged_send_key WHERE host=NEW.host AND conversation=NEW.conversation
        AND json_extract(target, '$.kind')='provider' AND json_extract(target, '$.operation.kind')='send'
        AND json_extract(target, '$.operation.protocol')='ag-ui')=1
      THEN RAISE(ABORT,'late-command-insert') END; END`));
  const command = offered(scope);
  await unavailable(f.client.conversation(scope).submit(command));
  assert.deepEqual(durable(f), before);
  assert.equal(a.calls.submits.length, 0);
  f.inspect(db => db.exec('DROP TRIGGER fail_command'));
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'completed');
  assert.equal(a.calls.submits.length, 1);
});

test('multiple actor tombstones remain isolated before and after original owner admission', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f);
  const others = [await f.anotherClient(), await f.anotherClient()];
  for (const other of others) assert.equal((await other.frontendBinding({ scope, id: 'shared', action: 'unavailable' })).reason, 'closures-unavailable');
  for (const other of others) {
    assert.equal((await other.frontendBinding({ scope, id: 'shared', action: 'recover' })).reason, 'closures-unavailable');
    assert.equal((await other.conversation(scope).submit(offered(scope, 'shared'))).reason, 'frontend-closures-unavailable');
  }
  assert.equal((await f.client.frontendBinding({ scope, id: 'shared', action: 'recover' })).kind, 'pending');
  assert.equal((await f.client.conversation(scope).submit(offered(scope, 'shared'))).receipt.state.kind, 'completed');
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_sends').get().n), 3);
  for (const other of others) await unavailable(other.frontendBinding({ scope, id: 'shared', action: 'recover' }));
  await f.restart([a]);
  assert.equal((await f.client.frontendBinding({ scope, id: 'shared', action: 'recover' })).kind, 'bound');
  assert.equal(a.calls.submits.length, 1);
});

async function localProviderHost(t, a, assertAuthorized = () => {}) {
  const registry = createProviderRegistry([{ ...a.value, authority: { credentials: {}, issue: () => ({ credential: null,
    expectedAuthority: 'remote-provider', assertAuthorized }), async close() {} } }]);
  await registry.activate(); t.after(() => registry.close());
  const [discovered] = await registry.discover();
  const target = { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance,
    agent: discovered.agents[0], presentationVersion: 1, expectedAuthority: discovered.expectedAuthority };
  const f = hostFixture(t), host = f.open({ providers: registry });
  await host.createProviderConversation(hostScope, target, registry);
  return { host, target, registry };
}

test('capture decoding revocation of in-memory provider authority prevents durable admission', async t => {
  let authorized = true, revoke = false, decodes = 0;
  const a = aguiExtension({ decode(value) { decodes++; if (revoke) authorized = false; return value; } });
  const { host } = await localProviderHost(t, a, () => { if (!authorized) throw new Error('Provider authority revoked'); });
  const actor = { id: 'owner', platform: 'desktop', authorized: () => true };
  const before = host.inspect(hostScope).snapshot;
  revoke = true;
  assert.deepEqual(await host.conversation(hostScope, actor).submit(offered(hostScope)), { kind: 'rejected', reason: 'provider-command-unavailable' });
  assert.equal(authorized, false); assert.equal(decodes, 1);
  assert.equal(await host.conversation(hostScope, actor).receipt('offered'), null);
  assert.deepEqual(host.inspect(hostScope).snapshot, before);
  assert.equal(a.calls.submits.length, 0);
});

test('identical conversation command thread and run IDs remain independent across hosts in one database', async t => {
  const a = aguiExtension(), { host, target, registry } = await localProviderHost(t, a);
  const second = { ...hostScope, hostId: 'host-b' }, actor = { id: 'owner', platform: 'desktop', authorized: () => true };
  await host.createProviderConversation(second, target, registry);
  for (const scope of [hostScope, second]) {
    const command = offered(scope);
    assert.equal((await host.conversation(scope, actor).submit(command)).receipt.state.kind, 'completed');
    assert.equal((await host.conversation(scope, actor).submit(offered(scope, 'another'))).reason, 'frontend-run-reused');
    assert.equal((await host.conversation(scope, actor).receipt('offered')).state.kind, 'completed');
  }
  assert.equal(a.calls.submits.length, 2);
});

test('legacy paired-key tombstones still permanently reserve their capture key', async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f);
  await f.client.frontendBinding({ scope, id: 'legacy', action: 'unavailable' });
  f.inspect(db => db.exec("UPDATE frontend_sends SET thread_id='actual-thread', run_id='actual-run'"));
  assert.equal((await f.client.frontendBinding({ scope, id: 'legacy', action: 'recover' })).reason, 'closures-unavailable');
  const before = durable(f);
  for (const command of [send(scope), offered(scope)]) {
    assert.deepEqual(await f.client.conversation(scope).submit(command), { kind: 'rejected', reason: 'frontend-run-reused' });
    assert.deepEqual(durable(f), before);
  }
  assert.equal(a.calls.submits.length, 0);
});

const admissionWorker = `
  const { parentPort, workerData } = await import('node:worker_threads');
  if (workerData.mismatch) {
    const { registerHooks } = await import('node:module');
    const parser = new URL('./provider-commands.js', workerData.store).href;
    registerHooks({ resolve(specifier, context, next) {
      if (specifier === './provider-commands.js' && context.parentURL === workerData.store) {
        const source = 'export * from ' + JSON.stringify(parser) + '; import { parseProviderCapture as parse } from ' + JSON.stringify(parser)
          + '; export function parseProviderCapture(...args) { const capture = parse(...args); return { ...capture, agui: { ...capture.agui, runId: "parsed-other-run" } }; }';
        return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
      }
      return next(specifier, context);
    } });
  }
  const { SqliteStore } = await import(workerData.store);
  const { budgets } = await import(workerData.model);
  const { transcriptProjection } = await import('@agentui/contracts/conversation');
  const store = new SqliteStore(workerData.path, transcriptProjection, budgets());
  parentPort.postMessage({ ready: true });
  parentPort.once('message', () => {
    try {
      const result = store.admit(workerData.command, { kind: 'supported' }, undefined, (_original, operationId) => ({
        ...workerData.target, operation: { ...workerData.target.operation, operationId, protocol: 'ag-ui',
          request: { ...workerData.request, tools: workerData.command.version === 2 ? workerData.command.body.frontend.tools.map(tool => tool.definition) : [] } }
      }), { id: workerData.actor, platform: 'desktop', authorized: () => true });
      if (result.kind === 'owned') store.settle(workerData.command.scope, workerData.command.clientCommandId, { kind: 'not-dispatched', reason: 'race-complete' });
      parentPort.postMessage({ result: result.kind === 'owned' ? { kind: 'owned' } : result });
    } catch (error) { parentPort.postMessage({ error: String(error) }); }
    finally { store.close(); }
  });`;
async function prepareAdmission(t, data) {
  const worker = new Worker(admissionWorker, { eval: true, type: 'module', workerData: { ...data,
    store: new URL('../../packages/host/dist/sqlite-store.js', import.meta.url).href,
    model: new URL('../../packages/host/dist/durable-model.js', import.meta.url).href } });
  t.after(() => worker.terminate());
  await new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', value => value.ready ? resolve() : reject(new Error(JSON.stringify(value)))); });
  return () => {
    const result = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('message', value => value.error ? reject(new Error(value.error)) : resolve(value.result)); });
    worker.postMessage('admit'); return result;
  };
}

test('independent SQLite admissions racing for one offered key commit one owner', async t => {
  const a = aguiExtension({ request: text => ({ ...actualInput(text), runId: text === 'Race' ? 'racing-run' : 'seed-run' }) });
  const f = await fixture(t, [a]), scope = await create(f);
  await f.client.conversation(scope).submit(send(scope, 'seed'));
  const target = f.inspect(db => JSON.parse(db.prepare("SELECT target FROM commands WHERE id='seed'").get().target));
  const request = { ...actualInput('Race'), runId: 'racing-run' };
  const commands = ['first', 'second'].map(id => { const command = offered(scope, id); command.body.text = 'Race'; return command; });
  const workers = await Promise.all(commands.map(command => prepareAdmission(t, { path: join(f.directory, 'host.sqlite'),
    command, target, request, actor: command.clientCommandId })));
  const results = await Promise.all(workers.map(start => start()));
  assert.deepEqual(results.map(result => result.kind).sort(), ['owned', 'rejected']);
  const loser = results.findIndex(result => result.kind === 'rejected');
  assert.ok(['send-awaiting-confirmation', 'frontend-run-reused'].includes(results[loser].reason));
  const before = durable(f);
  assert.deepEqual(await f.client.conversation(scope).submit(commands[loser]), { kind: 'rejected', reason: 'frontend-run-reused' });
  assert.deepEqual(durable(f), before);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM frontend_sends').get().n), 1);
  assert.equal(f.inspect(db => db.prepare('SELECT COUNT(*) AS n FROM commands WHERE id<>?').get('seed').n), 1);
  assert.equal(a.calls.submits.length, 1);
});

for (const version of [1, 2]) test(`SQL projection refuses mismatched parsed version ${version} key without durable writes`, async t => {
  const a = aguiExtension(), f = await fixture(t, [a]), scope = await create(f);
  await f.client.conversation(scope).submit(send(scope, 'seed'));
  const target = f.inspect(db => JSON.parse(db.prepare("SELECT target FROM commands WHERE id='seed'").get().target));
  const before = durable(f), command = version === 2 ? offered(scope, 'candidate') : send(scope, 'candidate');
  const start = await prepareAdmission(t, { path: join(f.directory, 'host.sqlite'), command, target,
    request: { ...actualInput('Hello'), runId: 'candidate-run' }, actor: 'owner', mismatch: true });
  assert.deepEqual(await start(), { kind: 'rejected', reason: 'provider-command-unavailable' });
  assert.deepEqual(durable(f), before);
  assert.equal(a.calls.submits.length, 1);
});
