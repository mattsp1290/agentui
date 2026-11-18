import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { host, until, view, assistantTexts, runOf } from '../../../tests/extensions/providers/conformance/harness.mjs';
import { coworkersService } from './support/coworkers-service.mjs';
import { MAX_REQUESTS, MAX_TEXT_BYTES } from '../dist/presentation.js';

const directory = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).agentui.extension;
const instance = { namespace: 'coworkers', installationId: 'team', generation: '1', protocolVersion: '1' };
/** The built package through an installed entry, so every call runs through the host's real credential authority. */
const installed = (remote, token = remote.token) => ({ value: { kind: 'installed', directory, manifest, installations: [{ id: 'team', instance,
  service: remote.origin, expectedAuthority: 'remote-provider', authentication: { kind: 'secret', revision: '1', resolve: async () => token } }] } });
const call = (f, operation, input = {}) => f.client.extensionCall({ namespace: 'coworkers', installationId: 'team', operation, input });
async function create(f, label) {
  const agent = (await f.client.metadata()).agents.find(value => value.namespace === 'coworkers' && value.label === label);
  const scope = { hostId: f.running.hostId, conversationId: randomUUID() };
  await f.client.create(scope, agent.id);
  return scope;
}

test('a wrong request contract and a rejected token are typed failures, not opaque errors', { timeout: 30_000 }, async t => {
  const wrong = await coworkersService(t, { requestContract: 'other-contract' });
  const f = await host(t, [installed(wrong)]);
  assert.deepEqual((await f.running.discoverProviders()).map(item => [item.kind, item.cause]), [['unavailable', 'version-unsupported']]);
  const remote = await coworkersService(t);
  const g = await host(t, [installed(remote, 'wrong-token')]);
  assert.deepEqual((await g.running.discoverProviders()).map(item => [item.kind, item.cause]), [['unavailable', 'authentication-failed']]);
  assert.deepEqual(await call(g, 'coworkers.list'), { kind: 'refused', code: 'unauthorized' });
});

test('coworkers.list stays under the operation output limit for a large directory and reports truncation', { timeout: 30_000 }, async t => {
  const long = 'x'.repeat(1_000);
  const coworkers = Array.from({ length: 800 }, (_, n) => ({ coworkerId: `c-${n}`, name: `${n} ${long}`, role: long, workspace: 'disabled', slack: false, instructions: 'i' }));
  const remote = await coworkersService(t, { coworkers }), f = await host(t, [installed(remote)]);
  const result = await call(f, 'coworkers.list');
  assert.equal(result.kind, 'ok', JSON.stringify(result).slice(0, 200));
  assert.equal(result.output.truncated, true);
  assert.ok(result.output.coworkers.length > 0 && result.output.coworkers.length < 800);
  assert.ok(result.output.coworkers.every(item => Array.from(item.name).length <= 200 && Array.from(item.role).length <= 200));
  assert.ok(Buffer.byteLength(JSON.stringify(result.output)) < 256_000);
});

test('discovery, idempotent creation, a polled reply, cancel, failure and uncertainty map onto runs', { timeout: 60_000 }, async t => {
  const remote = await coworkersService(t), f = await host(t, [installed(remote)]);
  const agents = (await f.client.metadata()).agents.filter(value => value.namespace === 'coworkers');
  assert.deepEqual(agents.map(agent => [agent.label, agent.providerAgentId]), [['Ada', 'ada'], ['Grace', 'grace']]);
  assert.deepEqual(await call(f, 'coworkers.list'), { kind: 'ok', output: { management: false, coworkers: [
    { coworkerId: 'ada', name: 'Ada', role: 'Researcher', workspace: 'read_only', slack: false, instructionsBytes: 19 },
    { coworkerId: 'grace', name: 'Grace', role: 'Engineer', workspace: 'read_write', slack: true, instructionsBytes: 19 }], truncated: false } });
  const scope = await create(f, 'Ada');
  await f.client.create(scope, agents[0].id);
  assert.equal(remote.conversations.size, 1, 'a repeated creation names the same upstream conversation');
  const store = await f.store(scope);
  assert.equal((await store.send('Summarize the plan')).receipt.state.kind, 'accepted');
  await until(() => view(store).domain.messages.some(message => message.role === 'user'), 'user message polled');
  assert.equal(runOf(store)?.kind, 'running');
  remote.complete('Here is the summary.');
  await until(() => runOf(store)?.kind === 'ended', 'polled completion');
  assert.equal(runOf(store).outcome, 'completed');
  assert.deepEqual(assistantTexts(store), ['Here is the summary.']);
  await until(async () => (await f.client.conversation(scope).receipt(view(store).domain.messages.length && Object.keys(store.getSnapshot().document.receipts)[0]))?.state.kind === 'completed', 'send settled');

  assert.equal((await store.send('Start a long task')).receipt.state.kind, 'accepted');
  await until(() => runOf(store)?.kind === 'running', 'second run');
  assert.equal((await store.cancel(runOf(store).runId)).receipt.state.kind !== 'rejected', true);
  await until(() => runOf(store)?.kind === 'ended', 'cancelled run');
  assert.equal(runOf(store).outcome, 'interrupted');

  for (const [move, outcome] of [[() => remote.fail(), 'failed'], [() => remote.markUncertain(), 'connection-lost']]) {
    const other = await f.store(await create(f, 'Grace'));
    await other.send(`Turn ending ${outcome}`);
    await until(() => runOf(other)?.kind === 'running', 'run started');
    move();
    await until(() => runOf(other)?.kind === 'ended', `${outcome} run`);
    assert.equal(runOf(other).outcome, outcome);
  }
});

test('a send whose reply was lost and whose read returns 404 is uncertain first and completes later with exactly one run', { timeout: 60_000 }, async t => {
  const remote = await coworkersService(t), f = await host(t, [installed(remote)]);
  const scope = await create(f, 'Ada'), store = await f.store(scope);
  remote.loseNext('POST', path => path.endsWith('/requests'));
  const result = await store.send('Committed but unread');
  const requestId = [...remote.requests.keys()][0];
  remote.invisible(requestId);
  assert.notEqual(result.kind === 'receipt' && result.receipt.state.kind, 'accepted');
  const id = store.getSnapshot().outbox[0]?.command.clientCommandId ?? Object.keys(store.getSnapshot().document.receipts)[0];
  assert.equal((await f.client.reconcile(scope, id))?.state.kind, 'uncertain');
  remote.visible(requestId);
  remote.complete('Arrived after all');
  await until(() => assistantTexts(store).includes('Arrived after all'), 'reply after the read became visible');
  assert.equal(remote.requests.size, 1, 'no second request was sent');
  const settled = await f.client.reconcile(scope, id);
  assert.ok(['accepted', 'completed'].includes(settled?.state.kind), JSON.stringify(settled));
});

test('a reply that completes while the service is down arrives after it returns, with no retry and no ended feed; close stops polling', { timeout: 60_000 }, async t => {
  const remote = await coworkersService(t), f = await host(t, [installed(remote)]);
  const scope = await create(f, 'Ada'), store = await f.store(scope);
  await store.send('Survive an outage');
  await until(() => runOf(store)?.kind === 'running', 'running');
  remote.down();
  remote.complete('Done while you were away');
  await new Promise(resolve => setTimeout(resolve, 2500));
  remote.up();
  await until(() => assistantTexts(store).includes('Done while you were away'), 'reply after the outage', 30_000);
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, 1);
  assert.equal(store.getSnapshot().connection.kind, 'connected');
  await f.close();
  const before = remote.calls.length;
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(remote.calls.length, before, 'no polls after close');
});

test('a window of 100 requests at the maximum text size stays under the state budget and observation continues', { timeout: 60_000 }, async t => {
  const remote = await coworkersService(t), f = await host(t, [installed(remote)]);
  const scope = await create(f, 'Ada'), store = await f.store(scope);
  const conversationId = [...remote.conversations.keys()][0], big = 'x'.repeat(MAX_TEXT_BYTES + 500);
  for (let index = 0; index < MAX_REQUESTS + 5; index++) {
    remote.addRequest(conversationId, { requestId: randomUUID(), text: big, status: 'completed', reply: big });
  }
  await until(() => view(store).domain.messages.length >= 2 * MAX_REQUESTS, 'large window delivered', 20_000);
  assert.equal(view(store).domain.messages[0].text.startsWith('Older turns are not shown'), true);
  assert.ok(view(store).domain.messages.slice(1).every(message => Buffer.byteLength(JSON.stringify(message.text)) <= MAX_TEXT_BYTES));
  assert.ok(Buffer.byteLength(JSON.stringify(view(store).domain)) < 1_000_000, 'the presented transcript stays under the host bound');
  await store.send('Still observed');
  remote.complete('Yes');
  await until(() => assistantTexts(store).includes('Yes'), 'observation continues', 20_000);
});
