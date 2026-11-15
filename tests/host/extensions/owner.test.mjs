import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerExtensions } from '@agentui/host/extensions';

test('preparation failure and public outcomes cannot mutate retained restart recovery', async () => {
  const owner = createServerExtensions();
  const failure = { kind: 'failed', failure: 'cleanup', recovery: 'restart' };
  const result = await owner.replace({ async prepare() { return failure; } });
  failure.failure = 'load'; failure.recovery = 'replace';
  result.failure = 'load'; result.recovery = 'replace';
  assert.deepEqual(owner.status(), { kind: 'failed', failure: 'cleanup', recovery: 'restart' });
  assert.deepEqual(await owner.replace({ async prepare() { assert.fail('cleanup failure forbids preparation'); } }),
    { kind: 'failed', failure: 'cleanup', recovery: 'restart' });
  const closing = owner.close(); assert.equal(owner.close(), closing);
  await assert.rejects(closing, /^Error: Provider cleanup failed$/);
});
