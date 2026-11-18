import assert from 'node:assert/strict';
import test from 'node:test';
import { boundaryNote, continuationAnnouncement, continuationNotice, earlierLabel } from '../../apps/desktop/src/application/continuation-copy.ts';

const scope = { hostId: 'host', conversationId: 'after' };
const base = { view: null, action: null, error: '', stalled: false, arrived: null, boundary: null, earlier: [], earlierError: '', more: false };
const closed = successor => ({ ...base, view: { predecessor: null, carried: null, closure: 'cancelled', successor } });
const carried = { carriedTurns: 2, omittedTurns: 0, uncertainTurns: 3, carriedBytes: 2048, limitBytes: 65536 };
const NO_CARRY = 'Tools, approvals and the agent’s memory did not carry over.';
const GIVE_UP = { status: 'AgentUI could not confirm this continuation yet.', disclosure: false, choices: ['Check again', 'Start a new chat'] };

test('the boundary names each closure, inflects its counts and drops zero-count sentences', () => {
  assert.equal(boundaryNote({ closure: 'failed', carried }),
    'Continued in a new provider conversation because the earlier one ended after the provider reported a failure. '
    + `Carried the newest 2 completed turns (2 KiB of 64 KiB). 3 turns with an unknown outcome left out and not resent. ${NO_CARRY} `
    + 'The first reply acknowledges the carried turns.');
  assert.equal(boundaryNote({ closure: 'exhausted', carried: { ...carried, carriedTurns: 0, uncertainTurns: 0, omittedTurns: 4 } }),
    `Continued in a new provider conversation because the earlier one reached its turn limit. 4 older turns left out. ${NO_CARRY}`);
  assert.equal(boundaryNote({ closure: 'cancelled', carried: { carriedTurns: 1, omittedTurns: 1, uncertainTurns: 1, carriedBytes: 1, limitBytes: 65536 } }),
    'Continued in a new provider conversation because the earlier one was stopped. Carried the newest 1 completed turn (0.1 KiB of 64 KiB). '
    + `1 older turn left out. 1 turn with an unknown outcome left out and not resent. ${NO_CARRY} The first reply acknowledges the carried turns.`);
  for (const closure of ['unknown', null]) assert.equal(boundaryNote({ closure, carried: null }), `Continued in a new provider conversation. ${NO_CARRY}`);
});

test('each closed-chat state shows its own line and choices', () => {
  assert.equal(continuationNotice(base), null);
  assert.deepEqual(continuationNotice(closed(null)), { status: '', disclosure: true, choices: ['Continue', 'Start a new chat'] });
  for (const value of [{ ...closed(null), action: 'start' }, { ...closed(null), action: 'move' }, closed({ kind: 'starting' }), closed({ kind: 'confirmed', scope })]) {
    assert.deepEqual(continuationNotice(value), { status: 'Continuing…', disclosure: false, choices: [] });
  }
  assert.deepEqual(continuationNotice(closed({ kind: 'pending' })), { status: 'The provider saved the continuation but has not delivered the carried context. AgentUI will not send it again.',
    disclosure: false, choices: ['Check again', 'Start a new chat'] });
  assert.deepEqual(continuationNotice(closed({ kind: 'unconfirmed' })), { status: 'Continue is not confirmed. Checking again cannot start a second conversation.',
    disclosure: false, choices: ['Check again', 'Try again'] });
  const refusals = {
    busy: ['The provider is still finishing work here.', ['Try again']],
    limit: ['The agent is over a provider limit.', ['Try again', 'Start a new chat']],
    unavailable: ['The provider could not carry context.', ['Start a new chat']],
    'continued-elsewhere': ['This conversation was continued outside AgentUI.', ['Start a new chat']],
  };
  for (const [refusal, [status, choices]] of Object.entries(refusals)) {
    assert.deepEqual(continuationNotice(closed({ kind: 'refused', refusal })), { status, disclosure: false, choices }, refusal);
  }
});

test('the give-up state offers only a lookup and a new chat, also before any read answered', () => {
  assert.deepEqual(continuationNotice({ ...base, stalled: true }), GIVE_UP);
  assert.deepEqual(continuationNotice({ ...closed({ kind: 'confirmed', scope }), stalled: true }), GIVE_UP);
  assert.deepEqual(continuationNotice({ ...base, action: 'check' }), GIVE_UP);
  assert.deepEqual(continuationNotice({ ...base, error: 'Service request timed out' }), GIVE_UP);
});

test('the persistent region announces state lines on a closed chat and the boundary once Continue arrives', () => {
  assert.equal(continuationAnnouncement(null, true), '');
  assert.equal(continuationAnnouncement(closed(null), true), '');
  assert.equal(continuationAnnouncement({ ...closed(null), action: 'start' }, true), 'Continuing…');
  assert.equal(continuationAnnouncement(closed({ kind: 'refused', refusal: 'limit' }), true), 'The agent is over a provider limit.');
  assert.equal(continuationAnnouncement({ ...base, stalled: true }, true), 'AgentUI could not confirm this continuation yet.');
  assert.equal(continuationAnnouncement({ ...base, stalled: true }, false), '');
  const boundary = { closure: 'cancelled', carried: null };
  assert.equal(continuationAnnouncement({ ...base, arrived: 'continue', boundary }, false),
    `Continued in a new provider conversation because the earlier one was stopped. ${NO_CARRY}`);
  assert.equal(continuationAnnouncement({ ...base, boundary }, false), '');
});

test('the earlier-messages control reads Loading while a segment loads and is absent when none is left', () => {
  assert.equal(earlierLabel({ ...base, more: true }), 'Show earlier messages');
  assert.equal(earlierLabel({ ...base, more: true, action: 'earlier' }), 'Loading earlier messages…');
  assert.equal(earlierLabel(base), null);
});
