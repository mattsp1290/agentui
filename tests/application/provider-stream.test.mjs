import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { SqliteStore } from '../../packages/host/dist/sqlite-store.js';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { join } from 'node:path';
import { providerService, fixture, saved, send } from './provider-stream-fixture.mjs';
import { until } from '../host/fixture.mjs';

for (const native of [false, true]) test(`actual ${native ? 'host' : 'remote'} authority HTTP response grows, completes, and resumes its committed cursor`, async t => {
  const remote = await providerService(t, { native });
  let f;
  const a = remote.extension({ onAck(item) {
    const persisted = saved(f), checkpoint = JSON.parse(persisted.checkpoint.data);
    assert.deepEqual(checkpoint.cursor, item.cursor);
    assert.equal(persisted.ids.length, a.calls.ack.length);
  } });
  f = await fixture(t, [a]); const scope = await f.create(), binding = remote.conversations.get('chat').snapshot.binding;
  await until(() => remote.clients.size === 1);
  const port = f.client.conversation(scope), items = [];
  const feed = port.watch({ after: null, projectionVersion: 2 }, async item => { items.push(item); });
  t.after(() => feed.close());
  assert.equal((await port.submit(send(scope))).receipt.state.kind, 'accepted');
  remote.emit(remote.makeEvent(binding, 'A growing', 1));
  await until(() => a.calls.ack.length === 1);
  const first = saved(f); assert.equal(JSON.parse(first.conversation.document).domain.messages.at(-1).complete, false);
  remote.emit(remote.makeEvent(binding, 'A growing provider reply', 2, true));
  await until(() => a.calls.ack.length === 2);
  await until(() => items.some(item => item.kind === 'events' && item.events.some(envelope => envelope.event.event?.kind === 'run-ended')));
  const final = saved(f), document = JSON.parse(final.conversation.document);
  assert.equal(document.domain.messages.at(-1).text, 'A growing provider reply');
  assert.equal(document.domain.currentRun.outcome, 'completed');
  assert.equal(document.receipts.send.state.kind, 'accepted');
  assert.equal(final.runs.length, 1);
  assert.equal(JSON.parse(final.runs[0].data).identity.authority.kind, native ? 'agentui-host' : 'remote-provider');
  feed.close();
  const b = remote.extension(); await f.restart([b]); await until(() => b.calls.ready === 1);
  assert.deepEqual(saved(f), final);
  assert.deepEqual(b.calls.observe[0].after, JSON.parse(final.checkpoint.data).cursor);
  assert.deepEqual(b.calls.observe[0].binding, a.calls.observe[0].binding);
  assert.deepEqual(b.calls.connected[0].credential, a.calls.connected[0].credential);
  assert.equal(remote.requests.filter(value => value.path === '/snapshot').length, 1);
  const duplicate = remote.conversations.get('chat').history[0];
  remote.emit(duplicate, false); await until(() => b.calls.ack.length === 1);
  assert.deepEqual(saved(f), final);
  remote.emit({ ...duplicate, event: { ...duplicate.event, text: 'Changed duplicate' } }, false);
  await until(() => b.calls.failures.length === 1);
  assert.deepEqual(saved(f), final);
});

test('stream may establish a scoped run before send acceptance and independently in another conversation', async t => {
  const remote = await providerService(t); remote.beforeReply();
  let f;
  const a = remote.extension({ onAck(item) {
    if (item.cursor.binding.creation.scope.conversationId === 'chat') {
      assert.equal(JSON.parse(saved(f).commands[0].receipt).state.kind, 'pending');
      assert.equal(saved(f).runs.length, 1);
    }
  } });
  f = await fixture(t, [a]); const scope = await f.create();
  await until(() => remote.clients.size === 1);
  await f.client.conversation(scope).submit(send(scope));
  await until(() => a.calls.ack.length === 1);
  const other = await f.create('other'); await until(() => remote.clients.size === 2);
  const binding = remote.conversations.get('other').snapshot.binding;
  remote.emit(remote.makeEvent(binding, 'Independent run', 1)); await until(() => a.calls.ack.length === 2);
  assert.equal(saved(f, 'other').commands.length, 0);
  assert.equal(saved(f).runs.length, 1); assert.equal(saved(f, 'other').runs.length, 1);
  assert.deepEqual(JSON.parse(saved(f, 'other').runs[0].data).identity.conversation, other);
});

test('authoritative replacement reaches an active reader and preserves receipts, run maps, and reserved decisions', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]), scope = await f.create();
  const binding = remote.conversations.get('chat').snapshot.binding;
  await until(() => remote.clients.size === 1);
  await f.client.conversation(scope).submit(send(scope));
  remote.emit(remote.makeEvent(binding, 'Immutable completed answer', 1, true)); await until(() => a.calls.ack.length === 1);
  const items = [], before = saved(f);
  const feed = f.client.conversation(scope).watch({ after: before.conversation.head, projectionVersion: 2 }, async item => { items.push(item); });
  t.after(() => feed.close()); await until(() => items.length === 1);
  const snapshot = structuredClone(remote.conversations.get('chat').snapshot);
  snapshot.cursor = remote.cursor(binding);
  snapshot.state.transcript.messages = [{ messageId: 'replacement', revision: 1, role: 'assistant', text: 'Authoritative replacement', complete: true }];
  snapshot.decisions = [{ ref: remote.ref(binding, 'decision', 'decision'), run: remote.ref(binding, 'run', 'same-run'), prompt: 'Continue?',
    choices: [{ ref: remote.ref(binding, 'choice', 'yes'), label: 'Continue safely' }] }];
  remote.emit({ kind: 'snapshot', snapshot }); await until(() => a.calls.ack.length === 2);
  await until(() => items.some(item => item.kind === 'snapshot'));
  const replacement = items.find(item => item.kind === 'snapshot');
  assert.equal(replacement.snapshot.document.domain.messages[0].text, 'Authoritative replacement');
  assert.deepEqual(replacement.snapshot.document.receipts, JSON.parse(before.conversation.document).receipts);
  const row = saved(f).decisions[0], decision = JSON.parse(row.data);
  assert.equal(decision.kind, 'provider'); assert.equal(decision.choices[0].label, 'Continue safely');
  assert.deepEqual(decision.choices[0].reference, snapshot.decisions[0].choices[0].ref);
  f.inspect(db => db.prepare("UPDATE pending_decisions SET status='reserved', operation='reserved-operation' WHERE id='decision'").run());
  snapshot.cursor = remote.cursor(binding); snapshot.decisions = [];
  remote.emit({ kind: 'snapshot', snapshot }); await until(() => a.calls.ack.length === 3);
  assert.equal(saved(f).decisions[0].status, 'reserved'); assert.equal(saved(f).decisions[0].operation, 'reserved-operation');
  assert.deepEqual(saved(f).commands, before.commands); assert.deepEqual(saved(f).runs, before.runs);
  assert.deepEqual(JSON.parse(saved(f).conversation.document).decisions, {});
  snapshot.cursor = remote.cursor(binding); snapshot.decisions = [{ ...remote.conversations.get('chat').history[1].snapshot.decisions[0], prompt: 'Changed reserved question' }];
  const preserved = saved(f); remote.emit({ kind: 'snapshot', snapshot }, false);
  await until(() => a.calls.failures.length === 1); assert.deepEqual(saved(f), preserved);
});

for (const failure of ['presentation', 'capacity', 'foreign-run', 'foreign-cursor', 'transaction']) {
  test(`${failure} rolls back provider state, cursor, dedup and transcript`, async t => {
    const remote = await providerService(t), a = remote.extension({ mutate(presentation) {
      if (failure === 'presentation') presentation.apply = () => ({ state: { run: null, transcript: { messages: [], currentRun: null } }, events: [{ kind: 'invalid' }] });
    } });
    const f = await fixture(t, [a]); await f.create(); await until(() => remote.clients.size === 1);
    const binding = remote.conversations.get('chat').snapshot.binding, before = saved(f);
    const item = remote.makeEvent(binding, failure === 'capacity' ? 'x'.repeat(70_000) : 'New text', 1);
    if (failure === 'foreign-run') item.event.run.ref.instance = { ...item.event.run.ref.instance, generation: 'foreign' };
    if (failure === 'foreign-cursor') item.cursor.binding = { ...binding, authority: { ...binding.authority, binding: { ...binding.authority.binding, opaqueSessionId: 'foreign' } } };
    if (failure === 'transaction') f.inspect(db => db.exec("CREATE TRIGGER fail_checkpoint BEFORE UPDATE ON provider_checkpoints BEGIN SELECT RAISE(ABORT, 'fail'); END"));
    remote.emit(item, false); await until(() => a.calls.failures.length === 1);
    assert.equal(a.calls.ack.length, 0); assert.deepEqual(saved(f), before);
  });
}

test('missing generation and changed credentials leave saved history readable without observation or rebind', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]), scope = await f.create();
  await until(() => remote.clients.size === 1);
  remote.emit(remote.makeEvent(remote.conversations.get('chat').snapshot.binding, 'Saved output', 1));
  await until(() => a.calls.ack.length === 1); const before = saved(f);
  for (const options of [{ generation: 'replacement' }, { revision: 'replacement' }]) {
    const b = remote.extension(options); await f.restart([b]);
    assert.equal(b.calls.observe.length, 0); assert.deepEqual(saved(f), before);
    const items = [], feed = f.client.conversation(scope).watch({ after: null, projectionVersion: 2 }, async item => { items.push(item); });
    await until(() => items.length === 1); feed.close();
    assert.equal(items[0].snapshot.document.domain.messages.at(-1).text, 'Saved output');
  }
});

test('real browser selection and send render a growing reply, completion, and persisted history after host/client reopen', { timeout: 30_000 }, async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  const [name, value] = f.cookie.split('='); await context.addCookies([{ name, value, url: f.running.origin }]);
  let page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: /Harness,/ }).click();
  await page.getByRole('button', { name: 'Provider', exact: true }).click();
  await page.getByRole('button', { name: 'Start new chat with Streaming provider', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  assert.doesNotMatch(await page.locator('.composer-footer').textContent(), /not available|later update/);
  assert.equal(await page.getByRole('textbox', { name: 'Message', exact: true }).getAttribute('placeholder'), 'Write to your provider…');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A real provider reply');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => remote.requests.some(value => value.path === '/submit'));
  const binding = [...remote.conversations.values()][0].snapshot.binding;
  await until(() => remote.clients.size === 1);
  remote.emit(remote.makeEvent(binding, 'A visible growing', 1));
  await page.getByLabel('Messages').getByText('A visible growing', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Follow-up while responding');
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Harness, Provider', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).isDisabled(), true);
  assert.equal(JSON.parse(saved(f, binding.creation.scope.conversationId).conversation.document).domain.messages.at(-1).complete, false);
  remote.emit(remote.makeEvent(binding, 'A visible growing provider reply, completed.', 2, true));
  await page.getByLabel('Messages').getByText('A visible growing provider reply, completed.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Harness, Provider', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
  assert.equal(JSON.parse(saved(f, binding.creation.scope.conversationId).conversation.document).domain.currentRun.outcome, 'completed');
  await page.close(); const b = remote.extension(); await f.restart([b]);
  page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: `A real provider reply · Open conversation ${binding.creation.scope.conversationId}`, exact: true }).click();
  await page.getByLabel('Messages').getByText('A visible growing provider reply, completed.', { exact: true }).waitFor();
  assert.equal(b.calls.observe.length, 1);
  assert.equal(remote.requests.filter(value => value.path === '/submit').length, 1);
});


test('concurrent provider callbacks serialize against the last committed state; browser watches share one upstream feed', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]), scope = await f.create();
  const readers = Array.from({ length: 3 }, () => f.client.conversation(scope).watch({ after: null, projectionVersion: 2 }, async () => {}));
  t.after(() => readers.forEach(reader => reader.close()));
  const binding = remote.conversations.get('chat').snapshot.binding;
  await Promise.all([a.calls.receive(remote.makeEvent(binding, 'First', 1)), a.calls.receive(remote.makeEvent(binding, 'Second', 2))]);
  const stored = saved(f);
  assert.equal(JSON.parse(stored.conversation.document).domain.messages.at(-1).text, 'Second');
  assert.equal(JSON.parse(stored.checkpoint.data).revision, 3);
  assert.equal(stored.ids.length, 2); assert.equal(a.calls.observe.length, 1);
  readers.forEach(reader => reader.close());
  await a.calls.receive(remote.makeEvent(binding, 'Without any browser watchers', 3));
  assert.equal(JSON.parse(saved(f).conversation.document).domain.messages.at(-1).text, 'Without any browser watchers');
});

test('a competing checkpoint writer cannot be overwritten by a callback with an older expected revision', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]); await f.create();
  const original = f.inspect(db => JSON.parse(db.prepare('SELECT original FROM provider_creations').get().original));
  const limits = f.inspect(db => JSON.parse(db.prepare('SELECT value FROM host_limits').get().value));
  const second = new SqliteStore(join(f.directory, 'host.sqlite'), transcriptProjection, limits); t.after(() => second.close());
  const checkpoint = second.providerCheckpoint(original);
  second.commitProvider(original, checkpoint.revision, null, () => ({ checkpoint,
    runs: [], output: { kind: 'snapshot', transcript: transcriptProjection.initial(), decisions: [] } }));
  const before = saved(f), binding = remote.conversations.get('chat').snapshot.binding;
  await assert.rejects(a.calls.receive(remote.makeEvent(binding, 'Stale overwrite', 1)), /checkpoint advanced/);
  assert.deepEqual(saved(f), before);
});

test('shutdown drains an admitted callback and prevents callback writes after the backend and database close', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]); await f.create();
  const binding = remote.conversations.get('chat').snapshot.binding;
  let acknowledged = false;
  const callback = a.calls.receive(remote.makeEvent(binding, 'Queued before shutdown', 1)).then(() => { acknowledged = true; });
  const closeBackend = a.backend.close;
  a.backend.close = async () => { assert.equal(acknowledged, true); await closeBackend(); };
  await f.running.close(); await callback;
  const before = saved(f);
  assert.equal(JSON.parse(before.conversation.document).domain.messages.at(-1).text, 'Queued before shutdown');
  assert.equal(a.calls.closed, 1); assert.equal(a.calls.disposed, 1);
  assert.deepEqual(saved(f), before);
  await assert.rejects(a.calls.receive(remote.makeEvent(binding, 'After shutdown', 2)), /stream closed/);
  assert.deepEqual(saved(f), before);
});

test('bounded provider model rejects valid transcript events without advancing any durable state', async t => {
  const remote = await providerService(t), a = remote.extension({ mutate(presentation) {
    const apply = presentation.apply;
    presentation.apply = (...args) => { const result = apply(...args); return { ...result, state: { ...result.state, padding: 'x'.repeat(1_100_000) } }; };
  } }), f = await fixture(t, [a]); await f.create();
  const before = saved(f), binding = remote.conversations.get('chat').snapshot.binding;
  await assert.rejects(a.calls.receive(remote.makeEvent(binding, 'Valid small output', 1)), /observation exceeds limit/);
  assert.deepEqual(saved(f), before);
});

test('open decisions update authoritatively while closed decisions stay closed and foreign choices roll back', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]); await f.create();
  const binding = remote.conversations.get('chat').snapshot.binding;
  const snapshot = structuredClone(remote.conversations.get('chat').snapshot);
  snapshot.decisions = [{ ref: remote.ref(binding, 'decision', '__proto__'), run: remote.ref(binding, 'run', 'same-run'), prompt: 'First prompt',
    choices: [{ ref: remote.ref(binding, 'choice', 'yes'), label: 'First label' }] }];
  snapshot.cursor = remote.cursor(binding); await a.calls.receive({ kind: 'snapshot', snapshot });
  assert.equal(JSON.parse(saved(f).conversation.document).decisions.__proto__.prompt, 'First prompt');
  snapshot.decisions[0].prompt = 'Updated prompt'; snapshot.decisions[0].choices[0].label = 'Updated label';
  snapshot.cursor = remote.cursor(binding); await a.calls.receive({ kind: 'snapshot', snapshot });
  assert.equal(JSON.parse(saved(f).decisions[0].data).choices[0].label, 'Updated label');
  const decisions = structuredClone(snapshot.decisions);
  snapshot.decisions = []; snapshot.cursor = remote.cursor(binding); await a.calls.receive({ kind: 'snapshot', snapshot });
  assert.equal(saved(f).decisions[0].status, 'closed');
  snapshot.decisions = decisions; snapshot.cursor = remote.cursor(binding); await a.calls.receive({ kind: 'snapshot', snapshot });
  assert.equal(saved(f).decisions[0].status, 'closed');
  assert.deepEqual(JSON.parse(saved(f).conversation.document).decisions, {});
  const before = saved(f);
  snapshot.decisions[0].choices[0].ref.binding.creation.scope.conversationId = 'foreign';
  await assert.rejects(a.calls.receive({ kind: 'snapshot', snapshot }), /Foreign/);
  assert.deepEqual(saved(f), before);
});


test('a changed state decoder cannot mutate a saved checkpoint when reopening', async t => {
  const remote = await providerService(t), a = remote.extension(), f = await fixture(t, [a]); await f.create();
  const binding = remote.conversations.get('chat').snapshot.binding;
  await a.calls.receive(remote.makeEvent(binding, 'Saved original', 1));
  const before = saved(f), b = remote.extension({ mutate(presentation) {
    const decode = presentation.decodeState;
    presentation.decodeState = value => { value.transcript.messages[0].text = 'Mutated by decoder'; return decode(value); };
  } });
  await f.restart([b]);
  assert.equal(b.calls.observe.length, 0); assert.deepEqual(saved(f), before);
});
