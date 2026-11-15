import assert from 'node:assert/strict';
import test from 'node:test';
import { crewPresentation, crewBinding, crewRun } from './crew.ts';
import { localPresentation, localBinding } from './local.ts';

test('public presentation decoders and reducers preserve distinct models and previous state', () => {
  const refs = { run(ref) { assert.equal(ref, crewRun); return { conversation: ref.binding.creation.scope, authority: ref.binding.authority, runId: 'visible-run' }; } };
  const crew = crewPresentation.apply(crewPresentation.decodeState({ messages: ['first'] }), crewPresentation.decodeEvent({ kind: 'message', text: 'second' }), refs);
  assert.deepEqual(crew.state, { messages: ['first', 'second'] });
  assert.deepEqual(crewPresentation.request('hello', crewBinding), crewPresentation.decodeRequest({ member: 'research', text: 'hello' }));
  assert.deepEqual(crewPresentation.decodeCursor({ checkpoint: 'next', stream: 2 }), { checkpoint: 'next', stream: 2 });
  assert.equal(crewPresentation.snapshot(crew.state, refs).messages[1].text, 'second');
  const local = localPresentation.apply(localPresentation.decodeState({ transcript: 'first ' }), localPresentation.decodeEvent({ append: 'second' }), refs);
  assert.deepEqual(local.state, { transcript: 'first second' });
  assert.deepEqual(localPresentation.request('hello', localBinding), localPresentation.decodeRequest({ input: [{ role: 'user', content: 'hello' }] }));
  assert.deepEqual(localPresentation.decodeCursor([2, 3]), [2, 3]);
  assert.equal(localPresentation.snapshot(local.state, refs).messages[0].text, 'first second');
  for (const view of [crewPresentation, localPresentation]) for (const decode of [view.decodeRequest, view.decodeCursor, view.decodeState, view.decodeEvent]) {
    assert.throws(() => decode(null));
  }
  assert.throws(() => crewPresentation.decodeState(local.state));
  assert.throws(() => localPresentation.decodeEvent({ kind: 'message', text: 'wrong model' }));
});
