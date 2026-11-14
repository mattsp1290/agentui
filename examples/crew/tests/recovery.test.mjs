import assert from 'node:assert/strict';
import test from 'node:test';
import { CrewHttpError, CrewUnknownOutcomeError } from '@birbcrew/client';
import { fixture } from './http-fixture.mjs';

const refusal = (status = 409) => ({ status, code: status === 409 ? 'conversation_busy' : 'access_denied' });

test('initial refusal is durable and a corrected send uses a new UUID', async t => {
  const f = await fixture(t), conversation = await f.open();
  f.state.refusal = refusal();
  await assert.rejects(conversation.send('rejected input'), CrewHttpError);
  const rejected = conversation.intent();
  assert.deepEqual(rejected.outcome, { kind: 'rejected', ...refusal() });
  assert.equal(f.state.entries, 0);
  const reopened = await f.open();
  assert.deepEqual(reopened.intent(), rejected);
  f.state.refusal = null;
  const receipt = await reopened.send('corrected input');
  assert.notEqual(receipt.requestId, rejected.command.requestId);
  assert.equal(f.state.entries, 1);
});

test('lost reply then retry refusal cannot release the original identity after reopening', async t => {
  const f = await fixture(t), conversation = await f.open();
  f.state.dropReply = true;
  await assert.rejects(conversation.send('one effect'), CrewUnknownOutcomeError);
  const original = conversation.intent();
  f.state.refusal = refusal(403);
  await assert.rejects(conversation.retry(), error => error instanceof CrewHttpError && error.status === 403);
  assert.deepEqual(conversation.intent(), original);
  const reopened = await f.open();
  await assert.rejects(reopened.send('must stay blocked'), /original Crew request/);
  assert.deepEqual(reopened.intent(), original);
  assert.equal(f.state.entries, 1);
  const posts = f.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body, posts[0].body);
});

test('retry invalidates a prior rejection durably before a newly lost reply', async t => {
  const f = await fixture(t), conversation = await f.open();
  f.state.refusal = refusal();
  await assert.rejects(conversation.send('same original request'), CrewHttpError);
  const command = conversation.intent().command;
  f.state.refusal = null;
  f.state.dropReply = true;
  const save = f.intents.save.bind(f.intents);
  let invalidated = false;
  f.intents.save = async record => {
    assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
    assert.deepEqual(record.outcome, { kind: 'unresolved' });
    await save(record);
    invalidated = true;
  };
  await assert.rejects(conversation.retry(), CrewUnknownOutcomeError);
  assert.equal(invalidated, true);
  f.intents.save = save;
  const reopened = await f.open();
  assert.deepEqual(reopened.intent().command, command);
  assert.deepEqual(reopened.intent().outcome, { kind: 'unresolved' });
  await assert.rejects(reopened.send('must stay blocked'), /original Crew request/);
  assert.equal(f.state.entries, 1);
});

test('failed rejection invalidation prevents retry dispatch and retains the previous known outcome', async t => {
  const f = await fixture(t), conversation = await f.open();
  f.state.refusal = refusal();
  await assert.rejects(conversation.send('rejected'), CrewHttpError);
  const before = conversation.intent();
  f.intents.save = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(conversation.retry(), /storage unavailable/);
  assert.deepEqual(conversation.intent(), before);
  assert.deepEqual((await f.open()).intent(), before);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
});

test('failed rejection persistence leaves the original intent recoverable', async t => {
  const f = await fixture(t), conversation = await f.open();
  const save = f.intents.save.bind(f.intents);
  f.intents.save = async record => {
    if (record.outcome.kind === 'rejected') throw new Error('settlement save failed');
    await save(record);
  };
  f.state.refusal = refusal();
  await assert.rejects(conversation.send('retain this identity'), /settlement save failed/);
  const reopened = await f.open();
  assert.deepEqual(reopened.intent().outcome, { kind: 'unresolved' });
  await assert.rejects(reopened.send('blocked'), /original Crew request/);
  f.state.refusal = null;
  assert.equal((await reopened.retry()).requestId, reopened.intent().command.requestId);
});

test('submit refusal never replaces an observed receipt with a no-admission claim', async t => {
  for (const status of ['completed', 'uncertain']) {
    const f = await fixture(t), conversation = await f.open();
    f.state.status = status;
    await conversation.send('observed outcome');
    const before = conversation.intent();
    f.state.refusal = refusal(403);
    await assert.rejects(conversation.retry(), CrewHttpError);
    assert.deepEqual(conversation.intent(), before);
    const reopened = await f.open();
    assert.deepEqual(reopened.intent(), before);
    if (status === 'uncertain') await assert.rejects(reopened.send('blocked'), /original Crew request/);
  }
});

test('uncertain receipt blocks new work until authoritative reconciliation resolves it', async t => {
  const f = await fixture(t), conversation = await f.open();
  f.state.status = 'uncertain';
  await conversation.send('unresolved execution');
  await assert.rejects(conversation.send('blocked'), /original Crew request/);
  f.state.status = 'completed';
  await conversation.reconcile();
  await conversation.send('new work');
  assert.equal(f.state.entries, 2);
});

test('packed SDK rejects a mismatched receipt without corrupting the persisted intent', async t => {
  const f = await fixture(t), conversation = await f.open();
  f.state.receiptRequestId = '44444444-4444-4444-8444-444444444444';
  await assert.rejects(conversation.send('check identity'), CrewUnknownOutcomeError);
  const before = conversation.intent();
  assert.deepEqual(before.outcome, { kind: 'unresolved' });
  await assert.rejects(conversation.reconcile());
  assert.deepEqual((await f.open()).intent(), before);
});
