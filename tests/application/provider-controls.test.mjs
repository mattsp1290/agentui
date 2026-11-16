import { transcriptProjection } from '@agentui/contracts/conversation';
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { fixture, providerService, saved } from './provider-stream-fixture.mjs';
import { until, snapshot as readSnapshot } from '../host/fixture.mjs';

const command = (scope, body, id = body.kind) => ({ version: 1, scope, clientCommandId: id, body });
const approve = (scope, id = 'approve', choiceId = 'opaque/choice-1') => command(scope, { kind: 'approve', pendingId: '__proto__', choiceId }, id);
const confirmed = (operation, state = 'accepted') => ({ kind: 'confirmed', value: { kind: operation.kind, state }, evidence: { operation: operation.operationId } });
const document = (f, id = 'chat') => JSON.parse(saved(f, id).conversation.document);
async function prompt(remote, a, id = 'chat') {
  const snapshot = structuredClone(remote.conversations.get(id).snapshot), binding = snapshot.binding;
  snapshot.cursor = remote.cursor(binding);
  snapshot.decisions = [{ ref: remote.ref(binding, 'decision', '__proto__'), run: remote.ref(binding, 'run', 'same-run'), prompt: 'Allow this provider action?',
    choices: [1, 2].map(id => ({ ref: remote.ref(binding, 'choice', `opaque/choice-${id}`), label: 'Allow once' })) }];
  remote.emit({ kind: 'snapshot', snapshot });
  await until(() => a.calls.ack.some(item => item.kind === 'snapshot' && item.snapshot.cursor.opaque.token === snapshot.cursor.opaque.token));
  return snapshot;
}
async function open(t, options = {}) {
  const remote = await providerService(t, options), a = remote.extension({ controls: true }), f = await fixture(t, [a]), scope = await f.create();
  await until(() => remote.clients.size === 1);
  const snapshot = await prompt(remote, a);
  return { remote, a, f, scope, snapshot, port: f.client.conversation(scope) };
}

for (const native of [false, true]) test(`provider ${native ? 'host' : 'remote'} approval commits original target and reservation before HTTP effect; accepted stays reserved across reopen`, async t => {
  const { remote, a, f, scope, snapshot, port } = await open(t, { native });
  assert.deepEqual((await f.client.metadata()).agents.find(agent => agent.kind === 'provider').commands, ['send', 'cancel', 'approve']);
  assert.deepEqual(document(f).decisions.__proto__.choiceLabels, { 'opaque/choice-1': 'Allow once', 'opaque/choice-2': 'Allow once' });
  let original;
  remote.command((operation, path) => {
    const state = saved(f), target = JSON.parse(state.commands[0].target);
    original ??= structuredClone(operation);
    assert.deepEqual(operation, original);
    assert.deepEqual(operation.decision, snapshot.decisions[0].ref);
    assert.deepEqual(operation.choice, snapshot.decisions[0].choices[0].ref);
    assert.deepEqual(target.operation.run, snapshot.decisions[0].run);
    assert.equal(state.decisions[0].status, 'reserved');
    assert.equal(state.decisions[0].operation, operation.operationId);
    assert.equal(document(f).decisions.__proto__.reserved, true);
    if (path === '/submit') assert.equal(JSON.parse(state.commands[0].receipt).state.kind, 'pending');
    return confirmed(operation);
  });
  const before = document(f).domain;
  assert.equal((await port.submit(approve(scope))).receipt.state.kind, 'accepted');
  assert.deepEqual(document(f).domain, before);
  const accepted = saved(f);
  assert.deepEqual(await port.submit(approve(scope)), { kind: 'receipt', receipt: JSON.parse(accepted.commands[0].receipt) });
  assert.equal((await port.submit(approve(scope, 'competing', 'opaque/choice-2'))).reason, 'decision-unavailable');
  assert.equal(remote.requests.filter(value => value.path === '/submit').length, 1);
  const b = remote.extension({ controls: true, mutate(presentation) { presentation.request = () => { throw new Error('Do not translate controls'); }; } });
  await f.restart([b]); await until(() => b.calls.ready === 1);
  assert.equal(document(f).decisions.__proto__.reserved, true);
  assert.equal(saved(f).decisions[0].operation, original.operationId);
  assert.deepEqual(JSON.parse(saved(f).commands[0].target), JSON.parse(accepted.commands[0].target));
  await f.client.reconcile(scope, 'approve');
  assert.equal(remote.requests.filter(value => value.path === '/submit').length, 1);
  assert.equal(remote.requests.filter(value => value.path === '/lookup').length, 1);
  assert.equal(document(f).decisions.__proto__.reserved, true);
  assert.equal(a.calls.failures.length, 0);
});

test('lost approval reply recovers only the saved choice after omission, map replacement, translator changes and restart', async t => {
  const { remote, a, f, scope, snapshot, port } = await open(t);
  let original;
  remote.command((operation, path) => {
    if (path === '/submit') { original = structuredClone(operation); return 'lost-reply'; }
    assert.deepEqual(operation, original);
    return confirmed(operation, 'completed');
  });
  assert.equal((await port.submit(approve(scope, 'approve', 'opaque/choice-2'))).receipt.state.kind, 'uncertain');
  const target = saved(f).commands[0].target;
  snapshot.decisions = []; snapshot.cursor = remote.cursor(snapshot.binding);
  remote.emit({ kind: 'snapshot', snapshot }); await until(() => a.calls.ack.length === 2);
  assert.equal(saved(f).decisions[0].status, 'reserved');
  assert.deepEqual(document(f).decisions, {});
  const changed = structuredClone(JSON.parse(saved(f).decisions[0].data));
  changed.choices[1].reference.ref.opaqueId = 'replacement'; changed.choices[1].id = 'replacement'; changed.visible.choices[1] = 'replacement';
  f.inspect(db => db.prepare('UPDATE pending_decisions SET data=?').run(JSON.stringify(changed)));
  const b = remote.extension({ controls: true, mutate(presentation) {
    presentation.request = () => { throw new Error('Do not translate'); };
    presentation.decodeRequest = () => { throw new Error('Do not decode send requests'); };
  } });
  await f.restart([b]);
  await f.client.conversation(scope).submit(approve(scope, 'approve', 'opaque/choice-2'));
  assert.equal(remote.requests.filter(value => value.path === '/submit').length, 1);
  await f.client.reconcile(scope, 'approve');
  assert.equal(saved(f).commands[0].target, target);
  assert.equal(JSON.parse(saved(f).commands[0].receipt).state.kind, 'completed');
  assert.equal(saved(f).decisions[0].status, 'closed');
  assert.equal(saved(f).decisions[0].operation, null);
  assert.deepEqual(document(f).decisions, {});
});

for (const present of [true, false]) for (const negative of ['rejected', 'unavailable']) test(`${negative} releases approval only with latest authoritative presence=${present}`, async t => {
  const { remote, a, f, scope, snapshot, port } = await open(t);
  remote.command(async () => {
    if (!present) {
      snapshot.decisions = []; snapshot.cursor = remote.cursor(snapshot.binding);
      remote.emit({ kind: 'snapshot', snapshot }); await until(() => a.calls.ack.length === 2);
    }
    return { kind: negative, reason: 'Declined', ...(negative === 'rejected' ? { evidence: null } : {}) };
  });
  assert.equal((await port.submit(approve(scope))).receipt.state.kind, negative === 'rejected' ? 'rejected' : 'not-dispatched');
  assert.equal(saved(f).decisions[0].status, present ? 'open' : 'closed');
  assert.equal(saved(f).decisions[0].operation, null);
  if (present) {
    assert.equal(document(f).decisions.__proto__.reserved, undefined);
    assert.deepEqual(document(f).decisions.__proto__.choiceLabels, { 'opaque/choice-1': 'Allow once', 'opaque/choice-2': 'Allow once' });
  } else assert.deepEqual(document(f).decisions, {});
});

test('completion closes its owned decision, stale snapshots cannot reopen it, lookup refusal preserves accepted facts', async t => {
  const { remote, a, f, scope, snapshot, port } = await open(t);
  remote.command(operation => confirmed(operation));
  await port.submit(approve(scope));
  remote.command(() => ({ kind: 'unavailable', reason: 'Lookup temporarily unavailable' }));
  await f.client.reconcile(scope, 'approve');
  assert.equal(JSON.parse(saved(f).commands[0].receipt).state.kind, 'accepted');
  assert.equal(saved(f).decisions[0].status, 'reserved');
  snapshot.cursor = remote.cursor(snapshot.binding); remote.emit({ kind: 'snapshot', snapshot });
  await until(() => a.calls.ack.length === 2); assert.equal(document(f).decisions.__proto__.reserved, true);
  remote.command(operation => confirmed(operation, 'completed'));
  await f.client.reconcile(scope, 'approve');
  assert.deepEqual(document(f).decisions, {});
  snapshot.cursor = remote.cursor(snapshot.binding); remote.emit({ kind: 'snapshot', snapshot });
  await until(() => a.calls.ack.length === 3);
  assert.deepEqual(document(f).decisions, {});
});

test('wrong decision, choice, scoped run and command scope refuse before backend effects; admission failure rolls back reservation', async t => {
  const { remote, f, scope, port } = await open(t);
  remote.command(operation => confirmed(operation));
  for (const value of [approve(scope, 'foreign-choice', 'not-a-choice'), command(scope, { kind: 'approve', pendingId: 'missing', choiceId: 'opaque/choice-1' }),
    command(scope, { kind: 'cancel', runId: 'unknown-run' }), approve({ ...scope, conversationId: 'foreign' })]) {
    assert.equal((await port.submit(value)).kind, 'rejected');
  }
  const before = saved(f);
  f.inspect(db => db.exec("CREATE TRIGGER fail_command BEFORE INSERT ON commands BEGIN SELECT RAISE(ABORT, 'fail'); END"));
  await assert.rejects(port.submit(approve(scope)));
  assert.deepEqual(saved(f), before);
  f.inspect(db => db.exec('DROP TRIGGER fail_command'));
  assert.equal(remote.requests.filter(value => value.path === '/submit').length, 0);
  await port.submit(approve(scope));
  assert.equal(remote.requests.filter(value => value.path === '/submit').length, 1);
});

test('browser labels submit exact IDs once, reservations disable both views after host reopen, and Stop targets the observed run', { timeout: 40_000 }, async t => {
  const remote = await providerService(t), a = remote.extension({ controls: true }), f = await fixture(t, [a]);
  const decisionGate = Promise.withResolvers(), cancelGate = Promise.withResolvers();
  remote.command(async operation => {
    if (operation.kind === 'send') return { kind: 'confirmed', value: { kind: 'send', state: 'accepted', run: remote.ref(operation.binding, 'run', 'same-run') }, evidence: null };
    if (operation.kind === 'decide') await decisionGate.promise;
    if (operation.kind === 'cancel') await cancelGate.promise;
    return confirmed(operation, operation.kind === 'cancel' ? 'completed' : 'accepted');
  });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  const [name, value] = f.cookie.split('='); await context.addCookies([{ name, value, url: f.running.origin }]);
  let page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: /Harness,/ }).click();
  await page.getByRole('button', { name: 'Provider', exact: true }).click();
  await page.getByRole('button', { name: 'Start new chat with Streaming provider', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A real provider reply');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => remote.requests.some(value => value.path === '/submit'));
  const binding = [...remote.conversations.values()][0].snapshot.binding, scope = binding.creation.scope, id = scope.conversationId;
  await until(() => remote.clients.size === 1);
  remote.emit(remote.makeEvent(binding, 'Waiting for approval', 1));
  await page.getByText('Waiting for approval', { exact: true }).waitFor();
  await prompt(remote, a, id);
  await page.getByText('Allow this provider action?', { exact: true }).waitFor();
  const choices = page.getByRole('button', { name: 'Allow once', exact: true });
  assert.equal(await choices.count(), 2);
  const other = await context.newPage(); other.setDefaultTimeout(5000); await other.goto(`${f.running.origin}/browser.html`);
  await other.getByRole('button', { name: `A real provider reply · Open conversation ${id}`, exact: true }).click();
  await other.getByText('Allow this provider action?', { exact: true }).waitFor();
  await choices.nth(1).evaluate(button => { button.click(); button.click(); });
  await until(() => remote.requests.some(value => value.path === '/submit' && value.input.kind === 'decide'));
  await other.waitForFunction(() => [...document.querySelectorAll('.decision-card button')].every(button => button.disabled));
  assert.equal(await other.getByRole('button', { name: 'Allow once', exact: true }).nth(0).isDisabled(), true);
  decisionGate.resolve();
  await until(() => saved(f, id).commands.some(row => JSON.parse(row.intent).body.kind === 'approve' && JSON.parse(row.receipt).state.kind === 'accepted'));
  const decisionRequests = remote.requests.filter(value => value.path === '/submit' && value.input.kind === 'decide');
  assert.equal(decisionRequests.length, 1); assert.equal(decisionRequests[0].input.choice.ref.opaqueId, 'opaque/choice-2');
  assert.equal(await choices.nth(0).isDisabled(), true);
  assert.equal(await choices.nth(1).isDisabled(), true);
  await page.getByRole('button', { name: 'Stop', exact: true }).evaluate(button => { button.click(); button.click(); });
  await until(() => remote.requests.some(value => value.path === '/submit' && value.input.kind === 'cancel'));
  cancelGate.resolve();
  await until(() => saved(f, id).commands.some(row => JSON.parse(row.intent).body.kind === 'cancel' && JSON.parse(row.receipt).state.kind === 'completed'));
  const stops = remote.requests.filter(value => value.path === '/submit' && value.input.kind === 'cancel');
  assert.equal(stops.length, 1); assert.deepEqual(stops[0].input.run, remote.ref(binding, 'run', 'same-run'));
  assert.equal(document(f, id).domain.currentRun.kind, 'running');
  remote.emit(remote.makeEvent(binding, 'Observed run finished', 2, true));
  await page.getByText('Observed run finished', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
  await page.close(); await other.close();
  const b = remote.extension({ controls: true }); await f.restart([b]);
  page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: `A real provider reply · Open conversation ${id}`, exact: true }).click();
  await page.getByText('Allow this provider action?', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Allow once', exact: true }).nth(1).isDisabled(), true);
  await page.screenshot({ path: '.audit/mvp/provider-approval-browser.png', fullPage: true });
  assert.equal(remote.requests.filter(value => value.path === '/submit').length, 3);
});

test('failed settlement keeps the original reservation and lookup later closes it without another submit', async t => {
  const { remote, f, scope, port } = await open(t);
  remote.command((operation, path) => {
    if (path === '/submit') f.inspect(db => db.exec("CREATE TRIGGER fail_settle BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT, 'fail'); END"));
    return confirmed(operation, 'completed');
  });
  await assert.rejects(port.submit(approve(scope)));
  const original = saved(f).commands[0].target;
  assert.equal(saved(f).decisions[0].status, 'reserved');
  assert.equal(JSON.parse(saved(f).commands[0].receipt).state.kind, 'pending');
  f.inspect(db => db.exec('DROP TRIGGER fail_settle'));
  assert.equal((await f.client.reconcile(scope, 'approve')).state.kind, 'completed');
  assert.equal(saved(f).commands[0].target, original);
  assert.equal(saved(f).decisions[0].status, 'closed');
  assert.equal(remote.requests.filter(value => value.path === '/submit').length, 1);
});

test('changed capability refuses a fresh approval before effects while original recovery ignores create and decision availability', async t => {
  const { remote, a, f, scope, port } = await open(t);
  remote.command(operation => confirmed(operation));
  a.backend.capabilities.decide = { kind: 'unsupported', reason: 'Disabled now' };
  assert.equal((await port.submit(approve(scope))).receipt.state.kind, 'not-dispatched');
  assert.equal(saved(f).decisions[0].status, 'open');
  assert.equal(remote.requests.filter(value => value.path === '/submit').length, 0);
  a.backend.capabilities.decide = { kind: 'supported' };
  await port.submit(approve(scope, 'accepted'));
  a.backend.capabilities.decide = { kind: 'unsupported', reason: 'Disabled now' };
  a.backend.capabilities.create = { kind: 'unsupported', reason: 'Disabled now' };
  a.backend.discover = async () => ({ kind: 'available', agents: [] });
  await f.client.metadata();
  remote.command(operation => confirmed(operation, 'completed'));
  assert.equal((await f.client.reconcile(scope, 'accepted')).state.kind, 'completed');
  assert.equal(saved(f).decisions[0].status, 'closed');
});

test('missing original credential or generation never replaces an unresolved decision operation', async t => {
  const { remote, f, scope, port } = await open(t);
  remote.command(() => 'lost-reply');
  await port.submit(approve(scope));
  const original = saved(f).commands[0].target;
  for (const changed of [{ generation: 'replacement' }, { revision: 'replacement' }]) {
    await f.restart([remote.extension({ controls: true, ...changed })]);
    assert.equal((await f.client.reconcile(scope, 'approve')).state.kind, 'uncertain');
    assert.equal(saved(f).commands[0].target, original);
    assert.equal(saved(f).decisions[0].status, 'reserved');
  }
  assert.equal(remote.requests.filter(value => value.path === '/lookup').length, 0);
  assert.equal(remote.requests.filter(value => value.path === '/submit').length, 1);
});

test('Stop with a lost reply retains the captured scoped run across restart and completes only its receipt', async t => {
  const { remote, a, f, scope, snapshot, port } = await open(t);
  await a.calls.receive(remote.makeEvent(snapshot.binding, 'Still running', 1));
  let original;
  remote.command((operation, path) => {
    original ??= structuredClone(operation);
    assert.deepEqual(operation, original);
    return path === '/submit' ? 'lost-reply' : confirmed(operation, 'completed');
  });
  const stop = command(scope, { kind: 'cancel', runId: 'same-run' });
  assert.equal((await port.submit(stop)).receipt.state.kind, 'uncertain');
  const target = saved(f).commands[0].target;
  await f.restart([remote.extension({ controls: true })]);
  await f.client.conversation(scope).submit(stop);
  assert.equal((await f.client.reconcile(scope, 'cancel')).state.kind, 'completed');
  assert.equal(saved(f).commands[0].target, target);
  assert.equal(document(f).domain.currentRun.kind, 'running');
  assert.equal(remote.requests.filter(value => value.path === '/submit').length, 1);
});

test('existing provider decisions publish labels and reservations from private rows without rewriting their captured mapping', async t => {
  const { remote, f, scope, port } = await open(t);
  remote.command(operation => confirmed(operation));
  await port.submit(approve(scope));
  const mapping = saved(f).decisions[0].data;
  f.inspect(db => {
    const value = JSON.parse(db.prepare('SELECT document FROM conversations').get().document);
    delete value.decisions.__proto__.choiceLabels; delete value.decisions.__proto__.reserved;
    const encoded = JSON.stringify(value);
    db.prepare('UPDATE conversations SET document=?, bytes=?').run(encoded, Buffer.byteLength(encoded));
  });
  const b = remote.extension({ controls: true }); await f.restart([b]); await until(() => b.calls.ready === 1);
  const value = await readSnapshot(f.client.conversation(scope), transcriptProjection.version);
  assert.deepEqual(value.document.decisions.__proto__.choiceLabels, { 'opaque/choice-1': 'Allow once', 'opaque/choice-2': 'Allow once' });
  assert.equal(value.document.decisions.__proto__.reserved, true);
  assert.equal(saved(f).decisions[0].data, mapping);
});
