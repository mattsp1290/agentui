import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, installed, scope, command } from './fixture.mjs';
const offered = (scope, clientCommandId = 'offered') => ({ version: 2, scope, clientCommandId,
  body: { kind: 'send', text: 'Hello', frontend: { platform: 'desktop',
    tools: [{ definition: { name: 'test__inspect', description: 'Inspect' }, activationId: 'original' }] } } });

const actor = { id: 'owner', platform: 'desktop', authorized: () => true };
test('native offers bypass capability while exact retries and conflicts retain admission precedence', async t => {
  const f = fixture(t);
  let supported = true, capabilities = 0, dispatches = 0;
  const driver = { ...f.driver,
    capability(value) { capabilities++; assert.equal(value.version, 1); return supported ? { kind: 'supported' } : { kind: 'unsupported', reason: 'disabled' }; },
    dispatch(...args) { dispatches++; return f.driver.dispatch(...args); },
  };
  const host = f.open({ driver }); host.createConversation(scope, installed);
  const port = host.conversation(scope, actor);
  assert.deepEqual(await port.submit(offered(scope)), { kind: 'rejected', reason: 'frontend-offers-unsupported' });
  assert.equal(capabilities, 0); assert.equal(dispatches, 0);
  const original = command('original'), receipt = (await port.submit(original)).receipt;
  assert.equal(receipt.state.kind, 'completed');
  supported = false;
  assert.deepEqual((await port.submit(original)).receipt, receipt);
  assert.equal(dispatches, 1);
  assert.deepEqual(await port.submit(offered(scope, 'original')), { kind: 'rejected', reason: 'command-id-conflict' });
  assert.equal(capabilities, 2); assert.equal(dispatches, 1);
  assert.equal(await port.receipt('offered'), null);
  assert.deepEqual(await port.submit(command('permission', { kind: 'revoke-permission', permissionId: 'permission', scope: 'conversation' })),
    { kind: 'rejected', reason: 'permission-management-unsupported' });
  assert.equal(capabilities, 2);
});

test('a missing native driver preserves plain unavailability and refuses offers without dispatch', async t => {
  const f = fixture(t), host = f.open({ driver: [] }); host.createConversation(scope, installed);
  const port = host.conversation(scope, actor);
  assert.deepEqual(await port.submit(command('plain')), { kind: 'rejected', reason: 'This conversation’s agent is unavailable or belongs to a different agent or workspace.' });
  assert.deepEqual(await port.submit(offered(scope)), { kind: 'rejected', reason: 'frontend-offers-unsupported' });
});
