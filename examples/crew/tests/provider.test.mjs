import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { crewProvider } from '../dist/provider.js';
import { fixture, saved, send } from '../../../tests/application/provider-stream-fixture.mjs';
import { until } from '../../../tests/host/fixture.mjs';

const memberId = randomUUID();
async function service(t) {
  const calls = [], streams = new Set(), conversations = new Map(), receipts = new Map();
  let lost = false, observationMode = 'stream', conflict = false;
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
      return json(200, { approvalId: input.approvalId, decision: input.choice });
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
  return { calls, streams, conversations, receipts, emit, extension, setLost(value) { lost = value; }, setObservation(value) { observationMode = value; }, setConflict() { conflict = true; } };
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
    summary: 'Record one work item', choices: ['approve', 'deny'] };
  conversation.messages.push({ id: 'tool-message', role: 'assistant', content: '', toolCalls: [{ id: card.approvalId, type: 'function', function: { name: 'record_work_item', arguments: JSON.stringify({ text: 'Harmless owned fixture' }) } }] });
  conversation.state.pendingApprovals = [card]; remote.emit(conversationId);
  await until(() => saved(f).decisions.length === 1);
  const decision = JSON.parse(saved(f).decisions[0].data);
  const result = await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'approve',
    body: { kind: 'approve', pendingId: decision.visible.pendingId, choiceId: decision.choices[0].id } });
  assert.equal(result.receipt.state.kind, 'accepted');
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
  if (terminal === 'completed') receipt.result = { text: 'Finished' };
  remote.emit(receipt.conversationId);
  await until(() => JSON.parse(saved(f).conversation.document).domain.currentRun?.kind === 'ended');
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
