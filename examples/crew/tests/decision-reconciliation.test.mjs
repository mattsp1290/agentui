import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { crewProvider } from '../dist/provider.js';
import { decisionVerdict } from '../dist/provider-decisions.js';
import { browserRequest, launchProcess, startup, within } from '../../../tests/application/support/host-process.mjs';

const token = 'private-crew-decision-token', memberId = randomUUID();
const receiptsCapability = { version: 1, field: 'decisionId',
  route: '/v1/conversations/{conversationId}/requests/{requestId}/approvals/{approvalId}/decision',
  tools: ['record_work_item', 'choose_next_step'], replay: 'same-decision-id-and-choice',
  conflictCode: 'decision_conflict', unverifiableCode: 'decision_unverifiable' };

async function until(predicate, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('Condition timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

/** A controlled Crew with a decision ledger that follows Crew's decide settlement and decision-record rules. */
async function crew(t, { receipts = true } = {}) {
  const calls = [], conversations = new Map(), requests = new Map(), cards = new Map(), streams = new Set();
  const ledger = { effects: 0, mode: 'normal', entered: Promise.withResolvers(), committed: Promise.withResolvers() };
  const emit = conversationId => {
    const conversation = conversations.get(conversationId);
    for (const stream of streams) if (stream.conversationId === conversationId) for (const event of [
      { type: 'MESSAGES_SNAPSHOT', messages: conversation.messages }, { type: 'STATE_SNAPSHOT', snapshot: conversation.state }]) {
      stream.response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };
  const withdraw = card => {
    const conversation = conversations.get(card.conversationId);
    conversation.state.pendingApprovals = conversation.state.pendingApprovals.filter(row => row.approvalId !== card.approvalId);
    emit(card.conversationId);
  };
  const commit = (card, choice, decisionId) => {
    card.decision = { choice, decisionId };
    ledger.effects++;
    withdraw(card);
  };
  function settle(card, body) {
    if (card.decision) {
      const recorded = card.decision;
      if (body.decisionId === undefined) return recorded.choice === body.choice ? 'replay' : 'conflict';
      if (recorded.choice !== body.choice) return 'decision_conflict';
      if (recorded.decisionId === body.decisionId) return 'replay';
      return recorded.decisionId === null && !card.grantId ? 'decision_unverifiable' : 'decision_conflict';
    }
    if (card.grantId) return body.decisionId === undefined ? 'conflict' : 'decision_conflict';
    return card.closed ? 'conflict' : 'commit';
  }
  function record(card) {
    const base = { apiVersion: '1', conversationId: card.conversationId, memberId, requestId: card.requestId,
      invocationId: card.invocationId, approvalId: card.approvalId, version: 1, toolName: card.toolName };
    if (card.grantId) return { ...base, state: 'auto_approved', grantId: card.grantId, recordedAt: new Date().toISOString() };
    if (card.decision) return { ...base, state: 'decided', decisionId: card.decision.decisionId, choice: card.decision.choice,
      recordedAt: new Date().toISOString(), effect: { kind: 'none' } };
    if (card.closed) return { ...base, state: 'closed', reason: card.closed, closedAt: card.closed === 'expired' ? new Date().toISOString() : null };
    return { ...base, state: 'undecided' };
  }
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let text = ''; for await (const chunk of request) text += chunk;
    const url = new URL(request.url, 'http://localhost'), path = url.pathname, parts = path.split('/');
    const input = text ? JSON.parse(text) : null;
    calls.push({ method: request.method, path, input });
    const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (path === '/v1/capabilities') return json(200, { apiVersion: '1', requestContract: 'sql-admission-temporal-queue-v1',
      observation: { protocol: 'AG-UI', mode: 'snapshot-and-bounded-tail' }, initiatorKinds: ['owner'],
      ...(receipts && { decisionReceipts: receiptsCapability }) });
    if (path === '/v1/members') return json(200, { apiVersion: '1', members: [{ memberId, engine: 'codex', profile: 'test' }], next: null });
    if (request.method === 'POST' && path === '/v1/conversations') {
      conversations.set(input.conversationId, { state: { conversationId: input.conversationId, memberId, engine: 'codex', profile: 'test',
        phase: 'idle', openStep: null, pendingApprovals: [] }, messages: [], cursor: 0, openTools: {}, openText: null, childText: {} });
      return json(201, { apiVersion: '1', ...conversations.get(input.conversationId) });
    }
    const conversation = conversations.get(parts[3]);
    if (!conversation) return json(404, { error: 'not_found' });
    if (parts.length === 4) return json(200, { apiVersion: '1', ...conversation });
    if (parts[4] === 'events') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const stream = { conversationId: parts[3], response };
      streams.add(stream); response.on('close', () => streams.delete(stream));
      for (const event of [{ type: 'RUN_STARTED', threadId: parts[3], runId: randomUUID() },
        { type: 'MESSAGES_SNAPSHOT', messages: conversation.messages }, { type: 'STATE_SNAPSHOT', snapshot: conversation.state }]) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      return;
    }
    if (parts[4] === 'human') {
      if (input.decisionId !== undefined && !receipts) return json(400, { error: 'invalid_input' });
      const card = cards.get(input.approvalId);
      if (!card) return json(409, { error: 'unknown_approval' });
      ledger.entered.resolve();
      if (ledger.mode === 'hold-before-commit' || ledger.mode === 'drop-before-commit') {
        if (ledger.mode === 'drop-before-commit') response.destroy();
        return;
      }
      const settlement = settle(card, input);
      if (settlement === 'commit') commit(card, input.choice, input.decisionId ?? null);
      else if (settlement !== 'replay') return json(409, { error: settlement });
      ledger.committed.resolve();
      if (ledger.mode === 'hold-after-commit') return;
      if (ledger.mode === 'drop-after-commit') { ledger.mode = 'normal'; response.destroy(); return; }
      return json(200, { approvalId: input.approvalId, decision: input.choice, ...(input.decisionId !== undefined && { decisionId: input.decisionId }) });
    }
    if (request.method === 'GET' && parts[6] === 'approvals' && parts[8] === 'decision') {
      const card = cards.get(parts[7]);
      if (!receipts || !card || card.requestId !== parts[5] || url.searchParams.get('memberId') !== memberId ||
        url.searchParams.get('invocationId') !== card.invocationId || url.searchParams.get('version') !== '1') return json(404, { error: 'not_found' });
      return json(200, record(card));
    }
    if (request.method === 'GET') return requests.has(parts[5]) ? json(200, requests.get(parts[5])) : json(404, { error: 'not_found' });
    const receipt = { apiVersion: '1', conversationId: parts[3], requestId: input.requestId,
      acceptance: { boundary: 'sql_admission_and_temporal_queue' }, status: 'accepted' };
    requests.set(input.requestId, receipt);
    conversation.messages.push({ id: input.requestId, role: 'user', content: input.text });
    conversation.state.phase = 'running'; emit(parts[3]);
    return json(202, receipt);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, calls, conversations, requests, cards, ledger, commit,
    close(card, reason) { card.closed = reason; withdraw(card); },
    posts: () => calls.filter(call => call.method === 'POST' && call.path.endsWith('/human')),
    reads: () => calls.filter(call => call.method === 'GET' && call.path.endsWith('/decision')),
    pend(conversationId, requestId) {
      const conversation = conversations.get(conversationId);
      const card = { conversationId, memberId, requestId, invocationId: randomUUID(), approvalId: randomUUID(), version: 1,
        policyVersion: 1, toolName: 'record_work_item', summary: 'Record one work item', choices: ['approve', 'deny'], argumentsComplete: true };
      conversation.messages.push({ id: `${card.approvalId}/call`, role: 'assistant', content: '', toolCalls: [{ id: card.approvalId,
        type: 'function', function: { name: 'record_work_item', arguments: JSON.stringify({ operation_id: requestId }) } }] });
      conversation.state.pendingApprovals = [card];
      cards.set(card.approvalId, { ...card });
      emit(conversationId);
      return cards.get(card.approvalId);
    },
  };
}

/** The Crew launcher as a child process over one persistent host directory, restartable after SIGKILL. */
async function harness(t, remote) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-crew-decisions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hostDirectory = join(directory, 'host'), tokenFile = join(directory, 'token'), config = join(directory, 'crew-provider.json');
  await writeFile(tokenFile, token, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ service: remote.origin, memberId, installationId: 'decisions', generation: 'one',
    credentialRevision: 'one', tokenFile, directory: hostDirectory, port: 0 }), { mode: 0o600 });
  let child, origin;
  const start = async () => {
    child = launchProcess(t, ['examples/crew/run.mjs', config]);
    const ready = await startup(child, line => {
      const match = /^AgentUI with Crew is ready at (http:\/\/[^/]+)\/browser\.html$/.exec(line);
      return match && { origin: match[1] };
    });
    assert.equal(ready.kind, 'ready', child.stderr);
    origin = ready.origin;
  };
  await start();
  const api = async body => {
    const result = await browserRequest(origin, body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.value;
  };
  const inspect = action => {
    const db = new DatabaseSync(join(hostDirectory, 'host.sqlite'), { readOnly: true });
    try { return action(db); } finally { db.close(); }
  };
  const { hostId, agents } = await api({ op: 'metadata' });
  const scope = { hostId, conversationId: 'chat' };
  await api({ op: 'create', scope, agentId: agents.find(agent => agent.kind === 'provider').id });
  await api({ op: 'submit', command: { version: 1, scope, clientCommandId: 'send', body: { kind: 'send', text: 'Record one item' } } });
  await until(() => remote.requests.size === 1);
  const [requestId] = remote.requests.keys(), conversationId = [...remote.conversations.keys()][0];
  await until(() => inspect(db => db.prepare("SELECT 1 FROM runs WHERE conversation='chat'").get()));
  const card = remote.pend(conversationId, requestId);
  await until(() => inspect(db => db.prepare("SELECT 1 FROM pending_decisions WHERE conversation='chat'").get()));
  const decision = JSON.parse(inspect(db => db.prepare("SELECT data FROM pending_decisions WHERE conversation='chat'").get().data));
  const approve = { version: 1, scope, clientCommandId: 'approve',
    body: { kind: 'approve', pendingId: decision.visible.pendingId, choiceId: decision.choices[0].id } };
  return { card, scope, approve, inspect, start, api,
    submit: () => api({ op: 'submit', command: approve }).then(value => value.receipt),
    dispatch: () => browserRequest(origin, { op: 'submit', command: approve }).catch(error => error),
    reconcile: () => api({ op: 'reconcile', scope, id: 'approve' }),
    operationId: () => inspect(db => db.prepare("SELECT operation FROM commands WHERE conversation='chat' AND id='approve'").get().operation),
    pending: () => inspect(db => db.prepare("SELECT status FROM pending_decisions WHERE conversation='chat'").get().status),
    async kill() { child.process.kill('SIGKILL'); assert.equal((await child.exited).signal, 'SIGKILL'); },
  };
}

async function killAndRestart(f, remote, waitFor, whileDown = () => {}) {
  const dispatched = f.dispatch();
  await within(waitFor, 'Crew decide entry');
  await f.kill();
  await dispatched;
  remote.ledger.mode = 'normal';
  whileDown(remote.cards.get(f.card.approvalId));
  return f.start();
}

test('decision verdict table follows Crew decision-receipt semantics', () => {
  const id = randomUUID(), other = randomUUID(), base = { state: 'decided', choice: 'approve', recordedAt: null, effect: { kind: 'none' } };
  const named = { choice: 'approve', decisionId: id }, unnamed = { choice: 'approve', decisionId: null };
  const cases = [
    [{ kind: 'reply' }, named, 'confirmed'],
    [{ kind: 'refused', code: 'decision_conflict' }, named, 'rejected'],
    [{ kind: 'refused', code: 'decision_conflict' }, unnamed, 'uncertain'],
    [{ kind: 'refused', code: 'decision_unverifiable' }, named, 'uncertain'],
    [{ kind: 'refused', code: 'conflict' }, named, 'uncertain'],
    [{ kind: 'refused', code: 'unknown_approval' }, named, 'uncertain'],
    [{ kind: 'record', record: { ...base, decisionId: id } }, named, 'confirmed'],
    [{ kind: 'record', record: { ...base, decisionId: id, choice: 'deny' } }, named, 'uncertain'],
    [{ kind: 'record', record: { ...base, decisionId: other } }, named, 'rejected'],
    [{ kind: 'record', record: { ...base, decisionId: other } }, unnamed, 'rejected'],
    [{ kind: 'record', record: { ...base, decisionId: null } }, named, 'uncertain'],
    [{ kind: 'record', record: { state: 'auto_approved', grantId: other } }, named, 'rejected'],
    [{ kind: 'record', record: { state: 'closed', reason: 'expired', closedAt: null } }, named, 'rejected'],
    [{ kind: 'record', record: { state: 'closed', reason: 'cancelled', closedAt: null } }, named, 'rejected'],
    [{ kind: 'record', record: { state: 'undecided' } }, named, 'uncertain'],
  ];
  for (const [signal, expected, verdict] of cases) assert.equal(decisionVerdict(signal, expected), verdict, JSON.stringify(signal));
});

const slow = { timeout: 60_000 };

test('host killed after Crew accepted a named decision reconciles it as confirmed with one effect and one POST', slow, async t => {
  const remote = await crew(t), f = await harness(t, remote);
  remote.ledger.mode = 'hold-after-commit';
  await killAndRestart(f, remote, remote.ledger.committed.promise);
  const operationId = f.operationId();
  assert.equal(remote.posts()[0].input.decisionId, operationId);
  assert.equal((await f.reconcile()).state.kind, 'completed');
  assert.equal(f.pending(), 'closed');
  assert.deepEqual([remote.ledger.effects, remote.posts().length], [1, 1]);
  assert(remote.reads().length >= 1);
  assert.deepEqual(remote.cards.get(f.card.approvalId).decision, { choice: 'approve', decisionId: operationId });
});

test('a dropped decide reply without a crash reconciles as confirmed', slow, async t => {
  const remote = await crew(t), f = await harness(t, remote);
  remote.ledger.mode = 'drop-after-commit';
  assert.equal((await f.submit()).state.kind, 'uncertain');
  assert.equal(f.pending(), 'reserved');
  assert.equal((await f.reconcile()).state.kind, 'completed');
  assert.deepEqual([remote.ledger.effects, remote.posts().length], [1, 1]);
});

test('host killed before Crew accepted stays uncertain without auto-retry; an explicit same-id retry has exactly one effect', slow, async t => {
  const remote = await crew(t), f = await harness(t, remote);
  remote.ledger.mode = 'hold-before-commit';
  await killAndRestart(f, remote, remote.ledger.entered.promise);
  assert.equal((await f.reconcile()).state.kind, 'uncertain');
  assert.equal((await f.submit()).state.kind, 'uncertain', 'the host never dispatches a command id twice');
  assert.deepEqual([remote.ledger.effects, remote.posts().length, f.pending()], [0, 1, 'reserved']);
  const target = JSON.parse(f.inspect(db => db.prepare("SELECT target FROM commands WHERE conversation='chat' AND id='approve'").get().target));
  const { kind, operationId, binding, decision, choice } = target.operation;
  const retry = await direct(remote);
  t.after(() => retry.close());
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await retry.submit({ kind, operationId, binding, decision, choice });
    assert.equal(outcome.kind, 'confirmed');
    assert.deepEqual(outcome.evidence, { approvalId: f.card.approvalId, choice: 'approve', decisionId: operationId });
  }
  assert.deepEqual([remote.ledger.effects, remote.posts().length], [1, 3]);
  assert.equal(new Set(remote.posts().map(call => call.input.decisionId)).size, 1);
  assert.equal((await f.reconcile()).state.kind, 'completed');
  assert.equal(f.pending(), 'closed');
});

for (const [name, change, effects] of [
  ['a competing decision won', (remote, card) => remote.commit(card, 'approve', randomUUID()), 1],
  ['the card expired', (remote, card) => remote.close(card, 'expired'), 0],
]) test(`host killed before acceptance reconciles as rejected when ${name} while it was down`, slow, async t => {
  const remote = await crew(t), f = await harness(t, remote);
  remote.ledger.mode = 'hold-before-commit';
  await killAndRestart(f, remote, remote.ledger.entered.promise, card => change(remote, card));
  const receipt = await f.reconcile();
  assert.deepEqual(receipt.state, { kind: 'rejected', reason: 'provider-rejected' });
  assert.deepEqual([remote.ledger.effects, remote.posts().length], [effects, 1]);
  const observation = JSON.parse(f.inspect(db => db.prepare("SELECT observation FROM commands WHERE conversation='chat' AND id='approve'").get().observation));
  assert.equal(observation.evidence.source.data.crew, effects ? 'decided' : 'closed');
});

test('without the decisionReceipts capability a post-acceptance crash stays uncertain and never reads a receipt', slow, async t => {
  const remote = await crew(t, { receipts: false }), f = await harness(t, remote);
  remote.ledger.mode = 'hold-after-commit';
  await killAndRestart(f, remote, remote.ledger.committed.promise);
  assert.equal((await f.reconcile()).state.kind, 'uncertain');
  assert.equal(f.pending(), 'reserved');
  assert.equal(Object.hasOwn(remote.posts()[0].input, 'decisionId'), false);
  assert.deepEqual([remote.ledger.effects, remote.posts().length, remote.reads().length], [1, 1, 0]);
  assert.equal(remote.calls.some(call => call.path.includes('/approvals/')), false);
});

for (const [code, state, recorded] of [
  ['decision_conflict', 'rejected', () => ({ choice: 'approve', decisionId: randomUUID() })],
  ['decision_unverifiable', 'uncertain', () => ({ choice: 'approve', decisionId: null })],
]) test(`a fresh named decide refused with ${code} settles ${state}`, slow, async t => {
  const remote = await crew(t), f = await harness(t, remote);
  remote.cards.get(f.card.approvalId).decision = recorded();
  remote.ledger.effects++;
  const receipt = await f.submit();
  assert.equal(receipt.state.kind, state);
  assert.equal(remote.posts()[0].input.decisionId, f.operationId());
  assert.deepEqual([remote.ledger.effects, remote.posts().length, remote.reads().length], [1, 1, 0]);
  assert.equal(f.pending(), state === 'rejected' ? 'open' : 'reserved');
});

async function direct(remote) {
  const instance = { namespace: 'crew', installationId: 'decisions', generation: 'one', protocolVersion: '1' };
  let provider;
  await crewProvider({ service: remote.origin, memberId, instance }).entry.activate({ namespace: 'crew',
    providers: { add(_id, backend) { provider = backend; } }, credentials: { use: (_request, action) => action(token) } });
  const result = await provider.connect({ apiVersion: 1, instance,
    credential: { kind: 'credential-handle', instance, hostId: 'test-host', opaqueHandle: 'test-handle' } });
  assert.equal(result.kind, 'connected');
  return result.backend;
}
