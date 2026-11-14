import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, installed, scope, command, snapshot, note, empty, completed } from './fixture.mjs';

test('listing an empty host never creates a conversation', async t => {
  const f = fixture(t), host = f.open();
  assert.deepEqual(host.listConversations(scope.hostId, null, 10), []);
  assert.deepEqual(host.listConversations(scope.hostId, scope.conversationId, 10), []);
  assert.deepEqual(await host.conversation(scope).submit(command('unknown')), {
    kind: 'rejected', reason: 'unknown-conversation',
  });
  host.close();
  assert.deepEqual(f.open().listConversations(scope.hostId, null, 10), []);
});

test('catalog pages are scoped, lexicographic, bounded and exclusive', t => {
  const host = fixture(t).open();
  const scopes = ['z', 'a', 'aa', 'b', 'B'].map(conversationId => ({ hostId: scope.hostId, conversationId }));
  for (const value of scopes) host.createConversation(value, installed);
  host.createConversation({ hostId: 'other-host', conversationId: 'a' }, installed);
  assert.deepEqual(host.listConversations(scope.hostId, null, 2), [scopes[4], scopes[1]]);
  assert.deepEqual(host.listConversations(scope.hostId, 'a', 2), [scopes[2], scopes[3]]);
  assert.deepEqual(host.listConversations(scope.hostId, 'b', 2), [scopes[0]]);
  assert.deepEqual(host.listConversations(scope.hostId, 'z', 2), []);
  assert.deepEqual(host.listConversations(scope.hostId, 'ab', 2), [scopes[3], scopes[0]]);
  assert.deepEqual(host.listConversations('other-host', null, 10), [{ hostId: 'other-host', conversationId: 'a' }]);
  assert.deepEqual(host.listConversations('missing-host', null, 10), []);
});

test('the largest supported catalog page can be followed without gaps', t => {
  const host = fixture(t).open();
  const scopes = Array.from({ length: 105 }, (_, i) => ({
    hostId: scope.hostId, conversationId: String(i).padStart(3, '0'),
  }));
  for (const value of [...scopes].reverse()) host.createConversation(value, installed);
  const first = host.listConversations(scope.hostId, null, 100);
  assert.deepEqual(first, scopes.slice(0, 100));
  assert.deepEqual(host.listConversations(scope.hostId, first.at(-1).conversationId, 100), scopes.slice(100));
  assert.deepEqual(host.listConversations(scope.hostId, '104', 1), []);
});

test('each bounded catalog page fails closed when any scope is unauthorized', t => {
  const f = fixture(t), creator = f.open();
  const visible = { hostId: scope.hostId, conversationId: 'a-visible' };
  const secret = { hostId: scope.hostId, conversationId: 'b-private-secret' };
  creator.createConversation(visible, installed);
  creator.createConversation(secret, installed);
  const host = f.open({ authorize: value => value.conversationId === visible.conversationId });
  assert.deepEqual(host.listConversations(scope.hostId, null, 1), [visible]);
  assert.throws(() => host.listConversations(scope.hostId, null, 2), error =>
    error.message === 'Unauthorized scope' && !error.message.includes(secret.conversationId));
  assert.throws(() => host.listConversations(scope.hostId, visible.conversationId, 1), /Unauthorized scope/);
  const denied = f.open({ authorize: () => false });
  assert.throws(() => denied.listConversations(scope.hostId, null, 1), /Unauthorized scope/);
  assert.deepEqual(denied.listConversations('unknown-host', null, 1), []);
});

test('authorization exceptions propagate without returning a partial catalog', t => {
  const f = fixture(t), creator = f.open();
  creator.createConversation(scope, installed);
  const failure = new Error('authorization unavailable');
  const host = f.open({ authorize: () => { throw failure; } });
  assert.throws(() => host.listConversations(scope.hostId, null, 10), error => error === failure);
});

test('catalog inputs are parsed before listing and closed hosts refuse listing', t => {
  const host = fixture(t).open();
  for (const hostId of ['', null, undefined, 1, {}, 'x'.repeat(1025)]) {
    assert.throws(() => host.listConversations(hostId, null, 1));
  }
  for (const after of ['', undefined, 1, {}, 'x'.repeat(1025)]) {
    assert.throws(() => host.listConversations(scope.hostId, after, 1));
  }
  for (const limit of [0, -1, 101, 1.5, NaN, Infinity, '1', null, undefined]) {
    assert.throws(() => host.listConversations(scope.hostId, null, limit), /Invalid catalog limit/);
  }
  host.close();
  assert.throws(() => host.listConversations(scope.hostId, null, 1), /Host is closed/);
});

test('creation retries preserve conversation state and installation across reopen', async t => {
  const captured = [];
  const f = fixture(t, { resolve: async (_command, target) => {
    captured.push(target.installation);
    return completed(empty());
  } });
  const host = f.open();
  host.createConversation(scope, installed);
  host.append(scope, note('retained'));
  const before = await snapshot(host.conversation(scope));
  host.createConversation(scope, structuredClone(installed));
  assert.deepEqual(await snapshot(host.conversation(scope)), before);
  assert.throws(() => host.createConversation(scope, { ...installed, installationId: 'replacement' }), /immutable/);
  assert.throws(() => host.createConversation(scope, {
    ...installed, binding: { ...installed.binding, account: 'replacement' },
  }), /immutable/);
  assert.deepEqual(host.listConversations(scope.hostId, null, 10), [scope]);
  host.close();
  const reopened = f.open();
  assert.deepEqual(reopened.listConversations(scope.hostId, null, 10), [scope]);
  assert.deepEqual(await snapshot(reopened.conversation(scope)), before);
  reopened.createConversation(scope, structuredClone(installed));
  assert.throws(() => reopened.createConversation(scope, { ...installed, installationId: 'replacement' }), /immutable/);
  assert.equal((await reopened.conversation(scope).submit(command('original-installation'))).receipt.state.kind, 'completed');
  assert.deepEqual(captured, [installed]);
});

test('unauthorized or invalid creation leaves no catalog entry', t => {
  const f = fixture(t), host = f.open({ authorize: () => false });
  assert.throws(() => host.createConversation(scope, installed), /Unauthorized scope/);
  const allowed = f.open();
  assert.throws(() => allowed.createConversation(scope, { ...installed, installationId: '' }));
  assert.deepEqual(allowed.listConversations(scope.hostId, null, 10), []);
});
