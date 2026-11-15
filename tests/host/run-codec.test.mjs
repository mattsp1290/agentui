import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeRun } from '../../packages/host/dist/codec.js';
import { installed, run, scope } from './fixture.mjs';

test('native run decoding retains host authority and native reference checks', () => {
  const source = run();
  source.identity.authority.binding.namespace = 'example.crew';
  assert.deepEqual(nativeRun(source, installed, scope), source);
  const cases = [
    [value => { value.identity.conversation.conversationId = 'foreign'; }, /Foreign run authority/u],
    [value => { value.identity.authority = { kind: 'remote-provider', binding: value.identity.authority.binding }; }, /Foreign run authority/u],
    [value => { value.identity.authority.hostId = 'foreign'; }, /Run authority host mismatch/u],
    [value => { value.identity.authority.binding.installationId = 'foreign'; }, /Foreign run authority/u],
    [value => { value.reference.binding.account = 'foreign'; }, /Invalid native reference/u],
    [value => { value.identity.authority.binding.opaqueSessionId = 'foreign'; }, /Session identity mismatch/u],
  ];
  for (const [change, expected] of cases) {
    const invalid = structuredClone(source);
    change(invalid);
    assert.throws(() => nativeRun(invalid, installed, scope), expected);
  }
});

test('persisted native run identity rejects extra fields at every contract boundary', () => {
  for (const path of [[], ['conversation'], ['authority'], ['authority', 'binding']]) {
    const persisted = JSON.parse(JSON.stringify(run()));
    let value = persisted.identity;
    for (const field of path) value = value[field];
    value.extra = true;
    assert.throws(() => nativeRun(persisted, installed, scope), /Unexpected or missing field/u);
  }
});
