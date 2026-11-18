import assert from 'node:assert/strict';
import test from 'node:test';
import { ServiceError } from '@agentui/contracts/service';
import { scope, empty, fixture } from './controller-fixture.mjs';

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
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'cancelled' });
  f.behavior.continuation = async input => {
    if (input.scope.conversationId === 'after') return { predecessor: scope, carried, closure: null, successor: null };
    if (input.action === 'start') starts++;
    return { ...none, closure: 'cancelled', successor: starts ? { kind: 'confirmed', scope: after } : null };
  };
  await f.app.start();
  const before = f.app.getSnapshot().active;
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
  assert.deepEqual(f.app.getSnapshot().catalog.items[0], { scope: after, preview: null });
  assert.equal(f.app.getSnapshot().catalog.items.some(item => item.scope.conversationId === scope.conversationId), false);
  assert.deepEqual(f.submitted, []);
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

test('Start a new chat uses the ordinary create flow with the same agent and moves only the draft', async t => {
  let starts = 0;
  const f = opened(fixture()); t.after(() => f.app.dispose());
  f.behavior.observation = async () => ({ kind: 'concluded', cause: 'exhausted' });
  f.behavior.continuation = async input => { if (input.action !== 'read') starts++; return { ...none, closure: 'exhausted' }; };
  await f.app.start();
  const before = f.app.getSnapshot().active;
  await before.store.setDraft('My own context');
  await f.app.conversationActions(before).startNewChat();
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.selected, [before.agent.id]);
  assert.deepEqual(f.app.getSnapshot().active.scope, f.created[0]);
  assert.equal(f.app.getSnapshot().active.store.getSnapshot().draft, 'My own context');
  assert.equal(f.drafts.get('original-view/host/conversation').draft, '');
  assert.equal(starts, 0);
  assert.deepEqual(f.submitted, []);
});
