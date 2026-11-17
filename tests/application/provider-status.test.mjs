import assert from 'node:assert/strict';
import test from 'node:test';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { chromium } from 'playwright';
import { fixture, providerService } from './provider-stream-fixture.mjs';
import { local, localBackend, localPresentation } from '../extensions/providers/contracts/local.ts';

const sentinel = 'PRIVATE_PROVIDER_STATUS_SENTINEL_31';
const reasons = {
  offline: 'The provider service is offline or unreachable. Start it, then refresh providers.',
  'authentication-failed': 'The provider rejected the configured credential. Update the credential, then refresh providers.',
  unauthorized: 'The configured credential is not authorized for this provider. Check its access, then refresh providers.',
  'version-unsupported': 'The provider service version is unsupported. Install a compatible version, then refresh providers.',
  'invalid-installation': 'The provider installation is invalid. Check the extension configuration, then replace the extension.',
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
  const extension = remote.extension(), state = { fault: null };
  const discover = extension.backend.discover;
  extension.backend.discover = async () => {
    if (state.fault?.at === 'discover') { if (state.fault.result === 'throw') throw new Error(sentinel); return state.fault.result; }
    return discover();
  };
  const activate = extension.value.entry.activate;
  extension.value.entry = { ...extension.value.entry, activate(context) {
    return activate({ ...context, providers: { add(id, provider, presentation) {
      return context.providers.add(id, { ...provider, async connect(request) {
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
  assert.deepEqual(byNamespace('stream-fixture').map(agent => agent.availability), [{ kind: 'unavailable', reason: reasons[cause] }]);
  assert.deepEqual((await f.client.conversationAgent(scope)).availability, { kind: 'unavailable', reason: reasons[cause] });
  assert.equal((await f.client.conversationAgent(scope)).id, original.id);
  assert.deepEqual((await f.client.catalog()).map(item => item.scope), [scope]);
  assert.deepEqual(await f.control({ op: 'providers-refresh' }), [
    { contributionId: 'service', namespace: 'stream-fixture', kind: 'unavailable', cause, reason: reasons[cause] },
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
  await context.addCookies([{ name: f.cookie.split('=')[0], value: f.cookie.split('=')[1], url: f.running.origin }]);
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  await page.goto(`${f.running.origin}/browser.html`);
  await page.getByRole('button', { name: /^Harness,/ }).click();
  await page.getByRole('button', { name: 'Provider', exact: true }).click();
  const offline = page.getByRole('button', { name: 'Start new chat with stream-fixture', exact: true });
  assert.equal(await offline.isDisabled(), true);
  assert.equal(await offline.getAttribute('title'), reasons.offline);
});
