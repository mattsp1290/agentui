import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openLocalHost } from '@agentui/host';
import { transcriptProjection } from '@agentui/contracts/conversation';

const installation = { kind: 'provider', contributionId: 'test', instance: { namespace: 'test', installationId: 'test', generation: '1', protocolVersion: '1' },
  agent: { opaqueId: 'agent', name: 'Agent' }, presentationVersion: 1, expectedAuthority: 'remote-provider' };
function fixture(t, observe) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-observation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const providers = {
    captureCommand() { assert.fail('No command capture'); }, executeCommand() { assert.fail('No command effect'); }, observe,
    capture(scope) { return { installation, credential: null, intent: { kind: 'create', operationId: randomUUID(), scope,
      agent: { kind: 'agent', instance: installation.instance, opaqueId: installation.agent.opaqueId } } }; },
    async execute(original) { return { kind: 'confirmed', source: 'create', evidence: null, binding: { kind: 'agentui-created', creation: original.intent,
      authority: { kind: 'remote-provider', binding: { namespace: 'test', installationId: 'test', opaqueSessionId: 'session' } } } }; },
  };
  const host = openLocalHost({ path: join(directory, 'host.sqlite'), projection: transcriptProjection, driver: [], providers, authorize: () => true });
  return { host, async create(id = 'chat') { const scope = { hostId: 'host', conversationId: id }; await host.createProviderConversation(scope, installation, providers); return scope; } };
}

for (const failure of ['close', 'drain', 'late-start-close']) {
  test(`local host ${failure} failure waits for every observation and retains writer storage`, async t => {
    const start = Promise.withResolvers(), first = Promise.withResolvers(), second = Promise.withResolvers();
    let calls = 0, stopped = 0, store, original;
    const f = fixture(t, async (creation, value) => {
      store = value; original = creation;
      const index = ++calls;
      if (failure === 'late-start-close' && index === 2) await start.promise;
      return { close() {
        stopped++;
        if (index === 1) {
          if (failure === 'drain') first.reject(new Error('unestablished drain')); else first.resolve();
          if (failure === 'close') throw new Error('cannot stop writer');
        } else if (failure === 'late-start-close') { second.resolve(); throw new Error('late writer cannot stop'); }
      }, drained: index === 1 ? first.promise : second.promise };
    });
    const outcome = f.host.drained.then(() => 'closed', () => 'failed');
    await f.create();
    const creating = f.create('other');
    await new Promise(resolve => setImmediate(resolve));
    f.host.close(); start.resolve(); await creating;
    await new Promise(resolve => setImmediate(resolve));
    second.resolve();
    assert.equal(await outcome, 'failed');
    assert.equal(stopped, 2);
    assert.equal(store.providerCheckpoint(original), null);
    store.close();
  });
}

test('local host shares starting and live observations and retries failed or drained starts', async t => {
  let calls = 0, stream, store;
  const f = fixture(t, async (_original, value) => {
    store = value; calls++;
    if (calls === 1) throw new Error('temporarily unavailable');
    const end = Promise.withResolvers();
    stream = { close() { end.resolve(); }, drained: end.promise };
    return stream;
  });
  const scope = await f.create(); assert.equal(calls, 1);
  await Promise.all(Array.from({ length: 5 }, () => f.host.observeProvider(scope))); assert.equal(calls, 2);
  await Promise.all(Array.from({ length: 5 }, () => f.host.observeProvider(scope))); assert.equal(calls, 2);
  stream.close(); await new Promise(resolve => setImmediate(resolve));
  await f.host.observeProvider(scope); assert.equal(calls, 3);
  const original = f.host.creation(scope);
  f.host.close(); await f.host.drained;
  assert.throws(() => store.providerCheckpoint(original), /closed|not open/i);
});
