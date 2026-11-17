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
async function running(f, subject, scope, text = 'Conformance request') {
  const store = await f.store(scope);
  await until(() => subject.subscriptions() === 1, 'provider subscription');
  const sent = await store.send(text);
  assert.equal(sent.kind, 'receipt', JSON.stringify(sent)); assert.ok(['accepted', 'completed'].includes(sent.receipt.state.kind), sent.receipt.state.kind);
  await until(() => runOf(store)?.kind === 'running', 'run started');
  return { store, sent };
}
const ended = store => until(() => runOf(store)?.kind === 'ended', 'run ended');
const agent = async (f, scope) => f.client.conversationAgent(scope);

for (const row of providers) {
  test(`${row.name}: create, send and stream through the public entry with one subscription and one effect each`, options, async t => {
    const { subject, peer, f } = await setup(t, row);
    const scope = await f.create(subject.namespace);
    await f.client.create(scope, (await f.agent(subject.namespace)).id);
    const { store, sent } = await running(f, subject, scope);
    subject.reply('Streamed conformance reply');
    await ended(store);
    assert.equal(runOf(store).outcome, 'completed');
    assert.deepEqual(assistantTexts(store), ['Streamed conformance reply']);
    const original = { version: 1, scope, clientCommandId: sent.receipt.clientCommandId, body: { kind: 'send', text: 'Conformance request' } };
    assert.equal((await f.client.conversation(scope).submit(original)).receipt.hostOperationId, sent.receipt.hostOperationId);
    assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1 });
    assert.deepEqual(peer.effects(), none);
    assert.equal(subject.subscriptions(), 1);
    assert.equal(subject.counts.maxFeedsPerConversation, 1);
    assert.deepEqual([subject.counts.activations, subject.counts.connects], [1, 1]);
  });

  test(`${row.name}: restart resumes from the saved cursor without replaying effects or duplicating subscriptions`, options, async t => {
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
    if (subject.tailRequests) assert.ok(subject.tailRequests.at(-1).from[1] > 0, 'ledger tail resumes past offset zero');
    const second = await running(f, subject, scope, 'After restart');
    subject.reply('Reply after restart');
    await ended(second.store);
    assert.deepEqual(assistantTexts(second.store), ['Reply before restart', 'Reply after restart']);
    assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 2 });
    assert.deepEqual(peer.effects(), none);
    assert.equal(subject.subscriptions(), 1); assert.equal(subject.counts.maxFeedsPerConversation, 1);
  });

  test(`${row.name}: a lost send reply stays uncertain until restart reconciles it without a second effect`, options, async t => {
    const { subject, peer, f } = await setup(t, row);
    const scope = await f.create(subject.namespace), port = f.client.conversation(scope);
    await until(() => subject.subscriptions() === 1, 'provider subscription');
    subject.loseSends();
    const command = { version: 1, scope, clientCommandId: 'lost-send', body: { kind: 'send', text: 'Lost reply' } };
    assert.equal((await port.submit(command)).receipt.state.kind, 'uncertain');
    subject.restore();
    assert.equal((await port.receipt('lost-send')).state.kind, 'uncertain');
    await f.restart([subject.extension(), peer.extension()]);
    assert.equal((await f.client.reconcile(scope, 'lost-send')).state.kind, 'accepted');
    assert.equal((await f.client.conversation(scope).receipt('lost-send')).state.kind, 'accepted');
    assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1 });
    assert.deepEqual(peer.effects(), none);
  });

  test(`${row.name}: cancel ${row.name.includes('without') ? 'is capability-gated' : 'reaches the provider once'}`, options, async t => {
    const { subject, peer, f } = await setup(t, row);
    const scope = await f.create(subject.namespace);
    assert.equal((await f.agent(subject.namespace)).commands.includes('cancel'), subject.supports.cancel);
    const { store } = await running(f, subject, scope);
    const result = await store.cancel(runOf(store).runId);
    assert.deepEqual(peer.effects(), none);
    if (!subject.supports.cancel) {
      assert.deepEqual(result, GATED, JSON.stringify(result));
      assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1 });
      return;
    }
    assert.ok(['accepted', 'completed'].includes(result.receipt.state.kind), result.receipt.state.kind);
    const again = await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: result.receipt.clientCommandId,
      body: { kind: 'cancel', runId: runOf(store).runId } });
    assert.equal(again.receipt.hostOperationId, result.receipt.hostOperationId);
    assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1, cancels: 1 });
  });

  test(`${row.name}: decisions ${row.name.includes('without') ? 'are capability-gated' : 'approve and deny once each'}`, options, async t => {
    const { subject, peer, f } = await setup(t, row);
    const scope = await f.create(subject.namespace);
    assert.equal((await f.agent(subject.namespace)).commands.includes('approve'), subject.supports.decide);
    const { store } = await running(f, subject, scope);
    const choose = async (pattern, prompt) => {
      subject.card(prompt);
      await until(() => pending(store).length === 1, 'pending decision');
      const decision = pending(store)[0];
      const choice = decision.choices.find(id => pattern.test(decision.choiceLabels[id]));
      const result = await store.approve(decision.pendingId, choice);
      if (subject.supports.decide) subject.settle();
      return result;
    };
    const approved = await choose(/approve/i, 'Record the first item');
    assert.deepEqual(peer.effects(), none);
    if (!subject.supports.decide) {
      assert.deepEqual(approved, GATED, JSON.stringify(approved));
      assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1 });
      return;
    }
    assert.equal(approved.receipt.state.kind, 'completed');
    await until(() => pending(store).length === 0, 'decision cleared');
    const denied = await choose(/deny/i, 'Record the second item');
    assert.equal(denied.receipt.state.kind, 'completed');
    await until(() => pending(store).length === 0, 'second decision cleared');
    assert.deepEqual(subject.answers(), ['approve', 'deny']);
    assert.deepEqual(subject.effects(), { ...none, creates: 1, sends: 1, decisions: 2 });
  });

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
    const refused = await f.client.conversation(scope).submit({ version: 1, scope, clientCommandId: 'disabled', body: { kind: 'send', text: 'Disabled' } });
    assert.notEqual(refused.kind === 'receipt' && ['accepted', 'completed'].includes(refused.receipt.state.kind), true);
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

  test(`${row.name}: an outage is explicit and leaves the peer provider and native agents serving`, options, async t => {
    const { subject, peer, f } = await setup(t, row);
    const scope = await f.create(subject.namespace), before = subject.effects();
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
    subject.setDown(false);
    assert.deepEqual((await f.running.discoverProviders()).map(item => item.kind), ['available', 'available']);
    assert.deepEqual((await agent(f, scope)).availability, { kind: 'ready' });
    assert.deepEqual(subject.effects(), before);
    assert.deepEqual(peer.effects(), { ...none, creates: 1 });
  });
}
