import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { chromium } from 'playwright';
import { createCrewFixture } from '../../extensions/providers/contracts/crew.ts';
import { createBrowserConnection } from '@agentui/client/service';
import { recordedInstallation } from '@agentui/host/recorded';
import { describeAgent } from '../../../apps/host/build/tsc/agents.js';
import { entry, options, startBrowserHost } from './fixtures.mjs';

async function open(t, selected, configured = options(t), cleanupFails = false) {
  const host = await startBrowserHost({ ...configured, agentStartup: { kind: 'extensions' }, accessMode: 'trusted', extensions: { kind: 'transient', entries: selected.map(value => value.value) } });
  t.after(async () => { if (cleanupFails) await assert.rejects(host.close(), /shutdown failed/); else await host.close(); });
  const client = createBrowserConnection({ fetch: (path, init) => fetch(host.origin + path, { ...init, headers: { ...init.headers, Origin: host.origin } }) });
  const inspect = action => { const db = new DatabaseSync(join(configured.directory, 'host.sqlite')); try { return action(db); } finally { db.close(); } };
  return { host, client, configured, inspect, scope: conversationId => ({ hostId: host.hostId, conversationId }) };
}
function assertDefault(metadata) {
  const ready = metadata.agents.filter(agent => agent.availability.kind === 'ready').map(agent => agent.id).sort();
  assert.equal(metadata.defaultAgentId, ready[0] ?? null);
  assert.equal(metadata.compatibility.nativeRuntime, null);
  assert.ok(metadata.agents.every(agent => agent.kind === 'provider'));
  return metadata.defaultAgentId;
}
const confirmed = (operation, fixture) => fixture.confirmed(operation);
const originals = f => f.inspect(db => db.prepare('SELECT original FROM provider_creations ORDER BY conversation').all());

test('extension-only defaults use stable ready IDs across discovery order, labels, replacement and restart', { timeout: 10000 }, async t => {
  let reverse = false;
  const a = entry(t, { label: 'a', discover(fixture) {
    const instance = fixture.value.installations[0].instance;
    const agents = ['one', 'two'].map(id => ({ ref: { instance, kind: 'agent', opaqueId: id }, name: reverse ? `renamed ${id}` : id }));
    return { kind: 'available', agents: reverse ? agents.reverse() : agents };
  } });
  const b = entry(t, { label: 'b', namespace: 'example-b' });
  const f = await open(t, [a, b]);
  const first = await f.client.metadata(), initialDefault = assertDefault(first);
  reverse = true; await f.host.discoverProviders();
  assert.equal(assertDefault(await f.client.metadata()), initialDefault);
  await f.host.replaceProviderExtensions([b.value, a.value]);
  assert.equal(assertDefault(await f.client.metadata()), initialDefault);
  await f.host.close();
  const restarted = await open(t, [b, a], f.configured);
  assert.equal(assertDefault(await restarted.client.metadata()), initialDefault);
  assert.equal(existsSync(join(f.configured.directory, 'recorded.jsonl')), false);
  const recorded = describeAgent(recordedInstallation, { kind: 'ready' });
  await assert.rejects(restarted.client.create(restarted.scope('no-recorded'), recorded.id), error => error.kind === 'create-rejected');
});

test('extension-only metadata follows changing, empty and failed replacement without retaining a default', { timeout: 10000 }, async t => {
  const old = entry(t, { label: 'old' }), entered = Promise.withResolvers(), finish = Promise.withResolvers();
  const next = entry(t, { label: 'next', async activate() { entered.resolve(); await finish.promise; } });
  const f = await open(t, [old]), oldId = assertDefault(await f.client.metadata());
  const replacing = f.host.replaceProviderExtensions([next.value]);
  try {
    await entered.promise;
    const changing = await f.client.metadata(); assertDefault(changing); assert.deepEqual(changing.agents, []);
    assert.equal(changing.defaultAgentId, null); assert.deepEqual(await f.client.catalog(), []);
    finish.resolve(); assert.equal((await replacing).kind, 'replaced');
    assert.notEqual(assertDefault(await f.client.metadata()), oldId);
    await f.host.replaceProviderExtensions([]);
    assert.equal(assertDefault(await f.client.metadata()), null);
    await f.host.replaceProviderExtensions([old.value]);
    assert.equal(assertDefault(await f.client.metadata()), oldId);
    const bad = entry(t, { label: 'bad', discover() { throw new Error('private'); } });
    assert.equal((await f.host.replaceProviderExtensions([bad.value])).kind, 'failed');
    assert.equal(assertDefault(await f.client.metadata()), null);
    assert.deepEqual((await f.client.metadata()).agents, []);
    await f.host.replaceProviderExtensions([next.value]);
    assert.notEqual(assertDefault(await f.client.metadata()), null);
  } finally { finish.resolve(); await replacing; }
});

for (const phase of ['import', 'activate', 'discover', 'dispose']) test(`extension-only ${phase} failure never advertises the retired default`, { timeout: 10000 }, async t => {
  const old = entry(t, { label: 'old', ...(phase === 'dispose' ? { dispose() { throw new Error('private'); } } : {}) });
  const bad = entry(t, { label: 'bad', ...(phase === 'dispose' ? {} : { [phase]() { throw new Error('private'); } }) });
  const f = await open(t, [old], options(t), phase === 'dispose'); assert.ok(assertDefault(await f.client.metadata()));
  assert.equal((await f.host.replaceProviderExtensions([bad.value])).kind, 'failed');
  assert.equal(assertDefault(await f.client.metadata()), null);
  assert.deepEqual((await f.client.metadata()).agents, []);
  assert.deepEqual(await f.client.catalog(), []);
});

test('extension-only removal preserves confirmed and uncertain original creations and rejects stale routing', { timeout: 10000 }, async t => {
  const old = entry(t, { label: 'old', create: confirmed });
  const uncertain = entry(t, { label: 'uncertain', namespace: 'uncertain-provider', create: () => ({ kind: 'uncertain', reason: 'Lost', evidence: null }) });
  const next = entry(t, { label: 'next', create: confirmed, lookup: confirmed });
  const f = await open(t, [old, uncertain]);
  const metadata = await f.client.metadata(), oldId = metadata.agents.find(agent => agent.label === 'old').id;
  const uncertainId = metadata.agents.find(agent => agent.label === 'uncertain').id;
  const scope = f.scope('saved'), pending = f.scope('pending');
  await f.client.create(scope, oldId);
  await assert.rejects(f.client.create(pending, uncertainId), error => error.kind === 'unavailable');
  const before = originals(f);
  await f.host.replaceProviderExtensions([]);
  assert.equal(assertDefault(await f.client.metadata()), null);
  assert.equal((await f.client.conversationAgent(scope)).id, oldId);
  assert.equal((await f.client.conversationAgent(scope)).availability.kind, 'unavailable');
  assert.deepEqual((await f.client.catalog()).map(item => item.scope), [scope]);
  const watch = f.client.conversation(scope).watch({ after: null, projectionVersion: 2 }, () => {});
  watch.close(); await watch.ended;
  await f.client.create(scope, oldId);
  await f.host.replaceProviderExtensions([next.value]);
  const nextId = assertDefault(await f.client.metadata());
  await assert.rejects(f.client.create(f.scope('stale'), oldId), error => error.kind === 'create-rejected');
  await assert.rejects(f.client.create(pending, uncertainId), error => error.kind === 'unavailable');
  await assert.rejects(f.client.create(pending, nextId), error => error.kind === 'invalid');
  assert.equal(next.calls.creates.length + next.calls.lookups.length, 0);
  assert.deepEqual(originals(f), before);
});

test('a lexically smaller unavailable provider stays listed while a ready provider becomes default', { timeout: 10000 }, async t => {
  const a = entry(t, { label: 'a' }), b = entry(t, { label: 'b', namespace: 'example-b' });
  const f = await open(t, [a, b]);
  const first = await f.client.metadata(), lowest = first.agents.find(agent => agent.id === first.defaultAgentId);
  const previous = lowest.label === 'a' ? a : b, remaining = previous === a ? b : a;
  const instance = previous.value.installations[0].instance;
  const capabilities = createCrewFixture(instance).crewBackend.capabilities;
  const unavailable = entry(t, { label: previous.label, namespace: instance.namespace,
    capabilities: { ...capabilities, create: { kind: 'unsupported', reason: 'Read only' } } });
  await f.host.replaceProviderExtensions([unavailable.value, remaining.value]);
  const changed = await f.client.metadata(); assertDefault(changed);
  assert.equal(changed.agents.find(agent => agent.id === lowest.id).availability.kind, 'unavailable');
  assert.notEqual(changed.defaultAgentId, lowest.id);
  await f.host.replaceProviderExtensions([unavailable.value]);
  const last = await f.client.metadata(); assert.equal(assertDefault(last), null); assert.equal(last.agents.length, 1);
});

test('browser idle presentation follows the provider and becomes neutral after empty replacement', { timeout: 20000 }, async t => {
  const provider = entry(t, { label: 'browser-provider' }), f = await open(t, [provider]);
  const browser = await chromium.launch(); t.after(() => browser.close());
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(f.host.origin + '/browser.html');
  await page.getByRole('button', { name: 'New conversation', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.action-row button')?.disabled);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.locator('.application-status strong').innerText(), 'browser-provider');
  assert.doesNotMatch(await page.locator('body').innerText(), /Recorded playback|Recorded host/);
  await f.host.replaceProviderExtensions([]);
  await page.reload();
  await page.getByText('No agents are available to start a conversation.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'New conversation', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await page.locator('.application-status strong').innerText(), 'Local agent');
  assert.doesNotMatch(await page.locator('body').innerText(), /Recorded playback|Recorded host/);
  assert.deepEqual(errors, []);
});

test('extension-only restart reads saved native history without installing its recorded runtime', { timeout: 10000 }, async t => {
  const configured = options(t);
  const recorded = await startBrowserHost({ ...configured, agentStartup: { kind: 'recorded' }, accessMode: 'trusted' });
  t.after(() => recorded.close());
  const client = createBrowserConnection({ fetch: (path, init) => fetch(recorded.origin + path, { ...init, headers: { ...init.headers, Origin: recorded.origin } }) });
  const scope = { hostId: recorded.hostId, conversationId: 'saved-native' };
  await client.create(scope, (await client.metadata()).defaultAgentId);
  await recorded.close();
  const f = await open(t, [], configured);
  assert.equal(assertDefault(await f.client.metadata()), null);
  assert.deepEqual((await f.client.catalog()).map(item => item.scope), [scope]);
  const saved = await f.client.conversationAgent(scope);
  assert.equal(saved.runtime.engine, 'agentui-recorded'); assert.equal(saved.availability.kind, 'unavailable');
  const received = Promise.withResolvers();
  const feed = f.client.conversation(scope).watch({ after: null, projectionVersion: 2 }, frame => received.resolve(frame));
  try { assert.equal((await received.promise).kind, 'snapshot'); }
  finally { feed.close(); await feed.ended; }
});
