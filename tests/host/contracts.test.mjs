import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, parseCommand, foldDocument } from '@agentui/contracts';
const scope = { hostId: 'host', conversationId: 'conversation' };
const command = (id, body = { kind: 'send', text: 'hello' }, target = scope) =>
  ({ version: 1, scope: target, clientCommandId: id, body });
const projection = { apply: (state, event) => [...state, event] };

test('commands validate exact keys and canonicalize the entire scoped intent', () => {
  const input = command('id');
  assert.deepEqual(parseCommand(input), input);
  assert.equal(canonicalJson({ z: 1, a: [2, 1] }), '{"a":[2,1],"z":1}');
  assert.notEqual(canonicalJson(input), canonicalJson(command('id', input.body, { ...scope, hostId: 'other' })));
  for (const invalid of [{ ...input, version: 2 }, { ...input, secret: true }, command(''), command('x', { kind: 'approve', pendingId: 'p', choiceId: '' })]) {
    assert.throws(() => parseCommand(invalid));
  }
  assert.throws(() => canonicalJson({ x: undefined }));
  assert.throws(() => canonicalJson(NaN));
});

test('shared wrapper applies immutable receipt and decision events', () => {
  const initial = { domain: [], receipts: {}, decisions: {} };
  const pending = { pendingId: '__proto__', runId: 'r', choices: ['yes'], prompt: 'go?' };
  const opened = foldDocument(initial, { kind: 'decision-opened', decision: pending }, projection);
  assert.deepEqual(Object.keys(opened.decisions), ['__proto__']);
  const closed = foldDocument(opened, { kind: 'decision-closed', pendingId: '__proto__' }, projection);
  assert.deepEqual(closed.decisions, {});
  assert.deepEqual(initial, { domain: [], receipts: {}, decisions: {} });
});

test('canonical JSON rejects non-JSON instances, getters, cycles and excessive structure', () => {
  const cyclic = {}; cyclic.self = cyclic;
  const sparse = []; sparse.length = 2;
  let deep = null;
  for (let index = 0; index < 65; index++) deep = [deep];
  for (const invalid of [new Date(), new Map(), new Set(), cyclic, deep, sparse, { get value() { throw new Error('Getter executed'); } }]) {
    assert.throws(() => canonicalJson(invalid));
  }
  const shared = { same: true };
  assert.equal(canonicalJson([shared, shared]), '[{"same":true},{"same":true}]');
});
