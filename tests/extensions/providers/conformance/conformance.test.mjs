import assert from 'node:assert/strict';
import test from 'node:test';
import { assistantTexts, host, pending, runOf, until } from './harness.mjs';
import { providers } from './providers.mjs';

const offline = 'The provider service is offline or unreachable. AgentUI checks again automatically.';
const removed = 'This conversation’s provider is no longer configured.';
const none = { creates: 0, sends: 0, cancels: 0, decisions: 0 };
const options = { timeout: 30_000 };
const GATED = { kind: 'rejected', reason: 'provider-command-unavailable' };

async function setup(t, row) {
  const subject = await row.start(t), peer = await row.peer(t);
  const f = await host(t, [subject.extension(), peer.extension()]);
  return { subject, peer, f };
}
async function running(f, subject, scope, text = 'Conformance request', subscriptions = 1) {
  const store = await f.store(scope);
  await until(() => subject.subscriptions() === subscriptions, 'provider subscription');
  const sent = await store.send(text);
  assert.equal(sent.kind, 'receipt', JSON.stringify(sent)); assert.ok(['accepted', 'completed'].includes(sent.receipt.state.kind), sent.receipt.state.kind);
  await until(() => runOf(store)?.kind === 'running', 'run started');
  return { store, sent };
}
const ended = store => until(() => runOf(store)?.kind === 'ended', 'run ended');
const agent = async (f, scope) => f.client.conversationAgent(scope);
const sendCommand = (scope, clientCommandId, text) => ({ version: 1, scope, clientCommandId, body: { kind: 'send', text } });
/** A control the row does not advertise is refused at admission and never reaches the service. */
async function assertGated(f, subject, peer, scope, result, command) {
  assert.equal((await f.agent(subject.namespace)).commands.includes(command), false);
  assert.deepEqual(result, GATED, JSON.stringify(result));
  assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1 });
  assert.deepEqual(peer.effects(), none);
}

for (const row of providers) {
  test(`${row.name}: create, send and stream through the public entry with one subscription and one effect each`, options, async t => {
    const { subject, peer, f } = await setup(t, row);
    const scope = await f.create(subject.namespace);
    assert.deepEqual(await f.client.create(scope, (await f.agent(subject.namespace)).id), scope, 'creating the same conversation again is idempotent');
    const { store, sent } = await running(f, subject, scope);
    subject.reply('Streamed conformance reply');
    await ended(store);
    assert.equal(runOf(store).outcome, 'completed');
    assert.deepEqual(assistantTexts(store), ['Streamed conformance reply']);
    const original = sendCommand(scope, sent.receipt.clientCommandId, 'Conformance request');
    assert.equal((await f.client.conversation(scope).submit(original)).receipt.hostOperationId, sent.receipt.hostOperationId);
    assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1 });
    assert.deepEqual(peer.effects(), none);
    assert.equal(subject.subscriptions(), 1);
    assert.equal(subject.counts.maxFeedsPerConversation, 1);
    assert.deepEqual([subject.counts.activations, subject.counts.connects], [1, 1]);
  });

  test(`${row.name}: restart resumes from the saved cursor without a snapshot, replayed effects or duplicate subscriptions`, options, async t => {
    const { subject, peer, f } = await setup(t, row);
    const scope = await f.create(subject.namespace);
    const first = await running(f, subject, scope, 'Before restart');
    subject.reply('Reply before restart');
    await ended(first.store);
    const before = subject.counts;
    await f.restart([subject.extension(), peer.extension()]);
    assert.deepEqual([before.closes, before.disposes, before.feeds], [1, 1, 0]);
    await until(() => subject.subscriptions() === 1 && subject.counts.feeds === 1, 'resubscribed once');
    assert.notEqual(subject.counts.observes[0].after, null, 'the host resumes from its saved provider cursor');
    assert.equal(subject.counts.snapshots, 0, 'a saved checkpoint needs no fresh snapshot');
    const second = await running(f, subject, scope, 'After restart');
    subject.reply('Reply after restart');
    await ended(second.store);
    assert.deepEqual(assistantTexts(second.store), ['Reply before restart', 'Reply after restart']);
    assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 2 });
    assert.deepEqual(peer.effects(), none);
    assert.equal(subject.subscriptions(), 1); assert.equal(subject.counts.maxFeedsPerConversation, 1);
    assert.equal(subject.counts.snapshots, 0);
  });

  test(`${row.name}: a dropped stream stops until the observation retry resubscribes once from one fresh snapshot`, options, async t => {
    const { subject, peer, f } = await setup(t, row);
    const scope = await f.create(subject.namespace);
    const { store } = await running(f, subject, scope, 'Before the stream drops');
    const counts = subject.counts, snapshots = counts.snapshots;
    subject.dropStreams();
    await until(async () => (await f.client.providerObservation({ scope, action: 'read' })).kind === 'stopped', 'observation stopped');
    assert.deepEqual(await f.client.providerObservation({ scope, action: 'read' }), { kind: 'stopped', reason: 'provider-disconnected' });
    await until(() => subject.subscriptions() === 0 && counts.feeds === 0, 'stream released');
    assert.deepEqual(await f.client.providerObservation({ scope, action: 'retry' }), { kind: 'observing' });
    await until(() => subject.subscriptions() === 1 && counts.feeds === 1, 'resubscribed once');
    assert.equal(counts.snapshots - snapshots, 1, 'the explicit retry forces exactly one fresh snapshot');
    assert.equal(counts.observes.length, 2);
    assert.notEqual(counts.observes[1].after, null);
    subject.reply('Reply after the retry');
    await ended(store);
    assert.deepEqual(assistantTexts(store), ['Reply after the retry']);
    assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1 });
    assert.deepEqual(peer.effects(), none);
    assert.equal(subject.subscriptions(), 1); assert.equal(counts.maxFeedsPerConversation, 1);
    assert.deepEqual([counts.activations, counts.connects, counts.closes], [1, 1, 0]);
  });

  test(`${row.name}: a lost send reply stays uncertain across restart until an explicit reconcile settles it without a second effect`, options, async t => {
    const { subject, peer, f } = await setup(t, row);
    const scope = await f.create(subject.namespace), port = f.client.conversation(scope);
    await until(() => subject.subscriptions() === 1, 'provider subscription');
    subject.loseSendReplies(true);
    assert.equal((await port.submit(sendCommand(scope, 'lost-send', 'Lost reply'))).receipt.state.kind, 'uncertain');
    subject.loseSendReplies(false);
    assert.equal((await port.receipt('lost-send')).state.kind, 'uncertain');
    await f.restart([subject.extension(), peer.extension()]);
    assert.equal((await f.client.conversation(scope).receipt('lost-send')).state.kind, 'uncertain', 'restart alone settles nothing');
    assert.equal((await f.client.reconcile(scope, 'lost-send')).state.kind, 'accepted');
    assert.equal((await f.client.conversation(scope).receipt('lost-send')).state.kind, 'accepted');
    assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1 });
    assert.deepEqual(peer.effects(), none);
  });

  if (row.supports.cancel) {
    test(`${row.name}: cancel reaches the provider once`, options, async t => {
      const { subject, peer, f } = await setup(t, row);
      const scope = await f.create(subject.namespace);
      assert.equal((await f.agent(subject.namespace)).commands.includes('cancel'), true);
      const { store } = await running(f, subject, scope);
      const result = await store.cancel(runOf(store).runId);
      assert.ok(['accepted', 'completed'].includes(result.receipt.state.kind), result.receipt.state.kind);
      const again = await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: result.receipt.clientCommandId,
        body: { kind: 'cancel', runId: runOf(store).runId } });
      assert.equal(again.receipt.hostOperationId, result.receipt.hostOperationId);
      assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1, cancels: 1 });
      assert.deepEqual(peer.effects(), none);
    });
  } else {
    test(`${row.name}: cancel is capability-gated`, options, async t => {
      const { subject, peer, f } = await setup(t, row);
      const scope = await f.create(subject.namespace);
      const { store } = await running(f, subject, scope);
      await assertGated(f, subject, peer, scope, await store.cancel(runOf(store).runId), 'cancel');
    });
  }

  if (row.supports.decide) {
    test(`${row.name}: decisions approve and deny once each`, options, async t => {
      const { subject, peer, f } = await setup(t, row);
      const scope = await f.create(subject.namespace);
      assert.equal((await f.agent(subject.namespace)).commands.includes('approve'), true);
      const { store } = await running(f, subject, scope);
      for (const [pattern, prompt] of [[/approve/i, 'Record the first item'], [/deny/i, 'Record the second item']]) {
        subject.card(prompt);
        await until(() => pending(store).length === 1, 'pending decision');
        const decision = pending(store)[0];
        const result = await store.approve(decision.pendingId, decision.choices.find(id => pattern.test(decision.choiceLabels[id])));
        assert.equal(result.receipt.state.kind, 'completed');
        await until(() => pending(store).length === 0, 'the service withdraws the answered decision');
      }
      assert.deepEqual(subject.answers(), ['approve', 'deny']);
      assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1, decisions: 2 });
      assert.deepEqual(peer.effects(), none);
    });
  } else {
    test(`${row.name}: decisions are capability-gated`, options, async t => {
      const { subject, peer, f } = await setup(t, row);
      const scope = await f.create(subject.namespace);
      const { store } = await running(f, subject, scope);
      subject.card('Record the first item');
      await until(() => pending(store).length === 1, 'pending decision');
      const decision = pending(store)[0];
      await assertGated(f, subject, peer, scope, await store.approve(decision.pendingId, decision.choices[0]), 'approve');
    });
  }

  test(`${row.name}: disable retires the provider once and reload restores one subscription`, options, async t => {
    const { subject, peer, f } = await setup(t, row);
    const scope = await f.create(subject.namespace);
    await f.store(scope);
    await until(() => subject.subscriptions() === 1, 'provider subscription');
    const original = subject.counts;
    assert.equal((await f.replace([peer.extension()])).kind, 'replaced');
    await until(() => subject.subscriptions() === 0, 'subscription released');
    assert.deepEqual([original.closes, original.disposes, original.feeds], [1, 1, 0]);
    assert.equal(await f.agent(subject.namespace), undefined);
    assert.deepEqual((await agent(f, scope)).availability, { kind: 'unavailable', reason: removed });
    assert.equal((await f.agent(peer.namespace)).availability.kind, 'ready');
    assert.deepEqual(await f.client.conversation(scope).submit(sendCommand(scope, 'disabled', 'Disabled')), GATED);
    for (let reload = 0; reload < 3; reload++) {
      const previous = reload === 0 ? null : subject.counts;
      assert.equal((await f.replace([subject.extension(), peer.extension()])).kind, 'replaced');
      if (previous) assert.deepEqual([previous.closes, previous.disposes, previous.feeds], [1, 1, 0]);
      await until(async () => (await agent(f, scope)).availability.kind === 'ready', 'conversation ready again');
      await until(() => subject.subscriptions() === 1 && subject.counts.feeds === 1, 'one subscription after reload');
    }
    const { store } = await running(f, subject, scope, 'After reload');
    subject.reply('Reply after reload');
    await ended(store);
    assert.deepEqual(assistantTexts(store), ['Reply after reload']);
    assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1 });
    assert.equal(subject.subscriptions(), 1); assert.equal(subject.counts.maxFeedsPerConversation, 1);
    assert.equal(original.closes, 1); assert.equal(original.disposes, 1);
    assert.deepEqual(peer.effects(), none);
  });

  test(`${row.name}: an outage is explicit, refuses sends and leaves open streams, the peer provider and native agents serving`, options, async t => {
    const { subject, peer, f } = await setup(t, row);
    const idle = await f.create(subject.namespace), scope = await f.create(subject.namespace);
    const { store } = await running(f, subject, scope, 'Before the outage', 2);
    const before = subject.effects();
    subject.setDown(true);
    const statuses = await f.running.discoverProviders();
    assert.deepEqual(statuses.map(item => [item.instance.namespace, item.kind, item.cause]).toSorted(),
      [[peer.namespace, 'available', undefined], [subject.namespace, 'unavailable', 'offline']].toSorted());
    const metadata = await f.client.metadata();
    assert.deepEqual((await f.agent(subject.namespace)).availability, { kind: 'unavailable', reason: offline });
    assert.deepEqual((await agent(f, scope)).availability, { kind: 'unavailable', reason: offline });
    assert.equal((await f.agent(peer.namespace)).availability.kind, 'ready');
    assert.ok(metadata.agents.some(item => item.kind !== 'provider' && item.id === metadata.defaultAgentId && item.availability.kind === 'ready'));
    const peerScope = await f.create(peer.namespace);
    assert.equal((await agent(f, peerScope)).availability.kind, 'ready');
    assert.deepEqual(await f.client.conversation(idle).submit(sendCommand(idle, 'outage', 'During the outage')), GATED);
    assert.deepEqual(await f.client.conversation(scope).submit(sendCommand(scope, 'outage', 'During the outage')),
      { kind: 'rejected', reason: 'send-awaiting-confirmation' }, 'the earlier send cannot be settled while the provider is offline');
    subject.reply('Reply during the outage');
    await until(() => assistantTexts(store).includes('Reply during the outage'), 'a stream opened before the outage keeps delivering');
    assert.equal(subject.subscriptions(), 2);
    subject.setDown(false);
    assert.deepEqual((await f.running.discoverProviders()).map(item => item.kind), ['available', 'available']);
    assert.deepEqual((await agent(f, scope)).availability, { kind: 'ready' });
    assert.deepEqual(subject.effects(), before);
    assert.deepEqual(peer.effects(), { ...none, creates: 1 });
  });
}
