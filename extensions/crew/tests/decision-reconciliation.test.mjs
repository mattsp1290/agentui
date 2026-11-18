import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decide, decisionVerdict } from '../dist/provider-decisions.js';
import { connected, crewService } from './support/crew-service.mjs';
import { browserRequest, launchProcess, startup, within } from '../../../tests/application/support/host-process.mjs';

const token = 'private-crew-decision-token', memberId = randomUUID();
const instance = { namespace: 'crew', installationId: 'decisions', generation: 'one', protocolVersion: '1' };
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

/** A controlled Crew whose decision ledger follows Crew's decide settlement and decision-record rules. */
async function crew(t, { receipts = true } = {}) {
  const cards = new Map();
  const ledger = { effects: 0, mode: 'normal', read: 'normal', entered: Promise.withResolvers(), committed: Promise.withResolvers() };
  let remote;
  const withdraw = card => remote.withdraw(card.conversationId, card.approvalId);
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
  function human({ response, input, json }) {
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
  function decision({ response, url, parts, json }) {
    const card = cards.get(parts[7]);
    if (!receipts || !card || card.requestId !== parts[5] || url.searchParams.get('memberId') !== memberId ||
      url.searchParams.get('invocationId') !== card.invocationId || url.searchParams.get('version') !== '1') return json(404, { error: 'not_found' });
    switch (ledger.read) {
      case 'not-found': return json(404, { error: 'not_found' });
      case 'unavailable': return json(503, { error: 'unavailable' });
      case 'dropped': return response.destroy();
      case 'normal': return json(200, record(card));
    }
  }
  remote = await crewService(t, { memberId, token, instance, ...(receipts && { decisionReceipts: receiptsCapability }), intercept(context) {
    const { request, parts } = context;
    if (parts[4] === 'human') { human(context); return true; }
    if (request.method === 'GET' && parts[6] === 'approvals' && parts[8] === 'decision') { decision(context); return true; }
    return false;
  } });
  return { ...remote, cards, ledger, commit,
    close(card, reason) { card.closed = reason; withdraw(card); },
    posts: () => remote.calls.filter(call => call.method === 'POST' && call.path.endsWith('/human')),
    reads: () => remote.calls.filter(call => call.method === 'GET' && call.path.endsWith('/decision')),
    pend(conversationId, requestId) {
      const card = remote.pend(conversationId, { requestId, invocationId: randomUUID(), policyVersion: 1 });
      cards.set(card.approvalId, { ...card });
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
    child = launchProcess(t, ['extensions/crew/run.mjs', config]);
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
  await until(() => remote.receipts.size === 1);
  const [requestId] = remote.receipts.keys(), conversationId = [...remote.conversations.keys()][0];
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
  const id = randomUUID(), other = randomUUID(), approvalId = randomUUID();
  const base = { state: 'decided', choice: 'approve', recordedAt: null, effect: { kind: 'none' } };
  const named = { approvalId, choice: 'approve', decisionId: id }, unnamed = { approvalId, choice: 'approve', decisionId: null };
  const read = record => ({ kind: 'record', decisionId: id, record });
  const cases = [
    [{ kind: 'reply', approvalId, choice: 'approve' }, named, 'confirmed'],
    [{ kind: 'reply', approvalId, choice: 'approve' }, unnamed, 'confirmed'],
    [{ kind: 'reply', approvalId: other, choice: 'approve' }, named, 'uncertain'],
    [{ kind: 'reply', approvalId, choice: 'deny' }, named, 'uncertain'],
    [{ kind: 'refused', code: 'decision_conflict' }, named, 'rejected'],
    [{ kind: 'refused', code: 'decision_conflict' }, unnamed, 'uncertain'],
    [{ kind: 'refused', code: 'decision_unverifiable' }, named, 'uncertain'],
    [{ kind: 'refused', code: 'conflict' }, named, 'uncertain'],
    [{ kind: 'refused', code: 'unknown_approval' }, named, 'uncertain'],
    [{ kind: 'unread' }, unnamed, 'uncertain'],
    [read({ ...base, decisionId: id }), named, 'confirmed'],
    [read({ ...base, decisionId: id, choice: 'deny' }), named, 'uncertain'],
    [read({ ...base, decisionId: other }), named, 'rejected'],
    [read({ ...base, decisionId: null }), named, 'uncertain'],
    [read({ state: 'auto_approved', grantId: other }), named, 'rejected'],
    [read({ state: 'closed', reason: 'expired', closedAt: null }), named, 'rejected'],
    [read({ state: 'closed', reason: 'cancelled', closedAt: null }), named, 'rejected'],
    [read({ state: 'undecided' }), named, 'uncertain'],
  ];
  for (const [signal, expected, verdict] of cases) assert.equal(decisionVerdict(signal, expected), verdict, JSON.stringify(signal));
});

test('a rejected reconcile names the competing decision or closure rather than denying the choice applied', async () => {
  const identity = { conversationId: randomUUID(), memberId, requestId: randomUUID(), invocationId: randomUUID(), approvalId: randomUUID(), version: 1 };
  const request = { ...identity, choice: 'approve', decisionId: randomUUID() };
  for (const [record, crewState, reason] of [
    [{ state: 'decided', decisionId: randomUUID(), choice: 'approve', recordedAt: null, effect: { kind: 'none' } }, 'decided', /competing decision/],
    [{ state: 'auto_approved', grantId: randomUUID(), recordedAt: null }, 'auto_approved', /standing permission/],
    [{ state: 'closed', reason: 'expired', closedAt: null }, 'closed', /closed this card/],
  ]) {
    const outcome = await decide({ decisionRecord: async () => ({ ...identity, toolName: 'record_work_item', ...record }) }, request, false);
    assert.equal(outcome.kind, 'rejected');
    assert.match(outcome.reason, reason);
    assert.doesNotMatch(outcome.reason, /never applied/);
    assert.deepEqual(outcome.evidence, { approvalId: identity.approvalId, choice: 'approve', decisionId: request.decisionId, crew: crewState });
  }
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

for (const read of ['not-found', 'unavailable', 'dropped']) {
  test(`host killed before acceptance stays uncertain when the receipt read is ${read}`, slow, async t => {
    const remote = await crew(t), f = await harness(t, remote);
    remote.ledger.mode = 'hold-before-commit';
    await killAndRestart(f, remote, remote.ledger.entered.promise);
    remote.ledger.read = read;
    assert.equal((await f.reconcile()).state.kind, 'uncertain');
    assert.equal(f.pending(), 'reserved');
    assert(remote.reads().length >= 1);
    assert.deepEqual([remote.ledger.effects, remote.posts().length], [0, 1]);
  });
}

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
  return (await connected(remote)).backend;
}
