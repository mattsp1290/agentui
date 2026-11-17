import assert from 'node:assert/strict';
import test from 'node:test';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { chromium } from 'playwright';
import { fixture, providerService } from './provider-stream-fixture.mjs';
import { local, localBackend, localPresentation } from '../extensions/providers/contracts/local.ts';

const sentinel = 'PRIVATE_PROVIDER_STATUS_SENTINEL_31';
const reasons = {
  offline: 'The provider service is offline or unreachable. AgentUI checks again automatically.',
  'authentication-failed': 'The provider rejected the configured credential. Fix it on the provider and AgentUI checks again automatically, or change the extension secret and restart the host.',
  unauthorized: 'The configured credential is not authorized for this provider. Grant it access; AgentUI checks again automatically.',
  'version-unsupported': 'The provider service version is unsupported. Install a compatible version; AgentUI checks again automatically.',
  'invalid-installation': 'The provider installation is invalid. Fix the extension configuration, then restart the host.',
};
function healthy() {
  const entry = { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate(context) {
    context.providers.add('service', { ...local, async connect() { return { kind: 'connected', backend: localBackend }; } }, localPresentation);
    return { dispose() {} };
  } };
  return { value: {
    manifest: { namespace: localPresentation.instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.js' }] },
    entry, installations: [{ id: 'service', instance: localPresentation.instance, service: 'http://127.0.0.1:12345', authentication: { kind: 'unauthenticated' }, expectedAuthority: 'remote-provider' }],
  } };
}
function faulty(remote) {
  const extension = remote.extension(), state = { fault: null, connects: 0 };
  const discover = extension.backend.discover;
  extension.backend.discover = async () => {
    if (state.fault?.at === 'discover') { if (state.fault.result === 'throw') throw new Error(sentinel); return state.fault.result; }
    return discover();
  };
  const activate = extension.value.entry.activate;
  extension.value.entry = { ...extension.value.entry, activate(context) {
    return activate({ ...context, providers: { add(id, provider, presentation) {
      return context.providers.add(id, { ...provider, async connect(request) {
        state.connects++;
        return state.fault?.at === 'connect' ? state.fault.result : provider.connect(request);
      } }, presentation);
    } } });
  } };
  return { extension, state };
}
const causes = [
  ['offline', { at: 'connect', result: { kind: 'unavailable', reason: sentinel } }],
  ['authentication-failed', { at: 'connect', result: { kind: 'authentication-failed', reason: sentinel } }],
  ['unauthorized', { at: 'discover', result: { kind: 'unauthorized', reason: sentinel } }],
  ['version-unsupported', { at: 'connect', result: { kind: 'unsupported', reason: sentinel } }],
  ['invalid-installation', { at: 'discover', result: 'throw' }],
];

for (const [cause, fault] of causes) test(`${cause} provider stays listed with its fixed reason while natives and healthy providers keep serving`, { timeout: 15000 }, async t => {
  const remote = await providerService(t), { extension, state } = faulty(remote), peer = healthy();
  const f = await fixture(t, [extension, peer]);
  const original = (await f.client.metadata()).agents.find(agent => agent.kind === 'provider' && agent.namespace === 'stream-fixture');
  const scope = f.scope('outage');
  await f.client.create(scope, original.id);
  state.fault = fault;
  if (fault.at === 'connect') await f.restart([extension, peer]);
  else await f.control({ op: 'providers-refresh' });

  const metadata = await f.client.metadata();
  const byNamespace = namespace => metadata.agents.filter(agent => agent.kind === 'provider' && agent.namespace === namespace);
  assert.ok(metadata.agents.some(agent => agent.kind !== 'provider' && agent.availability.kind === 'ready' && agent.id === metadata.defaultAgentId));
  assert.deepEqual(byNamespace(localPresentation.instance.namespace).map(agent => agent.availability.kind), ['ready']);
  assert.deepEqual(byNamespace('stream-fixture').map(agent => [agent.label, agent.availability]),
    [['stream-fixture · stream-installation', { kind: 'unavailable', reason: reasons[cause] }]]);
  assert.deepEqual((await f.client.conversationAgent(scope)).availability, { kind: 'unavailable', reason: reasons[cause] });
  assert.equal((await f.client.conversationAgent(scope)).id, original.id);
  assert.deepEqual((await f.client.catalog()).map(item => item.scope), [scope]);
  assert.deepEqual(await f.control({ op: 'providers-refresh' }), [
    { contributionId: 'service', namespace: 'stream-fixture', kind: 'unavailable', cause },
    { contributionId: 'service', namespace: localPresentation.instance.namespace, kind: 'available' },
  ]);
  assert.doesNotMatch(JSON.stringify([metadata, await f.client.conversationAgent(scope), await f.control({ op: 'providers-refresh' })]), new RegExp(sentinel));

  state.fault = null;
  if (cause === 'invalid-installation') {
    assert.equal((await f.control({ op: 'providers-refresh' }))[0].kind, 'unavailable');
    assert.equal((await f.running.replaceProviderExtensions([extension.value, peer.value])).kind, 'replaced');
  } else {
    assert.equal((await f.control({ op: 'providers-refresh' }))[0].kind, 'available');
  }
  assert.deepEqual((await f.client.conversationAgent(scope)).availability, { kind: 'ready' });
  assert.equal((await f.client.metadata()).agents.find(agent => agent.id === original.id).availability.kind, 'ready');
});

test('a removed provider keeps the no-longer-configured explanation', { timeout: 15000 }, async t => {
  const remote = await providerService(t), extension = remote.extension(), peer = healthy();
  const f = await fixture(t, [extension, peer]), scope = await f.create('removed');
  await f.restart([peer]);
  assert.deepEqual((await f.client.conversationAgent(scope)).availability,
    { kind: 'unavailable', reason: 'This conversation’s provider is no longer configured.' });
  assert.equal((await f.client.metadata()).agents.filter(agent => agent.availability.kind === 'unavailable').length, 0);
});

test('browser chooser lists an offline provider as a disabled choice with its fixed reason', { timeout: 30000 }, async t => {
  const remote = await providerService(t), { extension, state } = faulty(remote);
  state.fault = causes[0][1];
  const f = await fixture(t, [extension, healthy()]);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: /^Harness,/ }).click();
  await page.getByRole('button', { name: 'Provider', exact: true }).click();
  const offline = page.getByRole('button', { name: 'Start new chat with stream-fixture · stream-installation', exact: true });
  assert.equal(await offline.isDisabled(), true);
  assert.equal(await offline.getAttribute('title'), reasons.offline);
});

test('a provider that goes offline after a healthy discovery is reported unavailable without a refresh command', { timeout: 15000 }, async t => {
  const remote = await providerService(t), { extension, state } = faulty(remote);
  const f = await fixture(t, [extension, healthy()]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const status = async () => (await f.client.metadata()).agents.filter(agent => agent.namespace === 'stream-fixture').map(agent => agent.availability);
  assert.deepEqual((await status()).map(availability => availability.kind), ['ready']);
  state.fault = { at: 'discover', result: { kind: 'unavailable', reason: sentinel } };
  t.mock.timers.tick(30_000);
  let current = await status();
  for (let attempt = 0; attempt < 200 && current[0]?.kind === 'ready'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    current = await status();
  }
  assert.deepEqual(current, [{ kind: 'unavailable', reason: reasons.offline }]);
});

test('an offline provider becomes available after its service recovers without a refresh command, checked at most once per interval',{ timeout: 15000 }, async t => {
  const remote = await providerService(t), { extension, state } = faulty(remote);
  state.fault = causes[0][1];
  const f = await fixture(t, [extension, healthy()]);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const status = async () => (await f.client.metadata()).agents.filter(agent => agent.namespace === 'stream-fixture').map(agent => agent.availability.kind);
  const startup = state.connects;
  assert.deepEqual(await status(), ['unavailable']);
  t.mock.timers.tick(29_000);
  await Promise.all([status(), status(), status()]);
  assert.equal(state.connects, startup);
  t.mock.timers.tick(1_000);
  assert.deepEqual(await Promise.all([status(), status(), status()]), [['unavailable'], ['unavailable'], ['unavailable']]);
  await status();
  assert.equal(state.connects, startup + 1);

  state.fault = null;
  t.mock.timers.tick(29_000);
  assert.deepEqual(await status(), ['unavailable']);
  assert.equal(state.connects, startup + 1);
  t.mock.timers.tick(1_000);
  assert.deepEqual(await status(), ['unavailable']);
  let recovered = [];
  for (let attempt = 0; attempt < 200 && recovered[0] !== 'ready'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    recovered = await status();
  }
  assert.deepEqual(recovered, ['ready']);
  assert.equal(state.connects, startup + 2);
});
