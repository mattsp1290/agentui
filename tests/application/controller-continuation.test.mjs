import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from '@agentui/contracts/service';
import { scope, empty, fixture } from './controller-fixture.mjs';
import { continuationNotice, earlierLabel } from '../../apps/desktop/src/application/continuation-copy.ts';

const none = { predecessor: null, carried: null, closure: null, successor: null };
const carried = { carriedTurns: 2, omittedTurns: 1, uncertainTurns: 0, carriedBytes: 900, limitBytes: 65536 };
const segment = conversationId => ({ ...scope, conversationId });
const turn = () => new Promise(resolve => setImmediate(resolve));
async function eventually(predicate, turns = 200) {
  for (let count = 0; count < turns; count++) { if (predicate()) return; await turn(); }
  assert.fail('Condition was not reached');
}
function opened(f, route = scope) {
  f.views.set('original-view/host', { ...empty(), route });
  return f;
}

test('a kept closure masks only failed or stopped reads of its own scope', async t => {
  const f = opened(fixture()); t.after(() => f.app.dispose());
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'cancelled' });
  await f.app.start(); await turn();
  assert.deepEqual(f.app.getSnapshot().observation.status, { kind: 'concluded', cause: 'cancelled' });
  for (const next of [async () => { throw new Error('Status read lost'); }, async () => ({ kind: 'stopped', reason: 'recovery-failed' })]) {
    f.behavior.observation = next;
    await f.app.open(scope); await turn();
    assert.deepEqual(f.app.getSnapshot().observation.status, { kind: 'concluded', cause: 'cancelled' });
  }
  f.behavior.observation = async () => ({ kind: 'observing' });
  await f.app.open(scope); await turn();
  assert.deepEqual(f.app.getSnapshot().observation.status, { kind: 'observing' });
});

test('opening any segment follows confirmed successors to the newest, then loads earlier segments one watch at a time', async t => {
  const first = segment('first'), second = segment('second'), third = segment('third'), reads = [];
  const views = {
    first: { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope: second } },
    second: { predecessor: first, carried, closure: 'exhausted', successor: { kind: 'confirmed', scope: third } },
    third: { predecessor: second, carried: { ...carried, omittedTurns: 0 }, closure: null, successor: null },
  };
  const f = opened(fixture(), first); t.after(() => f.app.dispose());
  f.behavior.continuation = async input => { reads.push([input.scope.conversationId, input.action]); return views[input.scope.conversationId] ?? none; };
  await f.app.start();
  assert.deepEqual(f.app.getSnapshot().active.scope, third);
  assert.deepEqual(f.views.get('original-view/host').route, third);
  await eventually(() => Boolean(f.app.getSnapshot().continuation?.boundary));
  assert.deepEqual(f.app.getSnapshot().continuation.boundary, { closure: 'exhausted', carried: views.third.carried });
  assert.equal(f.app.getSnapshot().continuation.more, true);
  assert.deepEqual(f.app.getSnapshot().continuation.earlier, []);
  const actions = f.app.conversationActions(f.app.getSnapshot().active), closes = f.feedCloses();
  const loading = actions.loadEarlierSegment();
  await eventually(() => f.feeds.some(feed => feed.scope.conversationId === 'second'));
  const messages = [{ messageId: 'earlier', role: 'user', text: 'Text from the second segment', complete: true }];
  await f.feeds.find(feed => feed.scope.conversationId === 'second').receive({ kind: 'snapshot', snapshot: { document: { domain: { messages, currentRun: null } } } });
  await loading;
  const loaded = f.app.getSnapshot().continuation;
  assert.deepEqual(loaded.earlier, [{ scope: second, messages, boundary: { closure: 'cancelled', carried } }]);
  assert.equal(loaded.more, true);
  assert.equal(f.feedCloses(), closes + 1);
  await f.app.open(second);
  assert.deepEqual(f.app.getSnapshot().active.scope, third);
  assert.deepEqual(reads.filter(([, action]) => action !== 'read'), []);
  assert.deepEqual(f.submitted, []);
});

test('Continue moves to the confirmed successor with the draft, never sends it and never starts twice', async t => {
  const after = segment('after');
  let starts = 0;
  const f = opened(fixture()); t.after(() => f.app.dispose());
  f.behavior.catalog = async cursor => cursor === null ? [segment('a'), scope, segment('z')] : [];
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'cancelled' });
  f.behavior.continuation = async input => {
    if (input.scope.conversationId === 'after') return { predecessor: scope, carried, closure: null, successor: null };
    if (input.action === 'start') starts++;
    return { ...none, closure: 'cancelled', successor: starts ? { kind: 'confirmed', scope: after } : null };
  };
  await f.app.start();
  const before = f.app.getSnapshot().active;
  assert.equal(f.app.getSnapshot().continuation.arrived, null);
  await before.store.setDraft('Carried only as a draft');
  await eventually(() => Boolean(f.app.getSnapshot().continuation?.view));
  assert.equal(f.app.getSnapshot().continuation.view.successor, null);
  await f.app.conversationActions(before).continueConversation();
  assert.equal(starts, 1);
  assert.deepEqual(f.app.getSnapshot().active.scope, after);
  assert.deepEqual(f.views.get('original-view/host').route, after);
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, 'Carried only as a draft');
  assert.equal(f.drafts.get('original-view/host/after').draft, 'Carried only as a draft');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, '');
  assert.deepEqual(f.app.getSnapshot().catalog.items.map(item => item.scope.conversationId), ['a', 'after', 'z']);
  assert.equal(f.app.getSnapshot().continuation.arrived, 'continue');
  assert.deepEqual(f.submitted, []);
});

test('text typed while the move runs reaches the new composer even when the draft was empty at the click', async t => {
  const after = segment('after');
  let starts = 0;
  const f = opened(fixture()); t.after(() => f.app.dispose());
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'cancelled' });
  f.behavior.continuation = async input => {
    if (input.scope.conversationId === 'after') return { predecessor: scope, carried, closure: null, successor: null };
    if (input.action === 'start') starts++;
    return { ...none, closure: 'cancelled', successor: starts ? { kind: 'confirmed', scope: after } : null };
  };
  await f.app.start();
  const before = f.app.getSnapshot().active;
  await eventually(() => Boolean(f.app.getSnapshot().continuation?.view));
  f.behavior.agentLookup = async value => {
    if (value.conversationId === 'after') void before.store.setDraft('Typed while it moves');
    return f.descriptor();
  };
  await f.app.conversationActions(before).continueConversation();
  assert.deepEqual(f.app.getSnapshot().active.scope, after);
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, 'Typed while it moves');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, '');
  assert.deepEqual(f.submitted, []);
});

for (const via of ['open', 'reconnect']) test(`following a confirmed successor on ${via} moves the earlier draft once and never sends it`, async t => {
  const first = segment('first'), second = segment('second');
  let linked = false;
  const f = opened(fixture(), first); t.after(() => f.app.dispose());
  f.behavior.continuation = async input => {
    if (input.scope.conversationId === 'second') return { predecessor: first, carried, closure: null, successor: null };
    if (input.scope.conversationId !== 'first') return none;
    return { ...none, closure: 'cancelled', successor: linked ? { kind: 'confirmed', scope: second } : null };
  };
  await f.app.start();
  const before = f.app.getSnapshot().active;
  assert.deepEqual(before.scope, first);
  await before.store.setDraft('Left on the first segment');
  if (via === 'open') await f.app.open(segment('elsewhere'));
  linked = true;
  await (via === 'open' ? f.app.open(first) : f.app.reconnect());
  assert.deepEqual(f.app.getSnapshot().active.scope, second);
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, 'Left on the first segment');
  assert.equal(f.drafts.get('original-view/host/first').draft, '');
  assert.equal(f.app.getSnapshot().continuation.arrived, null);
  // Once: with the new composer emptied, following the chain again must not bring the draft back.
  await f.app.getSnapshot().active.store.setDraft('');
  await f.app.open(first);
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, '');
  assert.deepEqual(f.submitted, []);
});

test('a poll that fires while an earlier segment loads is armed again, so Continuing… still moves once the successor confirms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const earlier = segment('earlier'), after = segment('after');
  let confirmed = false;
  const f = opened(fixture()); t.after(() => f.app.dispose());
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'cancelled' });
  f.behavior.continuation = async input => {
    const id = input.scope.conversationId;
    if (id === 'earlier') return { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope } };
    if (id === 'after') return { predecessor: scope, carried, closure: null, successor: null };
    return { predecessor: earlier, carried, closure: 'cancelled', successor: confirmed ? { kind: 'confirmed', scope: after } : { kind: 'starting' } };
  };
  await f.app.start();
  await eventually(() => f.app.getSnapshot().continuation?.more === true);
  const loading = f.app.conversationActions(f.app.getSnapshot().active).loadEarlierSegment();
  await eventually(() => f.feeds.some(feed => feed.scope.conversationId === 'earlier'));
  t.mock.timers.tick(500); await turn(); await turn();
  confirmed = true;
  await f.feeds.find(feed => feed.scope.conversationId === 'earlier').receive({ kind: 'snapshot', snapshot: { document: { domain: { messages: [], currentRun: null } } } });
  await loading;
  assert.equal(f.app.getSnapshot().continuation.earlier.length, 1);
  assert.equal(f.app.getSnapshot().active.scope.conversationId, 'conversation');
  t.mock.timers.tick(4_000);
  await eventually(() => f.app.getSnapshot().active?.scope.conversationId === 'after');
});

test('a move that keeps failing stops after three tries though reads succeed; Check again only looks up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const after = segment('after'), actions = [];
  let confirmed = false, lookups = 0;
  const f = opened(fixture()); t.after(() => f.app.dispose());
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'cancelled' });
  f.behavior.continuation = async input => {
    if (input.scope.conversationId === 'after') return { predecessor: scope, carried, closure: null, successor: null };
    actions.push(input.action);
    return { ...none, closure: 'cancelled', successor: confirmed ? { kind: 'confirmed', scope: after } : { kind: 'starting' } };
  };
  f.behavior.agentLookup = async value => {
    if (value.conversationId !== 'after') return f.descriptor();
    lookups++;
    throw new Error('The agent could not be read.');
  };
  await f.app.start();
  await eventually(() => f.app.getSnapshot().continuation?.view?.successor?.kind === 'starting');
  confirmed = true;
  for (let move = 1; move <= 3; move++) {
    t.mock.timers.tick(4_000);
    await eventually(() => lookups === move && !f.app.getSnapshot().busy && f.app.getSnapshot().continuation.action === null);
  }
  const reads = actions.length;
  t.mock.timers.tick(60_000); await turn(); await turn();
  assert.equal(lookups, 3);
  assert.equal(actions.length, reads);
  const stalled = f.app.getSnapshot().continuation;
  assert.equal(stalled.stalled, true);
  assert.deepEqual(continuationNotice(stalled), { status: 'AgentUI could not confirm this continuation yet.', disclosure: false, choices: ['Check again', 'Start a new chat'] });
  await f.app.conversationActions(f.app.getSnapshot().active).checkContinuation();
  assert.deepEqual(actions.slice(reads), ['check']);
  assert.equal(lookups, 4);
  assert.equal(f.app.getSnapshot().continuation.stalled, false);
  assert.equal(actions.includes('start'), false);
});

test('failing reads on a closed chat stop after six tries and leave Check again and Start a new chat', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const actions = [];
  let failing = true;
  const f = opened(fixture()); t.after(() => f.app.dispose());
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'failed' });
  f.behavior.continuation = async input => {
    actions.push(input.action);
    if (failing) throw new ServiceError('unavailable', 'Service request timed out');
    return { ...none, closure: 'failed' };
  };
  await f.app.start();
  for (let tick = 0; tick < 10; tick++) { await turn(); await turn(); t.mock.timers.tick(4_000); }
  await eventually(() => f.app.getSnapshot().continuation?.stalled === true);
  t.mock.timers.tick(60_000); await turn(); await turn();
  // One read by the walk to the newest segment, then six by the closed chat's record.
  assert.equal(actions.length, 7);
  const giveUp = { status: 'AgentUI could not confirm this continuation yet.', disclosure: false, choices: ['Check again', 'Start a new chat'] };
  assert.equal(f.app.getSnapshot().continuation.view, null);
  assert.deepEqual(continuationNotice(f.app.getSnapshot().continuation), giveUp);
  const actionsFor = f.app.conversationActions(f.app.getSnapshot().active);
  await actionsFor.checkContinuation();
  assert.deepEqual(actions.slice(7), ['check', 'read']);
  assert.equal(f.app.getSnapshot().continuation.error, 'Service request timed out');
  assert.deepEqual(continuationNotice(f.app.getSnapshot().continuation), giveUp);
  failing = false;
  await actionsFor.checkContinuation();
  assert.deepEqual(actions.slice(9), ['check']);
  assert.equal(actions.includes('start'), false);
  assert.deepEqual(continuationNotice(f.app.getSnapshot().continuation).choices, ['Continue', 'Start a new chat']);
});

test('a loop of continuation links ends the walk with an error instead of reopening without end', async t => {
  const next = { a: segment('b'), b: segment('c'), c: segment('a') };
  let reads = 0;
  const f = opened(fixture(), segment('a')); t.after(() => f.app.dispose());
  f.behavior.continuation = async input => { reads++; return { ...none, closure: 'cancelled', successor: { kind: 'confirmed', scope: next[input.scope.conversationId] } }; };
  await f.app.start();
  assert.equal(f.app.getSnapshot().active, null);
  assert.equal(f.app.getSnapshot().error, 'The continuations of this chat form a loop, so its newest conversation cannot be opened.');
  assert.equal(reads, 3);
});

test('an earlier segment that cannot load says so and offers Show earlier messages again', async t => {
  const first = segment('first'), second = segment('second');
  const f = opened(fixture(), second); t.after(() => f.app.dispose());
  f.behavior.continuation = async input => input.scope.conversationId === 'second'
    ? { predecessor: first, carried, closure: null, successor: null }
    : { ...none, closure: 'cancelled', successor: input.scope.conversationId === 'first' ? { kind: 'confirmed', scope: second } : null };
  await f.app.start();
  await eventually(() => f.app.getSnapshot().continuation?.more === true);
  assert.equal(earlierLabel(f.app.getSnapshot().continuation), 'Show earlier messages');
  const loading = f.app.conversationActions(f.app.getSnapshot().active).loadEarlierSegment();
  assert.equal(earlierLabel(f.app.getSnapshot().continuation), 'Loading earlier messages…');
  await eventually(() => f.feeds.some(feed => feed.scope.conversationId === 'first'));
  f.feeds.find(feed => feed.scope.conversationId === 'first').finish({ reason: 'The conversation feed ended.' });
  await loading;
  const failed = f.app.getSnapshot().continuation;
  assert.equal(failed.earlierError, 'Earlier messages could not load. The conversation feed ended.');
  assert.deepEqual(failed.earlier, []);
  assert.equal(earlierLabel(failed), 'Show earlier messages');
});

test('a timed-out start is not a failure while a later read shows starting; polling moves once it confirms', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const after = segment('after');
  let confirmed = false, starts = 0;
  const f = opened(fixture()); t.after(() => f.app.dispose());
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'failed' });
  f.behavior.continuation = async input => {
    if (input.scope.conversationId === 'after') return { predecessor: scope, carried, closure: null, successor: null };
    if (input.action === 'start') { starts++; throw new ServiceError('unavailable', 'Service request timed out'); }
    return { ...none, closure: 'failed', successor: starts === 0 ? null : confirmed ? { kind: 'confirmed', scope: after } : { kind: 'starting' } };
  };
  await f.app.start();
  const before = f.app.getSnapshot().active;
  await eventually(() => Boolean(f.app.getSnapshot().continuation?.view));
  await f.app.conversationActions(before).continueConversation();
  assert.deepEqual(f.app.getSnapshot().continuation.view.successor, { kind: 'starting' });
  assert.equal(f.app.getSnapshot().continuation.error, '');
  assert.equal(f.app.getSnapshot().error, '');
  t.mock.timers.tick(500); await turn(); await turn();
  assert.equal(f.app.getSnapshot().active, before);
  confirmed = true;
  t.mock.timers.tick(1000);
  await eventually(() => f.app.getSnapshot().active?.scope.conversationId === 'after');
  assert.equal(starts, 1);
});

test('an invalid start shows the host reason and never polls or retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0, reads = 0;
  const f = opened(fixture()); t.after(() => f.app.dispose());
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'cancelled' });
  f.behavior.continuation = async input => {
    if (input.action === 'start') { starts++; throw new ServiceError('invalid', 'Only a concluded provider conversation without frontend tool activity can be continued.'); }
    reads++;
    return { ...none, closure: 'cancelled' };
  };
  await f.app.start();
  await eventually(() => Boolean(f.app.getSnapshot().continuation?.view));
  const active = f.app.getSnapshot().active;
  await f.app.conversationActions(active).continueConversation();
  const settled = reads;
  t.mock.timers.tick(30_000); await turn(); await turn();
  assert.equal(reads, settled);
  assert.equal(f.app.getSnapshot().continuation.error, 'Only a concluded provider conversation without frontend tool activity can be continued.');
  assert.equal(f.app.getSnapshot().continuation.action, null);
  assert.equal(f.app.getSnapshot().continuation.view.successor, null);
  assert.equal(f.app.getSnapshot().active, active);
  assert.equal(starts, 1);
});

test('Start a new chat uses the ordinary create flow with the same agent and moves only the draft, with text typed while it runs', async t => {
  let starts = 0;
  const f = opened(fixture()); t.after(() => f.app.dispose());
  f.captured.set(scope.conversationId, f.descriptor('other'));
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'exhausted' });
  f.behavior.continuation = async input => { if (input.action !== 'read') starts++; return { ...none, closure: 'exhausted' }; };
  await f.app.start();
  const before = f.app.getSnapshot().active;
  assert.equal(before.agent.id, 'other');
  await before.store.setDraft('My own context');
  f.behavior.create = async () => { void before.store.setDraft('My own context, typed while it opens'); };
  await f.app.conversationActions(before).startNewChat();
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.selected, ['other']);
  assert.deepEqual(f.app.getSnapshot().active.scope, f.created[0]);
  assert.equal(f.app.getSnapshot().continuation.arrived, 'new-chat');
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, 'My own context, typed while it opens');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, '');
  assert.equal(starts, 0);
  assert.deepEqual(f.submitted, []);
});
