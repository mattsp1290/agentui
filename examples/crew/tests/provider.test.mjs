import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { crewProvider } from '../dist/provider.js';
import { fixture, saved, send } from '../../../tests/application/provider-stream-fixture.mjs';
import { until } from '../../../tests/host/fixture.mjs';

const memberId = randomUUID();
async function service(t) {
  const calls = [], streams = new Set(), conversations = new Map(), receipts = new Map();
  let lost = false, observationMode = 'stream', conflict = false, decisionReply = {};
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer private-crew-test');
    let text = ''; for await (const chunk of request) text += chunk;
    const input = text ? JSON.parse(text) : null, path = new URL(request.url, 'http://localhost').pathname;
    calls.push({ method: request.method, path, input });
    const parts = path.split('/'), conversationId = parts[3], requestId = parts[5];
    const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (path === '/v1/capabilities') return json(200, { apiVersion: '1', requestContract: 'sql-admission-temporal-queue-v1',
      observation: { protocol: 'AG-UI', mode: 'snapshot-and-bounded-tail' }, initiatorKinds: ['owner'] });
    if (path === '/v1/members') return json(200, { apiVersion: '1', members: [{ memberId, engine: 'codex', profile: 'test' }], next: null });
    if (path === '/v1/conversations') {
      conversations.set(input.conversationId, { state: { conversationId: input.conversationId, memberId, engine: 'codex', profile: 'test',
        phase: 'idle', openStep: null, pendingApprovals: [] }, messages: [], cursor: 0, openTools: {}, openText: null, childText: {} });
      return json(201, { apiVersion: '1', ...conversations.get(input.conversationId) });
    }
    const conversation = conversations.get(conversationId);
    if (!conversation) return json(404, { error: 'not_found' });
    if (parts.length === 4) return json(200, { apiVersion: '1', ...conversation });
    if (parts[4] === 'events') {
      if (observationMode === 'redirect') { response.writeHead(302, { location: '/v1/capabilities' }); response.end(); return; }
      if (observationMode === 'oversized') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(':' + 'x'.repeat(9 * 1024 * 1024) + '\n\n'); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const stream = { conversationId, response }; streams.add(stream); response.on('close', () => streams.delete(stream));
      for (const event of [{ type: 'RUN_STARTED', threadId: conversationId, runId: randomUUID() },
        { type: 'MESSAGES_SNAPSHOT', messages: conversation.messages }, { type: 'STATE_SNAPSHOT', snapshot: conversation.state }]) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      return;
    }
    if (parts[4] === 'human') {
      if (lost) { response.destroy(); return; }
      return json(200, { approvalId: input.approvalId, decision: input.choice, ...decisionReply });
    }
    if (request.method === 'GET') return receipts.has(requestId) ? json(200, receipts.get(requestId)) : json(404, { error: 'not_found' });
    if (parts[6] === 'cancel') {
      const receipt = { ...receipts.get(requestId), status: 'cancellation_requested', cancellation: {
        receiptId: randomUUID(), delivery: 'pending', nativeTermination: 'unconfirmed', effects: 'not_assessed' } };
      receipts.set(requestId, receipt); return json(202, receipt);
    }
    if (conflict) return json(409, { error: 'request_conflict' });
    const receipt = { apiVersion: '1', conversationId, requestId: input.requestId,
      acceptance: { boundary: 'sql_admission_and_temporal_queue' }, status: 'accepted' };
    receipts.set(input.requestId, receipt);
    conversation.messages.push({ id: input.requestId, role: 'user', content: input.text });
    conversation.state.phase = 'running'; emit(conversationId);
    if (lost) response.destroy(); else json(202, receipt);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  function emit(conversationId, events) {
    const conversation = conversations.get(conversationId);
    for (const { response, conversationId: id } of streams) if (id === conversationId) {
      for (const event of events ?? [{ type: 'MESSAGES_SNAPSHOT', messages: conversation.messages },
        { type: 'STATE_SNAPSHOT', snapshot: conversation.state }]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  const instance = { namespace: 'crew', installationId: 'test', generation: 'one', protocolVersion: '1' };
  const extension = () => ({ value: { ...crewProvider({ service: origin, memberId, instance }), installations: [
    { id: 'member', instance, service: origin, expectedAuthority: 'remote-provider', authentication: {
      kind: 'secret', revision: 'one', resolve: async () => 'private-crew-test' } }] } });
  return { calls, streams, conversations, receipts, emit, extension, setDecisionReply(value) { decisionReply = value; }, setLost(value) { lost = value; }, setObservation(value) { observationMode = value; }, setConflict() { conflict = true; } };
}

test('Crew public entry creates, observes actual SSE text, approves, stops and replaces its baseline on SQLite reopen', async t => {
  const remote = await service(t), f = await fixture(t, [remote.extension()]), scope = await f.create();
  await until(() => remote.streams.size === 1);
  const conversationId = [...remote.conversations.keys()][0];
  const creation = f.inspect(db => JSON.parse(db.prepare('SELECT original FROM provider_creations').get().original));
  assert.equal(conversationId, creation.intent.operationId);
  assert.equal((await f.client.conversation(scope).submit(send(scope))).receipt.state.kind, 'accepted');
  const [requestId, receipt] = [...remote.receipts][0], conversation = remote.conversations.get(conversationId);
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'running');
  const card = { conversationId, memberId, requestId, invocationId: requestId, approvalId: randomUUID(), version: 1,
    toolName: 'record_work_item', argumentsComplete: true, summary: 'Record one work item', choices: ['approve', 'deny'] };
  conversation.messages.push({ id: 'tool-message', role: 'assistant', content: '', toolCalls: [{ id: card.approvalId, type: 'function', function: { name: 'record_work_item', arguments: JSON.stringify({ operation_id: requestId }) } }] });
  conversation.state.pendingApprovals = [card]; remote.emit(conversationId);
  await until(() => saved(f).decisions.length === 1);
  const decision = JSON.parse(saved(f).decisions[0].data);
  const result = await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'approve',
    body: { kind: 'approve', pendingId: decision.visible.pendingId, choiceId: decision.choices[0].id } });
  assert.equal(result.receipt.state.kind, 'completed');
  assert.equal(remote.calls.find(call => call.path.endsWith('/human')).input.requestId, requestId);
  conversation.state.pendingApprovals = []; remote.emit(conversationId);
  const runId = JSON.parse(saved(f).conversation.document).domain.currentRun.runId;
  const stopped = await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'stop', body: { kind: 'cancel', runId } });
  assert.equal(stopped.receipt.state.kind, 'accepted');
  remote.emit(conversationId, [{ type: 'TEXT_MESSAGE_START', messageId: `${requestId}/item/0`, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: `${requestId}/item/0`, delta: 'Public Crew reply' },
    { type: 'TEXT_MESSAGE_END', messageId: `${requestId}/item/0` }]);
  conversation.messages.push({ id: `${requestId}/item/0`, role: 'assistant', content: 'Public Crew reply' });
  receipt.status = 'completed'; receipt.result = { text: 'Public Crew reply' }; remote.receipts.set(requestId, receipt);
  conversation.state.phase = 'idle'; remote.emit(conversationId);
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.outcome === 'completed');
  const before = JSON.parse(saved(f).checkpoint.data).cursor;
  await f.restart([remote.extension()]);
  await until(() => remote.streams.size === 1 && JSON.parse(saved(f).checkpoint.data).cursor.opaque.epoch !== before.opaque.epoch);
  assert.equal(JSON.parse(saved(f).conversation.document).domain.messages.at(-1).text, 'Public Crew reply');
  assert.equal(remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/requests')).length, 1);
  assert.equal(remote.calls.filter(call => call.path.endsWith('/cancel')).length, 1);
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
  const { value } = remote.extension(), installation = value.installations[0];
  let provider;
  await value.entry.activate({ namespace: 'crew', providers: { add(_id, backend) { provider = backend; } },
    credentials: { use: (_request, action) => action('private-crew-test') } });
  const result = await provider.connect({ apiVersion: 1, instance: installation.instance,
    credential: { kind: 'credential-handle', instance: installation.instance, hostId: 'test-host', opaqueHandle: 'test-handle' } });
  assert.equal(result.kind, 'connected');
  const backend = result.backend, operation = { kind: 'create', operationId: randomUUID(), scope: { hostId: 'test-host', conversationId: 'chat' },
    agent: (await backend.discover()).agents[0].ref };
  const created = await backend.create(operation);
  assert.equal(created.kind, 'confirmed');
  return { backend, binding: created.value };
}

for (const trigger of ['host shutdown', 'discovery failure']) test(`${trigger} drains a Crew baseline observer before observation admission`, { timeout: 5000 }, async t => {
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
    let discovery;
    if (trigger === 'discovery failure') {
      failDiscovery = true;
      discovery = assert.rejects(f.running.discoverProviders(), /Provider discovery failed/);
      await new Promise(resolve => setImmediate(resolve));
    }
    const closing = f.running.close().then(() => { closed = true; });
    release.resolve();
    await creating;
    await until(() => closed);
    await closing;
    await discovery;
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
  const before = remote.calls.length;
  assert.equal((await f.client.reconcile(scope, 'send')).state.kind, 'completed');
  assert(remote.calls.slice(before).every(call => call.method === 'GET'));
  assert(remote.calls.slice(before).some(call => call.path.endsWith(requestId)));
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
  const before = JSON.parse(saved(f).checkpoint.data).cursor.opaque.sequence;
  remote.emit(receipt.conversationId);
  await until(() => JSON.parse(saved(f).checkpoint.data).cursor.opaque.sequence > before);
  const assertObserved = () => {
    const state = saved(f), run = JSON.parse(state.checkpoint.data).state.run;
    assert.deepEqual(run, { requestId, status: 'uncertain', ...(stopped.cancellation && { cancellation: stopped.cancellation }) });
    assert.deepEqual(JSON.parse(state.conversation.document).domain.currentRun, termination === 'confirmed'
      ? { kind: 'ended', runId, outcome: 'interrupted' } : { kind: 'running', runId });
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
    assert.equal((await f.client.conversation(scope).submit(send(scope, 'blocked'))).kind, 'refused');
    return;
  }
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  const [name, value] = f.cookie.split('='); await context.addCookies([{ name, value, url: f.running.origin }]);
  const page = await context.newPage(); page.setDefaultTimeout(5000); await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: `A real provider reply · Open conversation ${scope.conversationId}`, exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Conversation connected' }).first().waitFor();
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('A distinct next request');
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
