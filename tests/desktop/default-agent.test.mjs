import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_RUNTIME, PI_RUNTIME, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import { defaultAgentSelector, resolveDefaultAgent } from '../../apps/desktop/dist/application/default-agent.js';

const ready = { kind: 'ready' };
const native = (id, runtime, extra = {}) => ({ id, label: id, runtime, availability: ready, commands: ['send'], ...extra });
const provider = (id, extra = {}) => ({ id, label: id, kind: 'provider', namespace: 'alpha', installationId: 'personal', providerAgentId: 'fixture',
  availability: ready, commands: [], ...extra });
const metadata = (agents, defaultAgentId = agents[0]?.id ?? null) => ({ agents, defaultAgentId });
const settings = defaultAgent => ({ version: 1, appearance: 'system', showExtensionViews: true, ...(defaultAgent ? { defaultAgent } : {}) });

test('a provider selector matches the descriptor with the same namespace, installation and provider agent', () => {
  const agents = [native('pi', PI_RUNTIME), provider('p-other', { providerAgentId: 'other' }), provider('p-1')];
  assert.equal(resolveDefaultAgent(settings({ kind: 'provider', namespace: 'alpha', installationId: 'personal', providerAgentId: 'fixture' }), metadata(agents)), 'p-1');
  assert.equal(resolveDefaultAgent(settings({ kind: 'provider', namespace: 'beta', installationId: 'personal', providerAgentId: 'fixture' }), metadata(agents)), null);
});

test('a native selector with a model matches that model in the harness group; without one the host default, else the first ready agent', () => {
  const agents = [native('codex-a', CODEX_RUNTIME, { model: { id: 'model-a', label: 'A' } }), native('codex-b', CODEX_RUNTIME, { model: { id: 'model-b', label: 'B' } }),
    native('pi', PI_RUNTIME), native('recorded', RECORDED_RUNTIME)];
  assert.equal(resolveDefaultAgent(settings({ kind: 'native', harness: 'codex', model: 'model-b' }), metadata(agents)), 'codex-b');
  assert.equal(resolveDefaultAgent(settings({ kind: 'native', harness: 'codex', model: 'missing' }), metadata(agents)), null);
  assert.equal(resolveDefaultAgent(settings({ kind: 'native', harness: 'codex' }), metadata(agents, 'codex-b')), 'codex-b', 'the host default when in the group');
  assert.equal(resolveDefaultAgent(settings({ kind: 'native', harness: 'codex' }), metadata(agents, 'pi')), 'codex-a', 'else the first in picker order');
  assert.equal(resolveDefaultAgent(settings({ kind: 'native', harness: 'recorded' }), metadata(agents, 'pi')), 'recorded');
  assert.equal(resolveDefaultAgent(settings(), metadata(agents)), null, 'no stored default');
  assert.equal(resolveDefaultAgent(null, metadata(agents)), null);
});

test('a match that is not ready resolves to nothing, so the host default is used', () => {
  const unavailable = { kind: 'unavailable', reason: 'Not configured' };
  const agents = [native('pi', PI_RUNTIME, { availability: unavailable }), provider('p-1', { availability: unavailable })];
  assert.equal(resolveDefaultAgent(settings({ kind: 'native', harness: 'pi' }), metadata(agents)), null);
  assert.equal(resolveDefaultAgent(settings({ kind: 'provider', namespace: 'alpha', installationId: 'personal', providerAgentId: 'fixture' }), metadata(agents)), null);
});

test('the stored selector names what an agent is, never its host-local ID', () => {
  assert.deepEqual(defaultAgentSelector(provider('p-1')), { kind: 'provider', namespace: 'alpha', installationId: 'personal', providerAgentId: 'fixture' });
  assert.deepEqual(defaultAgentSelector(native('codex-a', CODEX_RUNTIME, { model: { id: 'model-a', label: 'A' } })), { kind: 'native', harness: 'codex', model: 'model-a' });
  assert.deepEqual(defaultAgentSelector(native('pi', PI_RUNTIME)), { kind: 'native', harness: 'pi' });
  assert.equal(defaultAgentSelector(provider('p-x', { providerAgentId: null })), null);
});
