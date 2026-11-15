import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, copyJson, parseProviderBinding, parseRunAuthority, parseRunIdentity, parseCommand, foldDocument } from '@agentui/contracts';
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


test('run contracts parse exact authority variants and preserve opaque provider identities', () => {
  const binding = { namespace: 'example.crew', installationId: 'i'.repeat(1025), opaqueSessionId: 's'.repeat(1025) };
  const run = { conversation: scope, runId: 'r'.repeat(1025), authority: { kind: 'agentui-host', hostId: scope.hostId, binding } };
  assert.deepEqual(parseProviderBinding(binding), binding);
  for (const authority of [run.authority, { kind: 'remote-provider', binding }]) {
    assert.deepEqual(parseRunAuthority(authority), authority);
    const parsed = parseRunIdentity({ ...run, authority });
    assert.deepEqual(parsed, { ...run, authority });
    assert.notEqual(parsed.authority.binding, binding);
    assert.notEqual(parsed.conversation, scope);
  }
  assert.throws(() => parseRunIdentity({ ...run, authority: { ...run.authority, hostId: 'foreign' } }), /Run authority host mismatch/u);
  assert.throws(() => parseRunAuthority({ kind: 'unknown' }), /Invalid run authority/u);
  for (const authority of [
    {}, { ...run.authority, hostId: '' }, { ...run.authority, hostId: 'h'.repeat(1025) },
    { ...run.authority, extra: true }, { kind: 'remote-provider', hostId: 'h', binding },
    { kind: 'remote-provider', binding: { ...binding, namespace: '' } },
    { kind: 'remote-provider', binding: { ...binding, extra: true } },
    { kind: 'remote-provider', binding: { namespace: 'n', installationId: 'i' } },
  ]) assert.throws(() => parseRunAuthority(authority));
  for (const invalid of [
    { ...run, authority: {} }, { ...run, runId: '' }, { ...run, conversation: {} },
    { ...run, conversation: { ...scope, hostId: 'h'.repeat(1025) } }, { ...run, extra: true },
  ]) assert.throws(() => parseRunIdentity(invalid));
});

test('JSON copy preserves authored order and detaches values through the shared bounded encoder', () => {
  let hooks = 0;
  const source = { zebra: [{ z: 1, a: 2 }], alpha: 3, ['__proto__']: { safe: true } };
  Object.defineProperty(source, 'toJSON', { value() { hooks++; return null; } });
  const copied = copyJson(source);
  assert.deepEqual(copied, source);
  assert.deepEqual(Object.keys(copied), ['zebra', 'alpha', '__proto__']);
  assert.deepEqual(Object.keys(copied.zebra[0]), ['z', 'a']);
  assert.equal(canonicalJson(source), '{"__proto__":{"safe":true},"alpha":3,"zebra":[{"a":2,"z":1}]}');
  copied.zebra[0].z = 9;
  assert.equal(source.zebra[0].z, 1);
  assert.equal(hooks, 0);
  const cycle = {}; cycle.self = cycle;
  const sparse = []; sparse.length = 1;
  const accessor = { get x() { hooks++; return 1; } };
  for (const value of [cycle, sparse, accessor, new Date(), { [Symbol()]: 1 }, { x: undefined }, Infinity]) {
    for (const encode of [copyJson, canonicalJson]) assert.throws(() => encode(value));
  }
  assert.equal(hooks, 0);
  for (const encode of [copyJson, canonicalJson]) {
    assert.throws(() => encode({ a: 1, b: 2 }, { maxNodes: 2, maxDepth: 2 }), /structural limit/u);
    assert.throws(() => encode({ a: { b: 1 } }, { maxNodes: 10, maxDepth: 1 }), /structural limit/u);
    assert.throws(() => encode(1, { maxNodes: 0, maxDepth: 1 }), /Invalid JSON budget/u);
    assert.throws(() => encode('x'.repeat(16_000_001)), /size limit/u);
  }
});
