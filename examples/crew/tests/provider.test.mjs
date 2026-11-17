import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { crewProvider } from '../dist/provider.js';
import { connected, crewService } from './support/crew-service.mjs';
import { fixture, saved, send } from '../../../tests/application/provider-stream-fixture.mjs';
import { until } from '../../../tests/host/fixture.mjs';

const memberId = randomUUID();
const instance = { namespace: 'crew', installationId: 'test', generation: 'one', protocolVersion: '1' };
const service = (t, options) => crewService(t, { ...options, memberId, token: 'private-crew-test', instance });

test('Crew public entry creates, observes actual SSE text, approves, stops and replaces its baseline on SQLite reopen', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await until(() => remote.streams.size === 1);
  const conversationId = [...remote.conversations.keys()][0];
  const creation = f.inspect(db => JSON.parse(db.prepare('SELECT original FROM provider_creations').get().original));
  assert.equal(conversationId, creation.intent.operationId);
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'accepted');
  const [requestId] = [...remote.receipts][0];
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'running');
  const card = remote.pend(conversationId);
  await until(() => saved(f).decisions.length === 1);
  const decision = JSON.parse(saved(f).decisions[0].data);
  const result = await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'approve',
    body: { kind: 'approve', pendingId: decision.visible.pendingId, choiceId: decision.choices[0].id } });
  assert.equal(result.receipt.state.kind, 'completed');
  assert.equal(remote.calls.find(call => call.path.endsWith('/human')).input.requestId, requestId);
  remote.withdraw(conversationId, card.approvalId);
  const runId = JSON.parse(saved(f).conversation.document).domain.currentRun.runId;
  const stopped = await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'stop', body: { kind: 'cancel', runId } });
  assert.equal(stopped.receipt.state.kind, 'accepted');
  remote.reply(conversationId, 'Public Crew reply');
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.outcome === 'completed');
  const before = JSON.parse(saved(f).checkpoint.data).cursor;
  await f.restart([remote.extension()]);
  await until(() => remote.streams.size === 1 && JSON.parse(saved(f).checkpoint.data).cursor.opaque.epoch !== before.opaque.epoch);
  assert.equal(JSON.parse(saved(f).conversation.document).domain.messages.at(-1).text, 'Public Crew reply');
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, 1);
  assert.equal(remote.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
});

test('Crew follow-up confirms the original completed request before admitting its own send once', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  const port = f.client.conversation(scope), first = await port.submit(send(scope));
  assert.equal(first.receipt.state.kind, 'accepted');
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'running');
  const [requestId, receipt] = [...remote.receipts][0];
  const target = f.inspect(db => db.prepare("SELECT target FROM commands WHERE id='send'").get().target);
  const captured = JSON.parse(target);
  assert.equal(requestId, captured.operation.operationId);
  assert.equal(receipt.conversationId, captured.operation.binding.authority.binding.opaqueSessionId);
  receipt.status = 'completed'; receipt.result = { text: 'Finished' };
  const before = remote.calls.length;
  const next = send(scope, 'follow-up');
  const result = await port.submit(next);
  assert.equal(result.kind, 'receipt');
  assert.equal(result.receipt.state.kind, 'accepted');
  assert.equal((await port.receipt('send')).state.kind, 'completed');
  assert.deepEqual(await port.submit(next), result);
  assert.equal((await port.submit({ ...next, body: { kind: 'send', text: 'Changed' } })).reason, 'command-id-conflict');
  const posts = remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests'));
  assert.deepEqual(posts.map(call => call.input.requestId), [requestId, result.receipt.hostOperationId]);
  assert.notEqual(result.receipt.hostOperationId, requestId);
  const lookup = remote.calls.findIndex((call, index) => index >= before && call.method === 'GET' &&
    call.path === `/v1/conversations/${receipt.conversationId}/requests/${requestId}`);
  assert(lookup >= before);
  assert(lookup < remote.calls.indexOf(posts[1]));
  assert.equal(f.inspect(db => db.prepare("SELECT target FROM commands WHERE id='send'").get().target), target);
});

const sendReceipt = (f, id = 'send') => JSON.parse(saved(f).commands.find(row => row.id === id).receipt).state.kind;

test('Crew settles a finished send from its original request status once observation sees the run end', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'accepted');
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'running');
  const [requestId, receipt] = [...remote.receipts][0];
  remote.reply(receipt.conversationId, 'Finished reply');
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.outcome === 'completed');
  await until(() => sendReceipt(f) === 'completed');
  const evidence = JSON.parse(saved(f).commands.find(row => row.id === 'send').observation).evidence.source;
  assert.equal(evidence.source, 'provider-lookup');
  assert.equal(evidence.data.status, 'completed');
  assert.deepEqual(remote.calls.filter(call => call.method === 'POST').map(call => call.input?.requestId).filter(Boolean), [requestId]);
});

test('Crew settles a send whose request finished while the host was stopped after restart', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'accepted');
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'running');
  const [requestId, receipt] = [...remote.receipts][0];
  remote.setReceiptFailure(true);
  remote.reply(receipt.conversationId, 'Finished while away');
  await until(() => JSON.parse(saved(f).conversation.document).domain.messages.at(-1)?.text === 'Finished while away');
  await f.restart([remote.extension()]);
  assert.equal(sendReceipt(f), 'accepted');
  assert.equal(JSON.parse(saved(f).conversation.document).domain.currentRun?.kind, 'running');
  remote.setReceiptFailure(false);
  await until(() => sendReceipt(f) === 'completed', 5000);
  assert.equal(JSON.parse(saved(f).conversation.document).domain.currentRun?.outcome, 'completed');
  assert.deepEqual(remote.calls.filter(call => call.method === 'POST').map(call => call.input?.requestId).filter(Boolean), [requestId]);
});

test('Crew lost submit remains original-only GET recovery and does not turn missing lookup into rejection', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  remote.setLost(true);
  const result = await f.client.conversation(scope).submit(send(scope));
  assert.equal(result.receipt.state.kind, 'uncertain');
  const before = remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests'));
  await f.restart([remote.extension()]);
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, before.length);
  assert(remote.calls.some(call => call.method === 'GET' && call.path.endsWith(before[0].input.requestId)));
});


async function direct(remote) {
  const { backend, presentation } = await connected(remote);
  const operation = { kind: 'create', operationId: randomUUID(), scope: { hostId: 'test-host', conversationId: 'chat' },
    agent: (await backend.discover()).agents[0].ref };
  const created = await backend.create(operation);
  assert.equal(created.kind, 'confirmed');
  return { backend, binding: created.value, presentation };
}

test('Crew discovery resolves a member that declares named subagents', async t => {
  const remote = await service(t, { subagents: { mode: 'named', targets: [{ role: 'analyst', engine: 'claude', profile: 'review',
    model: 'claude-test', providerHost: 'api.example.test', accountDigest: 'a'.repeat(64), availability: 'executable' }] } });
  const { backend, installation } = await connected(remote);
  t.after(() => backend.close());
  assert.deepEqual(await backend.discover(), { kind: 'available', agents: [
    { ref: { instance: installation.instance, kind: 'agent', opaqueId: memberId }, name: 'Crew · codex · test' }] });
  assert.equal(remote.calls.filter(call => call.path === '/v1/members').length, 1);
});

for (const trigger of ['host shutdown', 'retirement after a discovery failure']) test(`${trigger} drains a Crew baseline observer before observation admission`, { timeout: 5000 }, async t => {
  const remote = await service(t), extension = remote.extension();
  const activate = extension.value.entry.activate;
  const baseline = Promise.withResolvers(), release = Promise.withResolvers();
  let credentialUses = 0, observations = 0, closed = false, failDiscovery = false;
  let cleanup;
  extension.value.entry = { ...extension.value.entry, activate(context) {
    return activate({ ...context,
      credentials: { ...context.credentials, use(request, action) {
        return context.credentials.use(request, async token => {
          credentialUses++;
          try { return await action(token); } finally { credentialUses--; }
        });
      } },
      providers: { add(id, provider, presentation) {
        return context.providers.add(id, { ...provider, async connect(request) {
          const connection = await provider.connect(request);
          assert.equal(connection.kind, 'connected');
          const backend = connection.backend;
          cleanup = () => backend.close();
          return { ...connection, backend: { ...backend,
            discover() { if (failDiscovery) throw new Error('Discovery unavailable'); return backend.discover(); },
            async snapshot(binding) {
              const result = await backend.snapshot(binding);
              assert.equal(result.kind, 'available');
              baseline.resolve();
              await release.promise;
              return result;
            },
            observe(...args) { observations++; return backend.observe(...args); },
          } };
        } }, presentation);
      } },
    });
  } };
  const f = await fixture(t, [extension]), creating = f.create();
  try {
    await baseline.promise;
    assert.equal(remote.streams.size, 1);
    assert.equal(credentialUses, 1);
    if (trigger !== 'host shutdown') {
      failDiscovery = true;
      assert.deepEqual((await f.running.discoverProviders()).map(item => item.cause), ['invalid-installation']);
      await until(() => remote.streams.size === 0);
      assert.equal(closed, false);
      assert.equal(observations, 0);
    }
    const closing = f.running.close().then(() => { closed = true; });
    release.resolve();
    await creating;
    await until(() => closed);
    await closing;
    assert.equal(observations, 0);
    assert.equal(credentialUses, 0);
    await until(() => remote.streams.size === 0);
    assert.equal(remote.calls.some(call => call.path.endsWith('/cancel')), false);
  } finally {
    release.resolve();
    if (!closed) await cleanup?.();
  }
});

test('Crew same-source handoff awaits admitted callbacks and close drains without remote cancellation', async t => {
  const remote = await service(t), { backend, binding } = await direct(remote);
  t.after(() => backend.close());
  const baseline = await backend.snapshot(binding);
  assert.equal(baseline.kind, 'available');
  const barrier = Promise.withResolvers(); let received = 0, ended = false;
  const feed = backend.observe({ binding, after: baseline.snapshot.cursor }, async () => { received++; await barrier.promise; });
  await until(() => received === 1);
  const id = binding.authority.binding.opaqueSessionId;
  for (let index = 0; index < 20; index++) remote.emit(id);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(received, 1);
  const closing = backend.close().then(() => { ended = true; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(ended, false);
  barrier.resolve(); await closing;
  assert.equal((await feed.ended).kind, 'closed');
  assert.equal(remote.calls.filter(call => call.path.endsWith('/events')).length, 1);
  assert.equal(remote.calls.filter(call => call.path.endsWith('/cancel')).length, 0);
  assert.equal(received, 1);
});

test('Crew missing original GET remains uncertain and foreign binding refuses before HTTP', async t => {
  const remote = await service(t), { backend, binding } = await direct(remote);
  t.after(() => backend.close());
  const operation = { kind: 'send', operationId: randomUUID(), binding, request: { text: 'never submitted' } };
  const before = remote.calls.length;
  assert.equal((await backend.reconcileCommand(operation)).kind, 'uncertain');
  assert.equal(remote.calls.at(-1).method, 'GET');
  assert(remote.calls.at(-1).path.endsWith(operation.operationId));
  await assert.rejects(backend.submit({ ...operation, binding: { ...binding, authority: { ...binding.authority,
    binding: { ...binding.authority.binding, opaqueSessionId: randomUUID() } } } }), /Foreign Crew conversation/);
  assert.equal(remote.calls.length, before + 1);
});


test('Crew conflicting admission remains uncertain without retry or replacement identity', async t => {
  const remote = await service(t), { backend, binding } = await direct(remote);
  t.after(() => backend.close()); remote.setConflict();
  const operation = { kind: 'send', operationId: randomUUID(), binding, request: { text: 'conflicting request' } };
  assert.equal((await backend.submit(operation)).kind, 'uncertain');
  assert.equal((await backend.reconcileCommand(operation)).kind, 'uncertain');
  assert.equal(remote.calls.filter(call => call.path.endsWith('/requests') && call.method === 'POST').length, 1);
});

for (const mode of ['redirect', 'oversized']) test(`Crew observer refuses ${mode} transport without exposing a baseline`, async t => {
  const remote = await service(t), { backend, binding } = await direct(remote);
  t.after(() => backend.close()); remote.setObservation(mode);
  assert.equal((await backend.snapshot(binding)).kind, 'unavailable');
  assert.equal(remote.calls.filter(call => call.path === '/v1/capabilities').length, 1);
});

test('Crew invalid remote content drains and retains only the last acknowledged cursor', async t => {
  const remote = await service(t), { backend, binding } = await direct(remote);
  t.after(() => backend.close());
  const baseline = await backend.snapshot(binding), admitted = [];
  const feed = backend.observe({ binding, after: baseline.snapshot.cursor }, async item => { admitted.push(item.snapshot.cursor); });
  await until(() => admitted.length === 1);
  remote.emit(binding.authority.binding.opaqueSessionId, [
    { type: 'TEXT_MESSAGE_START', messageId: 'oversized-message', role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: 'oversized-message', delta: 'x'.repeat(262145) },
  ]);
  const ending = await Promise.race([feed.ended, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Error('Invalid observation did not drain')), 3000); timer.unref();
  })]);
  assert.equal(ending.kind, 'disconnected');
  assert.deepEqual(ending.cursor, admitted.at(-1));
  assert.equal(admitted.length, 2);
});

for (const terminal of ['completed', 'failed', 'cancelled']) test(`Crew ${terminal} original GET settles send and permits a distinct next request`, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0];
  receipt.status = terminal;
  receipt.cancellation = { receiptId: randomUUID(), delivery: 'delivered', nativeTermination: 'confirmed', effects: 'not_assessed' };
  if (terminal === 'completed') receipt.result = { text: 'Finished' };
  remote.emit(receipt.conversationId);
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'ended');
  assert.equal(JSON.parse(saved(f).conversation.document).domain.currentRun.outcome, terminal === 'cancelled' ? 'interrupted' : terminal);
  await until(() => sendReceipt(f) === 'completed');
  const evidence = JSON.parse(saved(f).commands.find(row => row.id === 'send').observation).evidence.source;
  assert.equal(evidence.source, 'provider-lookup');
  assert.equal(evidence.data.requestId, requestId);
  assert.equal(evidence.data.status, terminal);
  const settled = saved(f).commands.find(row => row.id === 'send'), before = remote.calls.length;
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'completed');
  assert.deepEqual(saved(f).commands.find(row => row.id === 'send'), settled);
  assert(remote.calls.slice(before).every(call => call.method === 'GET'));
  assert.equal((await f.client.conversation(scope).submit(send(scope, 'second'))).receipt.state.kind, 'accepted');
  const submissions = remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests'));
  assert.equal(submissions.length, 2);
  assert.notEqual(submissions[0].input.requestId, submissions[1].input.requestId);
  assert.equal(submissions[0].path, submissions[1].path);
});

function pendingCall(conversation, requestId, { question = false, child = false, proof = true } = {}) {
  const toolName = question ? 'choose_next_step' : 'record_work_item';
  const card = { conversationId: conversation.state.conversationId, memberId, requestId, invocationId: randomUUID(),
    approvalId: randomUUID(), version: 1, policyVersion: 1, toolName,
    summary: question ? 'Choose the next step' : 'Record one work item',
    choices: question ? ['inspect', 'test'] : ['approve', 'deny'],
    ...(!question && { standingChoices: ['allow_conversation', 'allow_always'] }),
    ...(proof !== undefined && { argumentsComplete: proof }) };
  conversation.messages.push({ id: `${card.approvalId}/call`, role: 'assistant', content: child ? 'Child transcript stays hidden' : '',
    ...(child && { subagentRunId: randomUUID() }), toolCalls: [{ id: card.approvalId, type: 'function',
      function: { name: toolName, arguments: JSON.stringify(question ? {} : { operation_id: requestId }) } }] });
  conversation.state[question ? 'pendingQuestions' : 'pendingApprovals'] = [card];
  return card;
}

const detailCapability = { version: 1, tools: ['record_work_item'] };
function ownerDetail(card, args = {}) {
  const { conversationId, memberId, requestId, invocationId, approvalId, version } = card;
  return { apiVersion: '1', conversationId, memberId, requestId, invocationId, approvalId, version,
    policyVersion: 1, toolName: 'record_work_item', arguments: { operation_id: requestId, ...args } };
}

for (const args of [{}, { note: '' }, { note: ' \n\tCafé e\u0301 雪 😀  ' }, { note: '\u0001'.repeat(4096) }]) {
  test(`Crew owner detail preserves complete arguments (${Object.hasOwn(args, 'note') ? args.note.length : 'absent'} characters)`, async t => {
    const remote = await service(t, { approvalDetails: detailCapability }), { backend, binding } = await direct(remote);
    t.after(() => backend.close());
    const conversation = remote.conversations.get(binding.authority.binding.opaqueSessionId), requestId = randomUUID();
    conversation.messages.push({ id: requestId, role: 'user', content: 'Controlled pending request' });
    const card = pendingCall(conversation, requestId, { child: true, proof: false });
    const detail = ownerDetail(card, args); remote.details.set(card.approvalId, detail);
    const baseline = await backend.snapshot(binding);
    assert.equal(baseline.kind, 'available');
    const decision = baseline.snapshot.decisions[0];
    assert.equal(decision.prompt, `${card.summary}\nrecord_work_item\n${JSON.stringify(detail.arguments, null, 2)}`);
    assert.deepEqual(decision.choices.map(choice => choice.label), ['Approve once', 'Deny']);
    assert.deepEqual(JSON.parse(decision.ref.ref.opaqueId), [requestId, card.invocationId, card.approvalId, 1]);
    const get = remote.calls.find(call => call.path.endsWith(`/approvals/${card.approvalId}`));
    assert.equal(get.method, 'GET');
    assert.equal(get.path, `/v1/conversations/${card.conversationId}/requests/${requestId}/approvals/${card.approvalId}`);
    assert.deepEqual(get.query, { memberId, invocationId: card.invocationId, version: '1' });
    assert.equal(remote.calls.some(call => call.path.endsWith('/human')), false);
    if (args.note?.length === 4096) assert(decision.prompt.length > 16384);
  });
}

for (const approvalDetails of [undefined, { version: 2, tools: ['record_work_item'] }, { version: 1, tools: ['future_tool'] }]) {
  for (const variant of ['redacted', 'complete', 'question']) test(`Crew unsupported owner detail ${JSON.stringify(approvalDetails)} retains ${variant} behavior`, async t => {
    const remote = await service(t, { approvalDetails }), { backend, binding } = await direct(remote);
    t.after(() => backend.close());
    const conversation = remote.conversations.get(binding.authority.binding.opaqueSessionId), requestId = randomUUID();
    conversation.messages.push({ id: requestId, role: 'user', content: 'Controlled pending request' });
    pendingCall(conversation, requestId, { question: variant === 'question', proof: variant === 'complete' });
    const baseline = await backend.snapshot(binding);
    assert.equal(baseline.kind, 'available');
    assert.deepEqual(baseline.snapshot.decisions[0].choices.map(choice => choice.label),
      variant === 'redacted' ? ['Deny'] : variant === 'complete' ? ['Approve once', 'Deny'] : ['Inspect', 'Test']);
    assert.equal(remote.calls.some(call => call.path.includes('/approvals/')), false);
  });
}

test('Crew owner detail capability leaves questions on their existing public argument path', async t => {
  const remote = await service(t, { approvalDetails: detailCapability }), { backend, binding } = await direct(remote);
  t.after(() => backend.close());
  const conversation = remote.conversations.get(binding.authority.binding.opaqueSessionId), requestId = randomUUID();
  conversation.messages.push({ id: requestId, role: 'user', content: 'Question' });
  pendingCall(conversation, requestId, { question: true, proof: false });
  const baseline = await backend.snapshot(binding);
  assert.equal(baseline.kind, 'available');
  assert.deepEqual(baseline.snapshot.decisions[0].choices.map(choice => choice.label), ['Inspect', 'Test']);
  assert.equal(remote.calls.some(call => call.path.includes('/approvals/')), false);
});

for (const status of ['open', 'reserved', 'closed']) test(`Crew legacy ${status} card keeps its decision ownership when owner details become available`, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
  const card = pendingCall(conversation, requestId, { proof: false }); remote.emit(receipt.conversationId);
  await until(() => saved(f).decisions.length === 1);
  const legacy = JSON.parse(saved(f).decisions[0].data);
  assert.deepEqual(legacy.choices.map(choice => choice.label), ['Deny']);
  if (status !== 'open') {
    remote.setLost(status === 'reserved');
    const result = await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'legacy-choice',
      body: { kind: 'approve', pendingId: legacy.visible.pendingId, choiceId: legacy.choices[0].id } });
    assert.equal(result.receipt.state.kind, status === 'reserved' ? 'uncertain' : 'completed');
    remote.setLost(false);
  }
  const before = saved(f);
  remote.setCapability(detailCapability);
  remote.details.set(card.approvalId, ownerDetail(card, { note: 'Full note after upgrade' }));
  await f.restart([remote.extension()]);
  await until(() => JSON.parse(saved(f).checkpoint.data).cursor.opaque.epoch !== JSON.parse(before.checkpoint.data).cursor.opaque.epoch);
  const after = saved(f), doc = JSON.parse(after.conversation.document);
  assert.deepEqual(after.commands, before.commands);
  assert.equal(after.decisions[0].status, status);
  if (status === 'open') {
    assert.match(doc.decisions[legacy.visible.pendingId].prompt, /Full note after upgrade/);
    assert.deepEqual(JSON.parse(after.decisions[0].data).choices.map(choice => choice.label), ['Approve once', 'Deny']);
    assert.deepEqual(JSON.parse(after.decisions[0].data).reference, legacy.reference);
  } else {
    assert.deepEqual(after.decisions, before.decisions);
    if (status === 'closed') assert.deepEqual(doc.decisions, {});
    else {
      assert.equal(doc.decisions[legacy.visible.pendingId].prompt, legacy.visible.prompt);
      assert.equal(doc.decisions[legacy.visible.pendingId].reserved, true);
      assert.equal((await f.client.reconcile(scope, 'legacy-choice')).state.kind, 'uncertain');
      assert.equal(saved(f).commands.find(row => row.id === 'legacy-choice').target, before.commands.find(row => row.id === 'legacy-choice').target);
    }
  }
  assert.equal(remote.calls.filter(call => call.path.endsWith('/human')).length, status === 'open' ? 0 : 1);
});

test('Crew resolves every supported detail before publishing any decision from a baseline', async t => {
  const remote = await service(t, { approvalDetails: detailCapability }), { backend, binding } = await direct(remote);
  t.after(() => backend.close());
  const conversation = remote.conversations.get(binding.authority.binding.opaqueSessionId), requestId = randomUUID();
  conversation.messages.push({ id: requestId, role: 'user', content: 'Two pending calls' });
  const first = pendingCall(conversation, requestId, { proof: false }), second = pendingCall(conversation, requestId, { proof: false });
  conversation.state.pendingApprovals = [first, second];
  remote.details.set(first.approvalId, ownerDetail(first, { note: 'The first read succeeds' }));
  assert.equal((await backend.snapshot(binding)).kind, 'unavailable');
  await until(() => remote.streams.size === 0);
  remote.details.set(second.approvalId, ownerDetail(second, { note: 'Now both reads succeed' }));
  const recovered = await backend.snapshot(binding);
  assert.equal(recovered.kind, 'available');
  assert.equal(recovered.snapshot.decisions.length, 2);
  assert(recovered.snapshot.decisions.every(decision => decision.choices[0].label === 'Approve once'));
  assert.equal(remote.calls.some(call => call.path.endsWith('/human')), false);
});

test('complete owner details still fail the whole snapshot budget without publishing any approval', async t => {
  const remote = await service(t, { approvalDetails: detailCapability }), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
  conversation.messages.push({ id: 'long-message', role: 'assistant', content: 'x'.repeat(250000) });
  remote.emit(receipt.conversationId);
  await until(() => JSON.parse(saved(f).checkpoint.data).state.messages.at(-1).text.length === 250000);
  const before = saved(f), cards = [];
  for (let index = 0; index < 32; index++) {
    const card = pendingCall(conversation, requestId, { proof: false }); cards.push(card);
    remote.details.set(card.approvalId, ownerDetail(card, { note: '\u0001'.repeat(4096) }));
  }
  conversation.state.pendingApprovals = cards;
  remote.emit(receipt.conversationId, [{ type: 'STATE_SNAPSHOT', snapshot: conversation.state }]);
  await until(() => remote.streams.size === 0);
  assert.equal(saved(f).decisions.length, 0);
  assert.deepEqual(saved(f).commands, before.commands);
  assert.deepEqual(JSON.parse(saved(f).checkpoint.data).state, JSON.parse(before.checkpoint.data).state);
  assert.equal((await f.client.providerObservation({ scope, action: 'read' })).kind, 'stopped');
});

for (const failure of ['unavailable', 'invalid', 'conversationId', 'memberId', 'requestId', 'invocationId', 'approvalId', 'version', 'policyVersion', 'operation_id']) {
  test(`Crew ${failure} owner detail stops observation without publishing partial or downgraded decisions and recovers on reopen`, async t => {
    const remote = await service(t, { approvalDetails: detailCapability }), f = await fixture(t, [remote.extension()]), scope = await f.create();
    await f.client.conversation(scope).submit(send(scope));
    const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
    const card = pendingCall(conversation, requestId, { proof: false });
    remote.details.set(card.approvalId, ownerDetail(card, { note: 'Retain this exact owner note' })); remote.emit(receipt.conversationId);
    await until(() => saved(f).decisions.length === 1);
    const before = saved(f);
    remote.setDetailHandler(detail => {
      const body = structuredClone(detail);
      if (failure === 'unavailable') return { status: 503, body: { error: 'unavailable' } };
      if (failure === 'invalid') body.arguments.note = '\0';
      else if (failure === 'operation_id') body.arguments.operation_id = randomUUID();
      else body[failure] = ['version', 'policyVersion'].includes(failure) ? 2 : randomUUID();
      return { status: 200, body };
    });
    conversation.messages.push({ id: 'unpublished', role: 'assistant', content: 'Must not replace saved history' });
    remote.emit(receipt.conversationId);
    await until(() => remote.streams.size === 0);
    assert.deepEqual(saved(f), before);
    assert.equal((await f.client.providerObservation({ scope, action: 'read' })).kind, 'stopped');
    remote.setDetailHandler(undefined);
    await f.restart([remote.extension()]);
    await until(() => JSON.parse(saved(f).checkpoint.data).cursor.opaque.epoch !== JSON.parse(before.checkpoint.data).cursor.opaque.epoch);
    assert.deepEqual(saved(f).decisions, before.decisions);
    assert.deepEqual(saved(f).commands, before.commands);
    assert.equal(JSON.parse(saved(f).conversation.document).domain.messages.at(-1).text, 'Must not replace saved history');
    assert.equal(remote.calls.some(call => call.path.endsWith('/human')), false);
  });
}

test('closing Crew observation aborts an owner detail read and drains without publishing', { timeout: 5000 }, async t => {
  const remote = await service(t, { approvalDetails: detailCapability }), { backend, binding } = await direct(remote);
  t.after(() => backend.close());
  const conversation = remote.conversations.get(binding.authority.binding.opaqueSessionId), requestId = randomUUID();
  conversation.messages.push({ id: requestId, role: 'user', content: 'Pending read' });
  const card = pendingCall(conversation, requestId, { proof: false });
  remote.details.set(card.approvalId, ownerDetail(card));
  const reading = Promise.withResolvers(), release = Promise.withResolvers();
  remote.setDetailHandler(async detail => { reading.resolve(); await release.promise; return { status: 200, body: detail }; });
  try {
    const baseline = backend.snapshot(binding);
    await reading.promise;
    await backend.close();
    assert.equal((await baseline).kind, 'unavailable');
    await until(() => remote.streams.size === 0);
  } finally { release.resolve(); }
});

test('browser retries owner detail failures and renders a full escaped note before one exact approval', { timeout: 20_000 }, async t => {
  const remote = await service(t, { approvalDetails: detailCapability }), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
  const card = pendingCall(conversation, requestId, { proof: false });
  const markup = '<img src=x onerror="window.ownerNoteExecuted=true">雪😀';
  const note = markup + '\u0001'.repeat(4096 - Buffer.byteLength(markup));
  const detail = ownerDetail(card, { note }); remote.details.set(card.approvalId, detail);
  remote.setDetailHandler(() => ({ status: 503, body: { error: 'unavailable' } })); remote.emit(receipt.conversationId);
  await until(() => remote.streams.size === 0);
  assert.equal(saved(f).decisions.length, 0);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: `A real provider reply · Open conversation ${scope.conversationId}`, exact: true }).click();
  await page.getByRole('button', { name: 'Check for updates', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Approve once', exact: true }).count(), 0);
  remote.setDetailHandler(undefined);
  await page.getByRole('button', { name: 'Check for updates', exact: true }).click();
  const approval = page.getByRole('region', { name: 'Approval required', exact: true });
  await approval.getByRole('button', { name: 'Approve once', exact: true }).waitFor();
  const prompt = `${card.summary}\nrecord_work_item\n${JSON.stringify(detail.arguments, null, 2)}`;
  assert.equal(await approval.locator('p').textContent(), prompt);
  assert(prompt.length > 16384);
  assert.equal(await approval.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.ownerNoteExecuted), undefined);
  assert.equal(remote.calls.some(call => call.path.endsWith('/human')), false);
  assert.equal(JSON.parse(saved(f).decisions[0].data).visible.prompt, prompt);
  await approval.getByRole('button', { name: 'Approve once', exact: true }).click();
  await until(() => saved(f).decisions[0].status === 'closed');
  const decisions = remote.calls.filter(call => call.path.endsWith('/human'));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].path, `/v1/conversations/${card.conversationId}/human`);
  assert.deepEqual(decisions[0].input, { memberId, requestId, invocationId: card.invocationId,
    approvalId: card.approvalId, version: 1, choice: 'approve' });
  const before = saved(f);
  await page.close(); await f.restart([remote.extension()]);
  await until(() => JSON.parse(saved(f).checkpoint.data).cursor.opaque.epoch !== JSON.parse(before.checkpoint.data).cursor.opaque.epoch);
  assert.deepEqual(saved(f).decisions, before.decisions);
  assert.deepEqual(JSON.parse(saved(f).conversation.document).decisions, {});
  assert.equal(remote.calls.filter(call => call.path.endsWith('/human')).length, 1);
});

for (const question of [false, true]) test(`Crew reopened child ${question ? 'question' : 'approval'} keeps exact usable choices without child transcript`, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
  const card = pendingCall(conversation, requestId, { question, child: true, proof: question ? undefined : true });
  if (question) delete card.argumentsComplete;
  remote.emit(receipt.conversationId);
  await until(() => saved(f).decisions.length === 1);
  const before = JSON.parse(saved(f).checkpoint.data).cursor.opaque.epoch;
  await f.restart([remote.extension()]);
  await until(() => JSON.parse(saved(f).checkpoint.data).cursor.opaque.epoch !== before);
  const current = saved(f), decision = JSON.parse(current.decisions[0].data);
  assert.deepEqual(decision.choices.map(choice => choice.label), question ? ['Inspect', 'Test'] : ['Approve once', 'Deny']);
  assert.equal(decision.visible.reserved, undefined);
  assert(!JSON.stringify(JSON.parse(current.conversation.document).domain.messages).includes('Child transcript stays hidden'));
  assert(decision.choices.length > 0);
  assert.equal((await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'child-choice',
    body: { kind: 'approve', pendingId: decision.visible.pendingId, choiceId: decision.choices[0].id } })).receipt.state.kind, 'completed');
  const submitted = remote.calls.find(call => call.path.endsWith('/human')).input;
  for (const field of ['requestId', 'invocationId', 'approvalId', 'version']) assert.equal(submitted[field], card[field]);
  assert.equal(submitted.choice, question ? 'inspect' : 'approve');
});

for (const variant of ['redacted', 'false-proof', 'unknown-tool', 'wrong-name', 'wrong-operation', 'missing-tool', 'complete']) {
  test(`Crew public protected card ${variant} requires proof and matching complete arguments and never offers standing grants`, async t => {
    const remote = await service(t), { backend, binding } = await direct(remote);
    t.after(() => backend.close());
    const conversation = remote.conversations.get(binding.authority.binding.opaqueSessionId), requestId = randomUUID();
    conversation.messages.push({ id: requestId, role: 'user', content: 'Controlled pending request' });
    const card = pendingCall(conversation, requestId);
    if (variant === 'redacted') delete card.argumentsComplete;
    if (variant === 'false-proof') card.argumentsComplete = false;
    if (variant === 'unknown-tool') delete card.toolName;
    const call = conversation.messages.at(-1).toolCalls[0];
    if (variant === 'wrong-name') call.function.name = 'choose_next_step';
    if (variant === 'wrong-operation') call.function.arguments = JSON.stringify({ operation_id: randomUUID() });
    if (variant === 'missing-tool') delete conversation.messages.at(-1).toolCalls;
    const baseline = await backend.snapshot(binding);
    assert.equal(baseline.kind, 'available');
    const decision = baseline.snapshot.decisions[0];
    assert.deepEqual(decision.choices.map(choice => choice.label), variant === 'complete' ? ['Approve once', 'Deny'] : ['Deny']);
    if (variant !== 'complete') assert.match(decision.prompt, /details.*incomplete.*redacted.*note/is);
    else assert.match(decision.prompt, new RegExp(requestId));
    assert.equal(Object.hasOwn(JSON.parse(call.function.arguments), 'note'), false);
  });
}

test('Crew question without tool context waits for usable choices without creating an empty decision', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
  pendingCall(conversation, requestId, { question: true });
  const message = conversation.messages.pop();
  remote.emit(receipt.conversationId);
  const before = JSON.parse(saved(f).checkpoint.data).cursor.opaque.sequence;
  await until(() => JSON.parse(saved(f).checkpoint.data).cursor.opaque.sequence > before);
  assert.equal(saved(f).decisions.length, 0);
  conversation.messages.push(message); remote.emit(receipt.conversationId);
  await until(() => saved(f).decisions.length === 1);
  assert.deepEqual(JSON.parse(saved(f).decisions[0].data).choices.map(choice => choice.label), ['Inspect', 'Test']);
});

test('Crew lost decision remains uncertain after card omission and original-only GET on SQLite reopen', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
  const card = pendingCall(conversation, requestId); remote.emit(receipt.conversationId);
  await until(() => saved(f).decisions.length === 1);
  const decision = JSON.parse(saved(f).decisions[0].data);
  remote.setLost(true);
  assert.equal((await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'lost-decision',
    body: { kind: 'approve', pendingId: decision.visible.pendingId, choiceId: decision.choices[0].id } })).receipt.state.kind, 'uncertain');
  const original = saved(f).commands.find(command => command.id === 'lost-decision');
  receipt.status = 'completed'; receipt.result = { text: 'Request ended without an exact-choice receipt' };
  conversation.state.pendingApprovals = []; remote.emit(receipt.conversationId);
  const before = remote.calls.length;
  await f.restart([remote.extension()]);
  assert(remote.calls.slice(before).every(call => call.method === 'GET' || call.path.endsWith('/events')));
  await until(() => remote.streams.size === 1);
  const recoveryStart = remote.calls.length;
  assert.equal((await f.client.reconcile(scope, 'lost-decision')).state.kind, 'uncertain');
  assert(remote.calls.slice(recoveryStart).every(call => call.method === 'GET'));
  assert(remote.calls.slice(before).some(call => call.path.endsWith(requestId)));
  const after = saved(f), retained = after.commands.find(command => command.id === original.id);
  assert.equal(retained.target, original.target);
  assert.equal(after.decisions[0].status, 'reserved');
  assert.equal(remote.calls.filter(call => call.path.endsWith('/human')).length, 1);
  assert.equal(remote.calls.find(call => call.path.endsWith('/human')).input.approvalId, card.approvalId);
});


for (const choice of ['approve', 'deny', 'inspect', 'test']) test(`Crew exact ${choice} acknowledgement closes only its command and stays settled on reopen`, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
  const card = pendingCall(conversation, requestId, { question: choice === 'inspect' || choice === 'test' });
  remote.emit(receipt.conversationId);
  await until(() => saved(f).decisions.length === 1);
  const decision = JSON.parse(saved(f).decisions[0].data);
  const chosen = decision.choices[card.choices.indexOf(choice)];
  const command = { version: 1, scope, clientCommandId: 'exact-choice',
    body: { kind: 'approve', pendingId: decision.visible.pendingId, choiceId: chosen.id } };
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'completed');
  const settled = saved(f), original = settled.commands.find(row => row.id === 'exact-choice');
  assert.equal(settled.decisions[0].status, 'closed');
  assert.equal(settled.decisions[0].operation, null);
  assert.deepEqual(JSON.parse(original.observation).evidence.source.data, { approvalId: card.approvalId, choice });
  assert.equal(JSON.parse(settled.conversation.document).domain.currentRun.kind, 'running');
  assert.equal(JSON.parse(settled.commands.find(row => row.id === 'send').receipt).state.kind, 'accepted');
  conversation.state.pendingApprovals = []; conversation.state.pendingQuestions = [];
  remote.emit(receipt.conversationId);
  await f.restart([remote.extension()]);
  await until(() => remote.streams.size === 1);
  const before = remote.calls.length;
  assert.equal((await f.client.reconcile(scope, 'exact-choice')).state.kind, 'completed');
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'completed');
  assert(remote.calls.slice(before).every(call => call.method === 'GET'));
  assert.equal(saved(f).commands.find(row => row.id === 'exact-choice').target, original.target);
  assert.equal(remote.calls.filter(call => call.path.endsWith('/human')).length, 1);
  assert.equal(remote.calls.find(call => call.path.endsWith('/human')).input.choice, choice);
});

for (const termination of ['absent', 'unconfirmed', 'confirmed']) test(`Crew uncertain request with ${termination} native termination preserves evidence across SQLite reopen`, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'running');
  const runId = JSON.parse(saved(f).conversation.document).domain.currentRun.runId;
  assert.equal((await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'stop',
    body: { kind: 'cancel', runId } })).receipt.state.kind, 'accepted');
  const stopped = remote.receipts.get(requestId);
  stopped.status = 'uncertain';
  if (termination === 'absent') delete stopped.cancellation;
  else Object.assign(stopped.cancellation, { delivery: 'delivered', nativeTermination: termination });
  conversation.state.phase = 'idle'; conversation.state.pendingApprovals = [];
  remote.emit(receipt.conversationId);
  await until(() => JSON.parse(saved(f).checkpoint.data).state.run?.status === 'uncertain');
  const assertObserved = () => {
    const state = saved(f), run = JSON.parse(state.checkpoint.data).state.run;
    assert.deepEqual(JSON.parse(state.conversation.document).domain.currentRun, termination === 'confirmed'
      ? { kind: 'ended', runId, outcome: 'interrupted' } : { kind: 'running', runId });
    assert.deepEqual(run, { requestId, status: 'uncertain', cancellation: stopped.cancellation ?? null });
    assert.deepEqual(JSON.parse(state.conversation.document).domain.messages.map(message => message.text), ['A real provider reply']);
  };
  assertObserved();
  const epoch = JSON.parse(saved(f).checkpoint.data).cursor.opaque.epoch;
  await f.restart([remote.extension()]);
  await until(() => JSON.parse(saved(f).checkpoint.data).cursor.opaque.epoch !== epoch);
  assertObserved();
  const recoveryStart = remote.calls.length;
  const expected = termination === 'confirmed' ? 'completed' : 'accepted';
  assert.equal((await f.client.reconcile(scope, 'stop')).state.kind, expected);
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, expected);
  assert(remote.calls.slice(recoveryStart).every(call => call.method === 'GET'));
  assert(remote.calls.slice(recoveryStart).every(call => call.path.endsWith(requestId)));
  const evidence = JSON.parse(saved(f).commands.find(row => row.id === 'send').observation).evidence.source.data;
  assert.deepEqual(evidence, { requestId, status: 'uncertain', ...(stopped.cancellation && { cancellation: stopped.cancellation }) });
  assert.equal(remote.calls.filter(call => call.path.endsWith('/requests') && call.method === 'POST').length, 1);
  assert.equal(remote.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
  assert.equal(remote.calls.filter(call => call.path.endsWith('/human')).length, 0);
  if (termination !== 'confirmed') {
    assert.equal((await f.client.conversation(scope).submit(send(scope, 'blocked'))).kind, 'rejected');
    return;
  }
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: `A real provider reply · Open conversation ${scope.conversationId}`, exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A distinct next request');
  await page.getByRole('button', { name: 'Send', exact: true }).and(page.locator(':enabled')).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: /Harness,/ }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Check pending command', exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => remote.receipts.size === 2);
  const requests = remote.calls.filter(call => call.path.endsWith('/requests') && call.method === 'POST');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[1].input.requestId, requestId);
  assert.equal(requests[1].input.text, 'A distinct next request');
});


for (const mismatch of ['approvalId', 'decision']) test(`Crew mismatched ${mismatch} acknowledgement cannot settle the original choice`, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
  pendingCall(conversation, requestId); remote.emit(receipt.conversationId);
  await until(() => saved(f).decisions.length === 1);
  const decision = JSON.parse(saved(f).decisions[0].data);
  remote.setDecisionReply(mismatch === 'approvalId' ? { approvalId: randomUUID() } : { decision: 'deny' });
  assert.equal((await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'mismatched-choice',
    body: { kind: 'approve', pendingId: decision.visible.pendingId, choiceId: decision.choices[0].id } })).receipt.state.kind, 'uncertain');
  assert.equal(saved(f).decisions[0].status, 'reserved');
  assert.equal(remote.calls.filter(call => call.path.endsWith('/human')).length, 1);
});


test('Crew historical uncertain run checkpoint decodes without inventing termination evidence', async t => {
  const remote = await service(t), { backend, binding, presentation } = await direct(remote);
  t.after(() => backend.close());
  const historical = { binding, messages: [], run: { requestId: randomUUID(), status: 'uncertain' } };
  const state = presentation.decodeState(historical);
  assert.equal(JSON.stringify(state), JSON.stringify(historical));
  assert.equal(Object.hasOwn(state.run, 'cancellation'), false);
  assert.deepEqual(presentation.snapshot(state, { run: () => ({ runId: 'original-run' }) }),
    { messages: [], currentRun: { kind: 'running', runId: 'original-run' } });
});


test('Crew legacy checkpoint without cancellation restores before a fresh confirmed-stop snapshot and drains normally', { timeout: 15_000 }, async t => {
  // Fail the automatic status read that follows the restored run end, so explicit reconciliation still performs the GET.
  let f, failEnded = false, failed = 0;
  const remote = await service(t, { intercept: async ({ request, parts, json }) => {
    if (!failEnded || request.method !== 'GET' || parts[4] !== 'requests' || parts.length !== 6) return false;
    if (JSON.parse(saved(f).conversation.document).domain.currentRun?.kind !== 'ended') return false;
    failed++; json(503, { error: 'unavailable' }); return true;
  } });
  f = await fixture(t, [remote.extension()]);
  const scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
  receipt.status = 'uncertain'; conversation.state.phase = 'idle'; remote.emit(receipt.conversationId);
  await until(() => JSON.parse(saved(f).checkpoint.data).state.run?.status === 'uncertain');
  const runId = JSON.parse(saved(f).conversation.document).domain.currentRun.runId;
  await f.running.close();
  const historical = JSON.parse(saved(f).checkpoint.data);
  delete historical.state.run.cancellation;
  f.inspect(db => db.prepare('UPDATE provider_checkpoints SET data=? WHERE conversation=?').run(JSON.stringify(historical), scope.conversationId));
  assert.deepEqual(JSON.parse(saved(f).checkpoint.data).state.run, { requestId, status: 'uncertain' });
  assert.deepEqual(JSON.parse(saved(f).conversation.document).domain.currentRun, { kind: 'running', runId });
  const original = saved(f).commands.find(row => row.id === 'send');
  receipt.cancellation = { receiptId: randomUUID(), delivery: 'delivered', nativeTermination: 'confirmed', effects: 'not_assessed' };
  failEnded = true;
  await f.restart([remote.extension()]);
  await until(() => JSON.parse(saved(f).checkpoint.data).cursor.opaque.epoch !== historical.cursor.opaque.epoch);
  const restored = saved(f), checkpoint = JSON.parse(restored.checkpoint.data);
  assert.equal(checkpoint.projectionVersion, historical.projectionVersion);
  assert.deepEqual(checkpoint.state.run, { requestId, status: 'uncertain', cancellation: receipt.cancellation });
  assert.deepEqual(JSON.parse(restored.conversation.document).domain.currentRun, { kind: 'ended', runId, outcome: 'interrupted' });
  assert.deepEqual(JSON.parse(restored.conversation.document).domain.messages.map(message => message.text), ['A real provider reply']);
  await until(() => failed > 0);
  assert.equal(sendReceipt(f), 'accepted');
  failEnded = false;
  const recoveryStart = remote.calls.length;
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'completed');
  assert.equal(saved(f).commands.find(row => row.id === 'send').target, original.target);
  assert(remote.calls.slice(recoveryStart).every(call => call.method === 'GET' && call.path.endsWith(requestId)));
  assert(remote.calls.slice(recoveryStart).length > 0);
  const evidence = JSON.parse(saved(f).commands.find(row => row.id === 'send').observation).evidence.source;
  assert.equal(evidence.source, 'provider-lookup');
  assert.deepEqual(evidence.data, { requestId, status: 'uncertain', cancellation: receipt.cancellation });
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: `A real provider reply · Open conversation ${scope.conversationId}`, exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('An unsent draft after legacy restore');
  await page.getByRole('button', { name: 'Send', exact: true }).and(page.locator(':enabled')).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: /Harness,/ }).isEnabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Check pending command', exact: true }).count(), 0);
  assert.equal(remote.receipts.size, 1);
  await page.close(); await f.running.close();
  await until(() => remote.streams.size === 0);
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, 1);
  assert.equal(remote.calls.filter(call => call.path.endsWith('/cancel') || call.path.endsWith('/human')).length, 0);
});

const standingCapability = { version: 1, choices: ['allow_conversation', 'allow_always'], cardField: 'standingChoices',
  stateField: 'grantedCalls', tools: ['record_work_item'], policyVersion: 1, initiatorKinds: ['owner'],
  route: '/v1/members/{memberId}/grants', inactiveListLimit: 20, revocation: 'later-proposals-only' };
function activeGrant(conversationId) {
  return { grantId: randomUUID(), memberId, conversationId, scope: conversationId ? 'conversation' : 'member',
    choice: conversationId ? 'allow_conversation' : 'allow_always', toolName: 'record_work_item', policyVersion: 1,
    approvalId: randomUUID(), createdAt: new Date().toISOString(), status: 'active' };
}
for (const variant of ['supported', 'absent-capability', 'future-capability', 'no-owner', 'no-tool', 'no-choice',
  'child', 'question', 'public-only', 'missing-card-policy', 'future-card-policy', 'not-offered']) {
  test(`Crew conversation permission choice requires exact owner evidence (${variant})`, async t => {
    let standingGrants = structuredClone(standingCapability);
    if (variant === 'absent-capability') standingGrants = undefined;
    if (variant === 'future-capability') standingGrants = { version: 2 };
    if (variant === 'no-owner') standingGrants.initiatorKinds = [];
    if (variant === 'no-tool') standingGrants.tools = [];
    if (variant === 'no-choice') standingGrants.choices = ['allow_always'];
    const remote = await service(t, { standingGrants, ...(variant !== 'public-only' && { approvalDetails: detailCapability }) });
    const { backend, binding } = await direct(remote); t.after(() => backend.close());
    const conversation = remote.conversations.get(binding.authority.binding.opaqueSessionId), requestId = randomUUID();
    conversation.messages.push({ id: requestId, role: 'user', content: 'Record an item' });
    const card = pendingCall(conversation, requestId, { question: variant === 'question' });
    if (variant !== 'child') card.invocationId = requestId;
    if (variant === 'missing-card-policy') delete card.policyVersion;
    if (variant === 'future-card-policy') card.policyVersion = 2;
    if (variant === 'not-offered') card.standingChoices = ['allow_always'];
    remote.details.set(card.approvalId, ownerDetail(card, { note: 'Exact current note' }));
    const baseline = await backend.snapshot(binding);
    assert.equal(baseline.kind, 'available');
    const decision = baseline.snapshot.decisions[0], choices = decision.choices.map(choice => JSON.parse(choice.ref.ref.opaqueId)[1]);
    assert.equal(choices.includes('allow_conversation'), variant === 'supported');
    assert.equal(choices.includes('allow_always'), false);
    if (variant === 'supported') {
      assert.match(decision.prompt, /different notes/);
      assert.match(decision.prompt, /Changing the model or profile keeps/);
      assert.match(decision.prompt, /Already-approved work may finish/);
    }
  });
}

test('Crew lists every applicable active scope and refuses foreign or changed-scope revocation before POST', async t => {
  const remote = await service(t, { standingGrants: standingCapability }), { backend, binding } = await direct(remote);
  t.after(() => backend.close());
  const conversationId = binding.authority.binding.opaqueSessionId;
  const own = activeGrant(conversationId), broad = activeGrant(null), foreign = activeGrant(randomUUID());
  remote.grants.push(own, broad, foreign, ...Array.from({ length: 25 }, () => activeGrant(conversationId)));
  const listing = await backend.permissions.read(binding);
  assert.equal(listing.kind, 'available');
  assert.equal(listing.permissions.length, 27);
  assert.equal(listing.permissions.some(row => row.ref.ref.opaqueId === foreign.grantId), false);
  assert.equal(listing.permissions.find(row => row.ref.ref.opaqueId === broad.grantId).scope, 'agent');
  const operation = { operationId: randomUUID(), binding, scope: 'conversation', permission: {
    binding, ref: { instance: binding.creation.agent.instance, kind: 'permission', opaqueId: own.grantId } } };
  assert.equal((await backend.permissions.revoke({ ...operation, permission: { ...operation.permission,
    ref: { ...operation.permission.ref, opaqueId: foreign.grantId } } })).kind, 'rejected');
  assert.equal((await backend.permissions.revoke({ ...operation, permission: { ...operation.permission,
    ref: { ...operation.permission.ref, opaqueId: broad.grantId } } })).kind, 'rejected');
  assert.equal(remote.calls.filter(call => call.path.endsWith('/revoke')).length, 0);
  assert.equal((await backend.permissions.revoke(operation)).kind, 'confirmed');
  assert.equal(remote.calls.filter(call => call.path.endsWith('/revoke')).length, 1);
  remote.setGrantHandler(() => ({ apiVersion: '1', memberId, active: [broad, broad], inactive: [] }));
  assert.equal((await backend.permissions.read(binding)).kind, 'unavailable');
});

test('Crew lost revoke ACK stays uncertain after list absence and host restart without another POST', async t => {
  const remote = await service(t, { standingGrants: standingCapability }), f = await fixture(t, [remote.extension()]), scope = await f.create();
  const conversationId = [...remote.conversations.keys()][0];
  remote.grants.push(activeGrant(conversationId), activeGrant(null));
  const listed = await f.client.conversationPermissions(scope);
  assert.equal(listed.permissions.length, 2);
  remote.setLost(true);
  const command = { version: 1, scope, clientCommandId: 'revoke', body: { kind: 'revoke-permission',
    permissionId: listed.permissions.find(row => row.scope === 'conversation').permissionId, scope: 'conversation' } };
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'uncertain');
  assert.deepEqual((await f.client.conversationPermissions(scope)).permissions.map(row => row.scope), ['agent']);
  remote.setLost(false);
  await f.restart([remote.extension()]);
  assert.equal((await f.client.reconcile(scope, 'revoke')).state.kind, 'uncertain');
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'uncertain');
  assert.equal(remote.calls.filter(call => call.path.endsWith('/revoke')).length, 1);
});

for (const reply of ['exact', 'wrong-choice', 'lost']) test(`Crew standing choice ${reply} acknowledgement preserves original decision`, async t => {
  const remote = await service(t, { standingGrants: standingCapability, approvalDetails: detailCapability });
  const f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(receipt.conversationId);
  const card = pendingCall(conversation, requestId); card.invocationId = requestId;
  remote.details.set(card.approvalId, ownerDetail(card)); remote.emit(receipt.conversationId);
  await until(() => saved(f).decisions.length === 1);
  const decision = JSON.parse(saved(f).decisions[0].data), choice = decision.choices.find(row => row.label.includes('allow work items'));
  if (reply === 'wrong-choice') remote.setDecisionReply({ decision: 'approve' });
  if (reply === 'lost') remote.setLost(true);
  const result = await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'standing',
    body: { kind: 'approve', pendingId: decision.visible.pendingId, choiceId: choice.id } });
  assert.equal(result.receipt.state.kind, reply === 'exact' ? 'completed' : 'uncertain');
  assert.equal(remote.calls.find(call => call.path.endsWith('/human')).input.choice, 'allow_conversation');
  if (reply !== 'exact') {
    remote.setLost(false);
    remote.grants.push(activeGrant(receipt.conversationId));
    assert.equal((await f.client.conversationPermissions(scope)).permissions.length, 1);
    assert.equal((await f.client.reconcile(scope, 'standing')).state.kind, 'uncertain');
  }
});

test('browser keeps permissions after run end and confirms member revocation across conversations', { timeout: 20_000 }, async t => {
  const remote = await service(t, { standingGrants: standingCapability }), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0];
  receipt.status = 'completed'; receipt.result = { text: 'Finished' }; remote.emit(receipt.conversationId);
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'ended');
  const narrow = activeGrant(receipt.conversationId), broad = activeGrant(null);
  remote.grants.push(narrow, broad, activeGrant(randomUUID()));
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: `A real provider reply · Open conversation ${scope.conversationId}`, exact: true }).click();
  const permissions = page.getByRole('region', { name: 'Permissions', exact: true });
  const revokeMember = permissions.getByRole('button', { name: 'Revoke for this member in all conversations', exact: true });
  await revokeMember.waitFor();
  assert.equal(await permissions.locator('h3').count(), 2);
  await revokeMember.click();
  assert.equal(remote.calls.filter(call => call.path.endsWith('/revoke')).length, 0);
  await permissions.getByRole('button', { name: 'Keep permission', exact: true }).click();
  await permissions.getByRole('button', { name: 'Revoke for this conversation', exact: true }).click();
  await until(() => narrow.status === 'revoked');
  await revokeMember.waitFor();
  await permissions.getByRole('button', { name: 'Revoke for this conversation', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await permissions.getByRole('button', { name: 'Revoke for this conversation', exact: true }).count(), 0);
  remote.setGrantHandler(() => ({ apiVersion: '1', memberId, active: [broad, broad], inactive: [] }));
  await permissions.getByRole('button', { name: 'Refresh permissions', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Permissions"]').textContent.includes('Provider permissions unavailable'));
  assert.equal(await revokeMember.isDisabled(), true);
  remote.setGrantHandler(undefined);
  await permissions.getByRole('button', { name: 'Refresh permissions', exact: true }).click();
  await revokeMember.click();
  await permissions.getByRole('button', { name: 'Confirm revoke in all conversations', exact: true }).click();
  await until(() => broad.status === 'revoked');
  await permissions.getByText('No active work-item permissions were found.', { exact: true }).waitFor();
  assert.equal(remote.calls.filter(call => call.path.endsWith('/revoke')).length, 2);
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, 1);
  assert.equal(requestId, receipt.requestId);
});

test('browser keeps an in-flight conversation revoke labelled until the next listing removes it', { timeout: 20_000 }, async t => {
  const remote = await service(t, { standingGrants: standingCapability }), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [, receipt] = [...remote.receipts][0];
  receipt.status = 'completed'; receipt.result = { text: 'Finished' }; remote.emit(receipt.conversationId);
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'ended');
  const narrow = activeGrant(receipt.conversationId), broad = activeGrant(null);
  remote.grants.push(narrow, broad);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: `A real provider reply · Open conversation ${scope.conversationId}`, exact: true }).click();
  const permissions = page.getByRole('region', { name: 'Permissions', exact: true });
  const revokeNarrow = permissions.getByRole('button', { name: 'Revoke for this conversation', exact: true });
  await revokeNarrow.waitFor();
  await page.evaluate(() => {
    const panel = document.querySelector('[aria-label="Permissions"]'), seen = window.revokeLabels = [];
    const record = () => {
      const labels = [...panel.querySelectorAll('button')].map(button => button.textContent).filter(label => label.startsWith('Revoke'));
      const next = labels.includes('Revoke for this conversation') ? 'present' : 'absent';
      if (seen.at(-1) !== next) seen.push(next);
      if (labels.includes('Revoke again') || panel.textContent.includes('acknowledgement is unknown')) window.revokeUnknown = true;
    };
    record(); new MutationObserver(record).observe(panel, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  let releaseRevoke, releaseListing;
  const revokeHeld = new Promise(resolve => { releaseRevoke = resolve; }), listingHeld = new Promise(resolve => { releaseListing = resolve; });
  remote.setRevokeHandler(async grant => { await revokeHeld; return grant; });
  await revokeNarrow.click();
  await until(() => narrow.status === 'revoked');
  remote.setGrantHandler(async () => { await listingHeld;
    return { apiVersion: '1', memberId, active: remote.grants.filter(row => row.status === 'active'), inactive: [] }; });
  const listings = () => remote.calls.filter(call => call.method === 'GET' && call.path.endsWith('/grants')).length, before = listings();
  assert.equal(await revokeNarrow.isDisabled(), true);
  releaseRevoke();
  await until(() => listings() > before);
  assert.equal(await revokeNarrow.isDisabled(), true);
  releaseListing();
  await revokeNarrow.waitFor({ state: 'detached' });
  await permissions.getByRole('button', { name: 'Revoke for this member in all conversations', exact: true }).waitFor();
  assert.equal(await revokeNarrow.count(), 0);
  assert.deepEqual(await page.evaluate(() => [window.revokeLabels, window.revokeUnknown ?? false]), [['present', 'absent'], false]);
});

test('Crew fresh active reading permits a deliberate new revoke while original ACK remains unknown', async t => {
  const remote = await service(t, { standingGrants: standingCapability }), f = await fixture(t, [remote.extension()]), scope = await f.create();
  remote.grants.push(activeGrant([...remote.conversations.keys()][0]));
  const [permission] = (await f.client.conversationPermissions(scope)).permissions;
  const command = { version: 1, scope, clientCommandId: 'original-revoke', body: { kind: 'revoke-permission',
    permissionId: permission.permissionId, scope: permission.scope } };
  remote.setLost('before-revoke');
  assert.equal((await f.client.conversation(scope).submit(command)).receipt.state.kind, 'uncertain');
  assert.equal((await f.client.conversationPermissions(scope)).permissions.length, 1);
  remote.setLost(false);
  assert.equal((await f.client.conversation(scope).submit({ ...command, clientCommandId: 'deliberate-revoke' })).receipt.state.kind, 'completed');
  assert.equal((await f.client.reconcile(scope, 'original-revoke')).state.kind, 'uncertain');
  assert.equal((await f.client.conversationPermissions(scope)).permissions.length, 0);
  assert.equal(remote.calls.filter(call => call.path.endsWith('/revoke')).length, 2);
});

for (const field of ['scope', 'conversationId', 'memberId', 'grantId']) {
  test(`Crew rejects mismatched revoke acknowledgement ${field} as uncertain`, async t => {
    const remote = await service(t, { standingGrants: standingCapability }), { backend, binding } = await direct(remote);
    t.after(() => backend.close());
    remote.grants.push(activeGrant(binding.authority.binding.opaqueSessionId));
    const [permission] = (await backend.permissions.read(binding)).permissions;
    remote.setRevokeHandler(grant => field === 'scope' ? { ...grant, scope: 'member', conversationId: null, choice: 'allow_always' }
      : { ...grant, [field]: randomUUID() });
    const result = await backend.permissions.revoke({ operationId: randomUUID(), binding, permission: permission.ref, scope: permission.scope });
    assert.equal(result.kind, 'uncertain');
    assert.equal(remote.calls.filter(call => call.path.endsWith('/revoke')).length, 1);
  });
}

test('Crew maps HTTP, transport and contract failures to typed provider failures without leaking details', async t => {
  let mode = { at: 'capabilities', status: 401 };
  const server = createServer((request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname, json = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
    };
    if (path === '/v1/capabilities' && mode.at !== 'capabilities') return json(200, { apiVersion: '1', requestContract: 'sql-admission-temporal-queue-v1',
      observation: { protocol: 'AG-UI', mode: 'snapshot-and-bounded-tail' }, initiatorKinds: ['owner'] });
    if (mode.status === 'protocol') return json(200, { apiVersion: '9' });
    if (mode.status === 'reset') { response.destroy(); return; }
    if (mode.status === 'missing member') return json(200, { apiVersion: '1', members: [], next: null });
    if (mode.status === 'pagination loop') return json(200, { apiVersion: '1', members: [], next: 'same-page' });
    return json(mode.status, { error: 'PRIVATE_CREW_FAILURE' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const instance = { namespace: 'crew', installationId: 'test', generation: 'one', protocolVersion: '1' };
  const { entry } = crewProvider({ service: `http://127.0.0.1:${server.address().port}`, memberId, instance });
  const activate = async use => {
    let provider;
    await entry.activate({ namespace: 'crew', providers: { add(_id, backend) { provider = backend; } }, credentials: { use } });
    return provider;
  };
  const provider = await activate((_request, action) => action('private-crew-test'));
  const credential = { kind: 'credential-handle', instance, hostId: 'test-host', opaqueHandle: 'test-handle' };
  const connect = (target = provider) => target.connect({ apiVersion: 1, instance, credential });
  for (const [status, kind] of [[401, 'authentication-failed'], [403, 'unauthorized'], [400, 'version-unsupported'], [404, 'version-unsupported'],
    [422, 'version-unsupported'], [408, 'unavailable'], [429, 'unavailable'],
    [500, 'unavailable'], [503, 'unavailable'], ['reset', 'unavailable'], ['protocol', 'version-unsupported']]) {
    mode = { at: 'capabilities', status };
    const refused = await connect();
    assert.equal(refused.kind, kind, `capabilities ${status}`); assert.doesNotMatch(refused.reason, /PRIVATE/);
    mode = { at: 'members', status };
    const connection = await connect();
    assert.equal(connection.kind, 'connected');
    const discovered = await connection.backend.discover();
    assert.equal(discovered.kind, kind, `members ${status}`); assert.doesNotMatch(discovered.reason, /PRIVATE/);
    await connection.backend.close();
  }
  mode = { at: 'members', status: 'pagination loop' };
  const paginated = await connect();
  const looped = await paginated.backend.discover();
  assert.equal(looped.kind, 'version-unsupported'); assert.doesNotMatch(looped.reason, /PRIVATE/);
  await paginated.backend.close();
  // The host classifies a thrown connect or discover as an invalid installation.
  mode = { at: 'members', status: 'missing member' };
  const missing = await connect();
  await assert.rejects(missing.backend.discover(), /^Error: Configured Crew member is not available$/);
  await missing.backend.close();
  await assert.rejects(provider.connect({ apiVersion: 1, instance, credential: null }), /^Error: Crew installation is misconfigured$/);
  const foreign = { ...instance, generation: 'other' };
  await assert.rejects(provider.connect({ apiVersion: 1, instance: foreign, credential }), /^Error: Crew installation is misconfigured$/);
  await assert.rejects(provider.connect({ apiVersion: 1, instance, credential: { ...credential, instance: foreign } }), /^Error: Crew installation is misconfigured$/);
  const refusal = new Error('Provider credential use refused');
  const withoutSecret = await activate(async () => { throw refusal; });
  await assert.rejects(connect(withoutSecret), error => error === refusal);
  let uses = 0;
  const revokedLater = await activate((_request, action) => ++uses === 1 ? action('private-crew-test') : Promise.reject(refusal));
  const connection = await connect(revokedLater);
  assert.equal(connection.kind, 'connected');
  await assert.rejects(connection.backend.discover(), error => error === refusal);
  await connection.backend.close();
});

test('Crew discovery, creation and host restart touch only the member, owned conversation and its observation, never a listing', async t => {
  const remote = await service(t), foreign = randomUUID();
  remote.conversations.set(foreign, { state: { conversationId: foreign, memberId, phase: 'idle' }, messages: [], cursor: 0 });
  const f = await fixture(t, [remote.extension()]);
  await f.create();
  await until(() => remote.streams.size === 1);
  const owned = remote.calls.find(call => call.method === 'POST' && call.path === '/v1/conversations').input.conversationId;
  const observe = `POST /v1/conversations/${owned}/events`, seen = calls => calls.map(call => `${call.method} ${call.path}`);
  assert.deepEqual(seen(remote.calls), ['GET /v1/capabilities', 'GET /v1/members', 'POST /v1/conversations', observe]);
  const before = remote.calls.length;
  await f.restart([remote.extension()]);
  await until(() => remote.streams.size === 1 && seen(remote.calls.slice(before)).includes(observe));
  assert.deepEqual(seen(remote.calls.slice(before)), ['GET /v1/capabilities', 'GET /v1/members', observe]);
});

const closure = (f, id = 'chat') => JSON.parse(saved(f, id).checkpoint.data).state.closure;
async function observationOf(f, scope, kind) {
  const deadline = Date.now() + 5000;
  let status = await f.client.providerObservation({ scope, action: 'read' });
  while (status.kind !== kind && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
    status = await f.client.providerObservation({ scope, action: 'read' });
  }
  return status;
}

for (const [phase, cause] of [['cancelled', 'cancelled'], ['failed', 'failed'], ['complete', 'exhausted']]) {
  test(`Crew ${phase} phase saves a ${cause} closure and reports the conversation concluded`, async t => {
    const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
    await until(() => remote.streams.size === 1);
    remote.end([...remote.conversations.keys()][0], phase);
    await until(() => closure(f) !== undefined);
    assert.deepEqual(closure(f), { cause });
    assert.deepEqual(await f.client.providerObservation({ scope, action: 'read' }), { kind: 'concluded', cause });
    assert.deepEqual(await f.client.providerObservation({ scope, action: 'retry' }), { kind: 'concluded', cause });
    await until(() => remote.streams.size === 0);
    assert.equal(remote.calls.filter(call => call.path.endsWith('/events')).length, 1);
  });
}

test('Crew concluded conversation stays concluded after restart without observing again', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await until(() => remote.streams.size === 1);
  remote.end([...remote.conversations.keys()][0], 'cancelled');
  await until(() => closure(f) !== undefined && remote.streams.size === 0);
  const observations = () => remote.calls.filter(call => call.path.endsWith('/events')).length, before = observations();
  await f.restart([remote.extension()]);
  assert.deepEqual(await f.client.providerObservation({ scope, action: 'read' }), { kind: 'concluded', cause: 'cancelled' });
  assert.deepEqual(await f.client.providerObservation({ scope, action: 'retry' }), { kind: 'concluded', cause: 'cancelled' });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(observations(), before);
  assert.equal(remote.streams.size, 0);
});

test('Crew terminal snapshot whose receipt read outlasts the stream still concludes', { timeout: 10_000 }, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0];
  await until(() => JSON.parse(saved(f).checkpoint.data).state.run?.requestId === requestId);
  const lookups = () => remote.calls.filter(call => call.method === 'GET' && call.path.endsWith(`/requests/${requestId}`)).length;
  const release = remote.holdReceipts(), before = lookups();
  remote.end(receipt.conversationId, 'cancelled');
  await until(() => remote.streams.size === 0 && lookups() > before);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(closure(f), undefined);
  release();
  await until(() => closure(f) !== undefined);
  assert.deepEqual(await f.client.providerObservation({ scope, action: 'read' }), { kind: 'concluded', cause: 'cancelled' });
});

test('Crew terminal snapshot whose receipt read fails stays stopped and retryable until a retry reads it', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [requestId, receipt] = [...remote.receipts][0];
  await until(() => JSON.parse(saved(f).checkpoint.data).state.run?.requestId === requestId);
  const lookups = () => remote.calls.filter(call => call.method === 'GET' && call.path.endsWith(`/requests/${requestId}`)).length;
  remote.setReceiptFailure(true);
  receipt.status = 'cancelled';
  const before = lookups();
  remote.end(receipt.conversationId, 'cancelled');
  assert.deepEqual(await observationOf(f, scope, 'stopped'), { kind: 'stopped', reason: 'provider-disconnected' });
  assert.ok(lookups() > before);
  assert.equal(closure(f), undefined);
  assert.equal(JSON.parse(saved(f).conversation.document).domain.currentRun.kind, 'running');
  remote.setReceiptFailure(false);
  await f.client.providerObservation({ scope, action: 'retry' });
  assert.deepEqual(await observationOf(f, scope, 'concluded'), { kind: 'concluded', cause: 'cancelled' });
  assert.deepEqual(closure(f), { cause: 'cancelled' });
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'ended');
});

test('Crew observation failure while running and a stream end while idle stay stopped and retryable', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await f.client.conversation(scope).submit(send(scope));
  const [, receipt] = [...remote.receipts][0], stopped = { kind: 'stopped', reason: 'provider-disconnected' };
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'running');
  remote.emit(receipt.conversationId, [{ type: 'RUN_ERROR', code: 'OBSERVATION_FAILED', message: 'Reconnect for the current conversation snapshot' }]);
  assert.deepEqual(await observationOf(f, scope, 'stopped'), stopped);
  assert.equal((await f.client.providerObservation({ scope, action: 'retry' })).kind, 'observing');
  await until(() => remote.streams.size === 1);
  remote.end(receipt.conversationId, 'idle');
  assert.deepEqual(await observationOf(f, scope, 'stopped'), stopped);
  assert.equal(closure(f), undefined);
  assert.equal((await f.client.providerObservation({ scope, action: 'retry' })).kind, 'observing');
});

test('Crew send after closure is refused without a request while an earlier command ID keeps its receipt', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  const port = f.client.conversation(scope), first = await port.submit(send(scope));
  assert.equal(first.receipt.state.kind, 'accepted');
  remote.end([...remote.receipts.values()][0].conversationId, 'cancelled');
  await until(() => closure(f) !== undefined);
  const refused = await port.submit(send(scope, 'after-closure'));
  assert.equal(refused.kind, 'rejected');
  assert.equal(refused.reason, 'conversation-closed');
  const retried = await port.submit(send(scope));
  assert.equal(retried.kind, 'receipt');
  assert.equal(retried.receipt.hostOperationId, first.receipt.hostOperationId);
  assert.equal((await port.receipt('send')).hostOperationId, first.receipt.hostOperationId);
  assert.equal(await port.receipt('after-closure'), null);
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, 1);
});

test('Crew submit refused by a handoff settles rejected while a conflict stays uncertain', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  const port = f.client.conversation(scope);
  for (const [code, state] of [['handed_off', 'rejected'], ['handoff_pending', 'rejected'], ['conflict', 'uncertain']]) {
    remote.setConflict(code);
    assert.equal((await port.submit(send(scope, code))).receipt.state.kind, state, code);
  }
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, 3);
});

test('Crew checkpoint saved before closure decodes unchanged and reports no closure', async t => {
  const remote = await service(t), { backend, binding, presentation } = await direct(remote);
  t.after(() => backend.close());
  const historical = { binding, messages: [], run: null };
  const state = presentation.decodeState(historical);
  assert.equal(JSON.stringify(state), JSON.stringify(historical));
  assert.equal(Object.hasOwn(state, 'closure'), false);
  assert.equal(presentation.closure(state), null);
  assert.deepEqual(presentation.closure(presentation.decodeState({ ...historical, closure: { cause: 'exhausted' } })), { cause: 'exhausted' });
  assert.throws(() => presentation.decodeState({ ...historical, closure: { cause: 'paused' } }));
  remote.conversations.get(binding.authority.binding.opaqueSessionId).state.phase = 'complete';
  const baseline = await backend.snapshot(binding);
  assert.equal(baseline.kind, 'available');
  assert.deepEqual(presentation.closure(baseline.snapshot.state), { cause: 'exhausted' });
});

test('browser shows a closed Crew conversation without Stop or an update check, even after failed or stopped status reads, and keeps the draft', { timeout: 20_000 }, async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]);
  const failed = await f.create('chat'), stopped = await f.create('stopped');
  const crew = id => f.inspect(db => JSON.parse(db.prepare('SELECT original FROM provider_creations WHERE conversation=?').get(id).original).intent.operationId);
  for (const scope of [failed, stopped]) await f.client.conversation(scope).submit(send(scope));
  const finished = [...remote.receipts.values()].find(receipt => receipt.conversationId === crew('chat'));
  finished.status = 'completed'; finished.result = { text: 'Finished' }; remote.emit(finished.conversationId);
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'ended');
  remote.end(crew('chat'), 'failed'); remote.end(crew('stopped'), 'cancelled');
  await until(() => closure(f) !== undefined && closure(f, 'stopped') !== undefined);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
  const open = scope => page.getByRole('button', { name: `A real provider reply · Open conversation ${scope.conversationId}`, exact: true }).click();
  const notice = cause => page.getByRole('status').filter({ hasText: `This conversation ended: ${cause}. Earlier messages and your draft stay available.` });
  await open(stopped);
  await notice('it was stopped').waitFor();
  assert.equal(JSON.parse(saved(f, 'stopped').conversation.document).domain.currentRun.kind, 'running');
  assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
  await open(failed);
  await notice('the provider reported a failure').waitFor();
  await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('A draft kept after closure');
  await page.getByRole('button', { name: /^Harness,/ }).and(page.locator(':enabled')).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Check for updates', exact: true }).count(), 0);
  assert.equal(await page.getByText('Updates paused').count(), 0);
  let statusReads = 0;
  // Later status reads first fail, then report the stopped status an extension refresh produces.
  await page.route('**/api/v1', route => {
    if (route.request().postDataJSON()?.op !== 'provider-observation') return route.continue();
    return statusReads++ % 2 ? route.fulfill({ contentType: 'application/json',
      body: JSON.stringify({ ok: true, value: { kind: 'stopped', reason: 'recovery-failed' } }) }) : route.abort();
  });
  await new Promise(resolve => setTimeout(resolve, 2_500));
  assert.equal(statusReads, 0);
  for (const [scope, cause, reads] of [[stopped, 'it was stopped', 1], [failed, 'the provider reported a failure', 2]]) {
    await open(scope);
    await until(() => statusReads === reads);
    await new Promise(resolve => setTimeout(resolve, 200));
    await notice(cause).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Stop', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Check for updates', exact: true }).count(), 0);
    assert.equal(await page.getByText('Updates paused').count(), 0);
    assert.equal(await page.getByText('Observation status unavailable').count(), 0);
  }
  await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  await page.waitForFunction(() => document.querySelector('textarea#message')?.value === 'A draft kept after closure');
  await page.getByRole('button', { name: /^Harness,/ }).and(page.locator(':enabled')).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  await page.unroute('**/api/v1');
  await page.reload();
  await open(failed);
  await notice('the provider reported a failure').waitFor();
  await page.waitForFunction(() => document.querySelector('textarea#message')?.value === 'A draft kept after closure');
  assert.equal(await page.getByRole('button', { name: 'Send', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Check for updates', exact: true }).count(), 0);
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, 2);
  assert.equal(remote.calls.filter(call => call.path.endsWith('/cancel')).length, 0);
});
