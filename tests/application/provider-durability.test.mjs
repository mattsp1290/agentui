import { transcriptProjection } from '@agentui/contracts/conversation';
import assert from 'node:assert/strict';
import test from 'node:test';
import { providerService, fixture, saved, send } from './provider-stream-fixture.mjs';
import { until, snapshot as readSnapshot } from '../host/fixture.mjs';

const approve = (scope, id, clientCommandId = id) => ({ version: 1, scope, clientCommandId,
  body: { kind: 'approve', pendingId: id, choiceId: 'same-choice' } });
const decision = (remote, binding, id) => ({ ref: remote.ref(binding, 'decision', id),
  run: remote.ref(binding, 'run', 'same-run'), prompt: `Allow ${id}?`,
  choices: [{ ref: remote.ref(binding, 'choice', 'same-choice'), label: 'Allow once' }] });
const document = state => JSON.parse(state.conversation.document);
const fullState = (f, id = 'chat') => ({ ...saved(f, id), creation: f.inspect(db =>
  db.prepare('SELECT * FROM provider_creations WHERE host=? AND conversation=?').get(f.scope(id).hostId, id)) });
const effects = (remote, path) => remote.requests.filter(request => request.path === path);
const acknowledged = (extension, item) => extension.calls.ack.some(value =>
  JSON.stringify(value) === JSON.stringify(item));

for (const native of [false, true]) test(`${native ? 'host' : 'remote'} decision enrichment updates open material and preserves reserved commands and closed tombstones through SQLite reopen`, async t => {
  const remote = await providerService(t, { native }), a = remote.extension({ controls: true });
  const f = await fixture(t, [a]), scope = await f.create(), port = f.client.conversation(scope);
  await until(() => a.calls.ready === 1);
  const binding = remote.conversations.get('chat').snapshot.binding;
  remote.command((operation, path) => ({ kind: 'confirmed', value: { kind: 'decide',
    state: path === '/lookup' || operation.decision.ref.opaqueId === 'closed' ? 'completed' : 'accepted' }, evidence: null }));
  const snapshot = structuredClone(remote.conversations.get('chat').snapshot);
  snapshot.cursor = remote.cursor(binding);
  snapshot.decisions = ['open', 'reserved', 'closed'].map(id => decision(remote, binding, id));
  const first = remote.emit({ kind: 'snapshot', snapshot }); await until(() => acknowledged(a, first));
  assert.equal((await port.submit(approve(scope, 'reserved'))).receipt.state.kind, 'accepted');
  assert.equal((await port.submit(approve(scope, 'closed'))).receipt.state.kind, 'completed');
  const before = fullState(f), captured = effects(remote, '/submit').find(value => value.input.decision.ref.opaqueId === 'reserved').input;
  snapshot.cursor = remote.cursor(binding);
  snapshot.decisions = snapshot.decisions.map(pending => ({ ...pending, prompt: 'record_work_item\nComplete owner note',
    choices: [{ ref: remote.ref(binding, 'choice', 'new-choice'), label: 'New material' }] }));
  const enriched = remote.emit({ kind: 'snapshot', snapshot }); await until(() => acknowledged(a, enriched));
  function assertRetained() {
    const state = fullState(f), doc = document(state);
    assert.deepEqual(state.commands, before.commands);
    assert.deepEqual(doc.receipts, document(before).receipts);
    for (const id of ['reserved', 'closed']) assert.deepEqual(state.decisions.find(row => row.id === id), before.decisions.find(row => row.id === id));
    assert.deepEqual(doc.decisions.reserved, document(before).decisions.reserved);
    assert.equal(doc.decisions.reserved.reserved, true);
    assert.equal(Object.hasOwn(doc.decisions, 'closed'), false);
    assert.equal(doc.decisions.open.prompt, 'record_work_item\nComplete owner note');
    assert.deepEqual(doc.decisions.open.choices, ['new-choice']);
  }
  assertRetained();
  const b = remote.extension({ controls: true }); await f.restart([b]); await until(() => b.calls.ready === 1);
  snapshot.cursor = remote.cursor(binding);
  const replay = remote.emit({ kind: 'snapshot', snapshot }); await until(() => acknowledged(b, replay));
  assertRetained();
  for (const changed of ['run', 'reference']) {
    const invalid = structuredClone(snapshot); invalid.cursor = remote.cursor(binding);
    if (changed === 'run') invalid.decisions[1].run = remote.ref(binding, 'run', 'different-run');
    else invalid.decisions[1].ref.binding.authority.binding.opaqueSessionId = 'different-conversation';
    const stored = fullState(f);
    await assert.rejects(b.calls.receive({ kind: 'snapshot', snapshot: invalid }));
    assert.deepEqual(fullState(f), stored);
  }
  assert.equal((await f.client.reconcile(scope, 'reserved')).state.kind, 'completed');
  assert.deepEqual(effects(remote, '/lookup').at(-1).input, captured);
  assert.equal(effects(remote, '/submit').length, 2);
});

for (const native of [false, true]) test(`${native ? 'host' : 'remote'} authority commits before lost connector acknowledgement and deduplicates exact HTTP replay`, { timeout: 15_000 }, async t => {
  const remote = await providerService(t, { native }), boundary = Promise.withResolvers();
  const lostAcknowledgement = new Error('Lost connector acknowledgement after durable acceptance');
  let f, injected = false, applications = 0;
  const a = remote.extension({ controls: true, mutate(presentation) {
    const apply = presentation.apply;
    presentation.apply = (...args) => { applications++; return apply(...args); };
  } });
  const observe = a.backend.observe;
  a.backend.observe = (input, receive) => observe(input, async item => {
    await receive(item);
    if (!injected && item.kind === 'event' && item.eventId === 'event-1' && input.binding.creation.scope.conversationId === 'chat') {
      injected = true;
      boundary.resolve({ item: structuredClone(item), persisted: fullState(f) });
      throw lostAcknowledgement;
    }
  });
  f = await fixture(t, [a]);
  const scope = await f.create(), port = f.client.conversation(scope), other = await f.create('other');
  await until(() => a.calls.ready === 2);
  const binding = remote.conversations.get('chat').snapshot.binding;
  assert.equal((await port.submit(send(scope))).receipt.state.kind, 'accepted');
  assert.equal((await f.client.conversation(other).submit(send(other))).receipt.state.kind, 'accepted');
  const siblingEvent = remote.emit(remote.makeEvent(remote.conversations.get('other').snapshot.binding, 'Sibling durable answer', 1));
  await until(() => acknowledged(a, siblingEvent));
  const sibling = fullState(f, 'other');
  const prompt = structuredClone(remote.conversations.get('chat').snapshot);
  prompt.cursor = remote.cursor(binding); prompt.decisions = [decision(remote, binding, 'decision-a')];
  const promptItem = remote.emit({ kind: 'snapshot', snapshot: prompt });
  await until(() => acknowledged(a, promptItem));
  const before = fullState(f), event = remote.emit(remote.makeEvent(binding, 'Durable before acknowledgement', 1));
  const committed = await boundary.promise, state = committed.persisted, checkpoint = JSON.parse(state.checkpoint.data);
  await until(() => a.calls.failures.includes(lostAcknowledgement));
  assert.equal(acknowledged(a, event), false);
  assert.deepEqual(committed.item, event);
  assert.equal(state.creation.status, 'observed');
  assert.deepEqual(JSON.parse(state.creation.observation).binding, binding);
  assert.equal(state.checkpoint.original, state.creation.original);
  const original = JSON.parse(state.creation.original);
  assert.deepEqual(original.intent, binding.creation);
  assert.deepEqual(original.credential, a.calls.connected[0].credential);
  assert.deepEqual(original.installation, JSON.parse(state.conversation.installation));
  assert.deepEqual(checkpoint.cursor, event.cursor);
  assert.equal(checkpoint.projectionVersion, 1);
  assert.equal(checkpoint.revision, JSON.parse(before.checkpoint.data).revision + 1);
  assert.equal(checkpoint.state.transcript.messages.at(-1).text, 'Durable before acknowledgement');
  assert.deepEqual(checkpoint.state.run, event.event.run);
  assert.equal(state.ids.length, 1); assert.equal(state.ids[0].id, 'event-1');
  assert.deepEqual(JSON.parse(state.ids[0].payload), event);
  assert.equal(document(state).domain.messages.at(-1).text, 'Durable before acknowledgement');
  assert.equal(document(state).domain.messages.at(-1).complete, false);
  assert.equal(state.runs.length, 1);
  assert.deepEqual(JSON.parse(state.runs[0].data).identity, { conversation: scope, runId: 'same-run', authority: binding.authority });
  assert.deepEqual(JSON.parse(state.runs[0].data).reference, event.event.run);
  assert.deepEqual(state.decisions, before.decisions);
  assert.equal(state.decisions[0].status, 'open');
  assert.deepEqual(JSON.parse(state.decisions[0].data).reference, prompt.decisions[0].ref);
  assert.deepEqual(JSON.parse(state.decisions[0].data).choices[0].reference, prompt.decisions[0].choices[0].ref);
  assert.deepEqual(document(state).decisions, document(before).decisions);
  assert.deepEqual(state.commands, before.commands);
  assert.deepEqual(document(state).receipts.send, JSON.parse(state.commands[0].receipt));
  assert.equal(document(state).receipts.send.state.kind, 'accepted');
  assert.deepEqual(JSON.parse(state.commands[0].target).operation, effects(remote, '/submit')[0].input);
  assert.equal(applications, 2);

  const b = remote.extension({ controls: true, mutate(presentation) {
    const apply = presentation.apply;
    presentation.apply = (...args) => { applications++; return apply(...args); };
  } });
  await f.restart([b]); await until(() => b.calls.ready === 2);
  assert.deepEqual(b.calls.observe.find(value => value.binding.creation.scope.conversationId === 'chat'), { binding, after: event.cursor });
  assert.deepEqual(b.calls.connected[0].credential, a.calls.connected[0].credential);
  assert.deepEqual(fullState(f), state);
  remote.emit(event, false); await until(() => acknowledged(b, event));
  assert.deepEqual(fullState(f), state); assert.equal(applications, 2);
  assert.deepEqual(fullState(f, 'other'), sibling);
  assert.deepEqual((await readSnapshot(f.client.conversation(scope), transcriptProjection.version)).document, document(state));
  assert.deepEqual(await f.client.conversation(scope).receipt('send'), document(state).receipts.send);
  assert.equal(effects(remote, '/create').length, 2); assert.equal(effects(remote, '/submit').length, 2);
  assert.equal(effects(remote, '/lookup').length, 0); assert.equal(effects(remote, '/snapshot').length, 2);
  const next = remote.emit(remote.makeEvent(binding, 'Continued after replay', 2, true));
  await until(() => acknowledged(b, next));
  assert.equal(applications, 3);
  assert.equal(document(fullState(f)).domain.messages.at(-1).text, 'Continued after replay');
  assert.equal(document(fullState(f)).domain.currentRun.outcome, 'completed');
  assert.deepEqual(fullState(f, 'other'), sibling);
});

async function settledReplacement(f, values) {
  for (let attempt = 0; ; attempt++) {
    const result = await f.running.replaceProviderExtensions(values);
    if (result.kind !== 'deferred' || result.reason !== 'active-work' || attempt === 200) return result;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
for (const native of [false, true]) test(`${native ? 'host' : 'remote'} authority isolates colliding scopes through decisions, provider resync, restart and disable`, { timeout: 15_000 }, async t => {
  const remote = await providerService(t, { native }), a = remote.extension({ controls: true });
  const retained = new Map(), endings = new Map(), observe = a.backend.observe;
  a.backend.observe = (input, receive) => {
    const id = input.binding.creation.scope.conversationId, end = Promise.withResolvers();
    if (!retained.has(id)) retained.set(id, receive);
    const feed = observe(input, receive);
    endings.set(id, () => {
      end.resolve({ kind: 'resync', cursor: null, reason: 'Provider history expired' });
      feed.close();
    });
    return { close: feed.close, ended: Promise.race([end.promise, feed.ended]) };
  };
  const f = await fixture(t, [a]), records = [];
  for (const id of ['chat', 'other']) {
    const scope = await f.create(id), binding = remote.conversations.get(id).snapshot.binding;
    records.push({ id, scope, binding, port: f.client.conversation(scope), reserved: id === 'chat' ? 'decision-a' : 'decision-b', operations: new Map() });
  }
  await until(() => a.calls.ready === 2);
  remote.command((operation, path) => {
    const record = records.find(record => record.id === operation.binding.creation.scope.conversationId);
    if (operation.kind === 'send') return { kind: 'confirmed', value: { kind: 'send', state: 'accepted', run: remote.ref(operation.binding, 'run', 'same-run') }, evidence: null };
    if (path === '/submit') record.operations.set(operation.decision.ref.opaqueId, structuredClone(operation));
    return { kind: 'confirmed', value: { kind: 'decide', state: path === '/lookup' || operation.decision.ref.opaqueId !== record.reserved ? 'completed' : 'accepted' }, evidence: { operation: operation.operationId } };
  });
  for (const record of records) {
    const { id, scope, port, binding } = record;
    assert.equal((await port.submit(send(scope))).receipt.state.kind, 'accepted');
    const first = remote.emit(remote.makeEvent(binding, `${id} initial answer`, 1));
    await until(() => acknowledged(a, first));
    const snapshot = structuredClone(remote.conversations.get(id).snapshot);
    snapshot.cursor = remote.cursor(binding);
    snapshot.decisions = ['decision-a', 'decision-b'].map(id => decision(remote, binding, id));
    record.originalDecisions = structuredClone(snapshot.decisions);
    const item = remote.emit({ kind: 'snapshot', snapshot }); await until(() => acknowledged(a, item));
    for (const pendingId of ['decision-a', 'decision-b']) {
      assert.equal((await port.submit(approve(scope, pendingId))).receipt.state.kind, pendingId === record.reserved ? 'accepted' : 'completed');
    }
    const state = fullState(f, id), doc = document(state);
    assert.equal(state.runs.length, 1); assert.equal(state.ids.length, 1);
    assert.deepEqual(doc.receipts.send, JSON.parse(state.commands.find(command => command.id === 'send').receipt));
    assert.deepEqual(effects(remote, '/submit').find(value => value.input.kind === 'send' && value.input.binding.creation.scope.conversationId === id).input.binding, binding);
    assert.deepEqual(effects(remote, '/create').find(value => value.input.scope.conversationId === id).input, binding.creation);
    assert.deepEqual(JSON.parse(state.runs[0].data).identity, { conversation: scope, runId: 'same-run', authority: binding.authority });
    assert.deepEqual(JSON.parse(state.ids[0].payload), first);
    assert.equal(doc.domain.messages.at(-1).text, `${id} initial answer`);
    for (const row of state.decisions) {
      const operation = record.operations.get(row.id), command = state.commands.find(command => command.id === row.id);
      assert.deepEqual(JSON.parse(command.target).operation, { ...operation, run: remote.ref(binding, 'run', 'same-run') });
      assert.deepEqual(operation.binding, binding);
      assert.deepEqual(operation.decision, record.originalDecisions.find(value => value.ref.ref.opaqueId === row.id).ref);
      assert.deepEqual(operation.choice, remote.ref(binding, 'choice', 'same-choice'));
      assert.deepEqual(JSON.parse(command.target).operation.run, remote.ref(binding, 'run', 'same-run'));
      assert.equal(row.status, row.id === record.reserved ? 'reserved' : 'closed');
      assert.equal(row.operation, row.id === record.reserved ? operation.operationId : null);
      assert.deepEqual(doc.receipts[row.id], JSON.parse(command.receipt));
    }
    assert.equal((await port.submit(approve(scope, record.reserved, 'competing'))).reason, 'decision-unavailable');
    record.before = fullState(f, id); record.items = [];
    record.feed = port.watch({ after: record.before.conversation.head, projectionVersion: 4 }, async item => { record.items.push(item); });
    t.after(() => record.feed.close());
    await until(() => record.items.length === 1);
    assert.deepEqual(record.items[0], { kind: 'events', events: [] });
  }
  assert.equal(effects(remote, '/create').length, 2); assert.equal(effects(remote, '/submit').length, 6);
  for (const id of ['decision-a', 'decision-b']) assert.notEqual(records[0].operations.get(id).operationId, records[1].operations.get(id).operationId);
  for (const record of records) {
    const sibling = records.find(value => value !== record), untouched = fullState(f, sibling.id);
    const snapshot = structuredClone(remote.conversations.get(record.id).snapshot);
    snapshot.cursor = remote.cursor(record.binding);
    snapshot.state.transcript.messages = [{ messageId: 'replacement', revision: 1, role: 'assistant', text: `${record.id} replacement answer`, complete: true }];
    snapshot.decisions = record.originalDecisions.filter(value => value.ref.ref.opaqueId !== record.reserved);
    remote.conversations.get(record.id).snapshot = snapshot;
    endings.get(record.id)();
    await until(() => JSON.parse(saved(f, record.id).checkpoint.data).cursor.opaque.token === snapshot.cursor.opaque.token);
    await until(() => record.items.some(item => item.kind === 'snapshot'));
    assert.deepEqual(fullState(f, sibling.id), untouched);
    const state = fullState(f, record.id), replacement = record.items.find(item => item.kind === 'snapshot').snapshot.document;
    assert.equal(replacement.domain.messages[0].text, `${record.id} replacement answer`);
    assert.deepEqual(replacement.receipts, document(record.before).receipts); assert.deepEqual(replacement.decisions, {});
    assert.deepEqual(state.commands, record.before.commands); assert.deepEqual(state.runs, record.before.runs);
    assert.deepEqual(state.decisions, record.before.decisions);
    record.replaced = state; record.feed.close();
  }
  await until(() => a.calls.ready === 4);
  assert.equal(effects(remote, '/snapshot').length, 4);
  const b = remote.extension({ controls: true }), resumed = new Map(), nextObserve = b.backend.observe;
  b.backend.observe = (input, receive) => { resumed.set(input.binding.creation.scope.conversationId, receive); return nextObserve(input, receive); };
  await f.restart([b]); await until(() => b.calls.ready === 2);
  for (const record of records) {
    assert.deepEqual(fullState(f, record.id), record.replaced);
    assert.deepEqual(b.calls.observe.find(value => value.binding.creation.scope.conversationId === record.id),
      { binding: record.binding, after: JSON.parse(record.replaced.checkpoint.data).cursor });
    const items = [], feed = record.port.watch({ after: record.before.conversation.head, projectionVersion: 4 }, async item => { items.push(item); });
    t.after(() => feed.close()); await until(() => items.length > 0); feed.close();
    assert.equal(items[0].kind, 'snapshot'); assert.deepEqual(items[0].snapshot.document, document(record.replaced));
    const snapshot = structuredClone(remote.conversations.get(record.id).snapshot);
    snapshot.cursor = remote.cursor(record.binding); snapshot.decisions = record.originalDecisions;
    const item = remote.emit({ kind: 'snapshot', snapshot }); await until(() => acknowledged(b, item));
    const state = fullState(f, record.id);
    assert.deepEqual(state.commands, record.before.commands); assert.deepEqual(state.decisions, record.before.decisions);
    assert.deepEqual(Object.keys(document(state).decisions), [record.reserved]);
    assert.equal(document(state).decisions[record.reserved].reserved, true);
    for (const id of ['decision-a', 'decision-b']) {
      assert.deepEqual(await record.port.submit(approve(record.scope, id)), { kind: 'receipt', receipt: document(state).receipts[id] });
    }
  }
  for (const record of records) {
    const other = records.find(value => value !== record), untouched = fullState(f, other.id);
    assert.equal((await f.client.reconcile(record.scope, record.reserved)).state.kind, 'completed');
    assert.deepEqual(effects(remote, '/lookup').at(-1).input, record.operations.get(record.reserved));
    assert.deepEqual(fullState(f, other.id), untouched);
    const state = fullState(f, record.id), row = state.decisions.find(value => value.id === record.reserved);
    assert.equal(row.status, 'closed'); assert.equal(row.operation, null);
    assert.deepEqual(document(state).decisions, {});
    for (const command of state.commands) {
      assert.equal(command.target, record.before.commands.find(value => value.id === command.id).target);
      assert.deepEqual(document(state).receipts[command.id], JSON.parse(command.receipt));
    }
    record.finalEvent = remote.emit(remote.makeEvent(record.binding, `${record.id} final answer`, 2, true));
    await until(() => acknowledged(b, record.finalEvent));
    await until(() => JSON.parse(fullState(f, record.id).commands.find(command => command.id === 'send').observation).evidence.source.source === 'provider-lookup');
    record.final = fullState(f, record.id);
    assert.equal(document(record.final).domain.messages.at(-1).text, `${record.id} final answer`);
    assert.equal(document(record.final).domain.currentRun.outcome, 'completed');
  }
  assert.equal((await settledReplacement(f, [])).kind, 'replaced');
  assert.equal(b.calls.feedClosed, 2); await until(() => remote.clients.size === 0);
  for (const record of records) {
    assert.equal((await record.port.submit(send(record.scope, 'disabled-send'))).kind, 'rejected');
    assert.deepEqual((await readSnapshot(record.port, transcriptProjection.version)).document, document(record.final));
    await assert.rejects(resumed.get(record.id)(remote.makeEvent(record.binding, 'Retired callback', 3)));
    await assert.rejects(retained.get(record.id)(remote.makeEvent(record.binding, 'Original retired callback', 3)));
    assert.deepEqual(fullState(f, record.id), record.final);
  }
  const c = remote.extension({ controls: true });
  assert.equal((await f.running.replaceProviderExtensions([c.value])).kind, 'replaced');
  await until(() => c.calls.ready === 2);
  for (const record of records) {
    assert.deepEqual(c.calls.observe.find(value => value.binding.creation.scope.conversationId === record.id),
      { binding: record.binding, after: record.finalEvent.cursor });
    remote.emit(record.finalEvent, false); await until(() => acknowledged(c, record.finalEvent));
    assert.deepEqual(fullState(f, record.id), record.final);
  }
  assert.equal(effects(remote, '/create').length, 2); assert.equal(effects(remote, '/submit').length, 6);
  assert.equal(effects(remote, '/lookup').filter(value => value.input.kind !== 'send').length, 2);
  assert.equal(effects(remote, '/lookup').filter(value => value.input.kind === 'send').length, 2);
  assert.equal(effects(remote, '/submit').some(value => value.input.kind === 'cancel'), false);
});
