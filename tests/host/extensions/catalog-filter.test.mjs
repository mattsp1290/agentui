import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createBrowserConnection } from '@agentui/client/service';
import { entry, options, startBrowserHost } from './fixtures.mjs';

const confirmed = (operation, fixture) => fixture.confirmed(operation);
function agents(names) {
  return fixture => {
    const instance = fixture.value.installations[0].instance;
    return { kind: 'available', agents: names.map(id => ({ ref: { instance, kind: 'agent', opaqueId: id }, name: `${fixture.label} ${id}` })) };
  };
}

async function connected(t, extensions) {
  const configured = options(t);
  const host = await startBrowserHost({ agentStartup: { kind: 'recorded' }, ...configured, extensions: { kind: 'transient', entries: extensions.map(value => value.value) } });
  t.after(() => host.close());
  const client = createBrowserConnection({ fetch: (url, init) => fetch(`${host.origin}${url}`, { ...init, headers: { ...init.headers, Origin: host.origin } }) });
  return { host, client, scope: conversationId => ({ hostId: host.hostId, conversationId }),
    inspect(action) { const db = new DatabaseSync(join(configured.directory, 'host.sqlite')); try { return action(db); } finally { db.close(); } } };
}
const ids = entries => entries.map(entry => entry.scope.conversationId);

test('catalog filters read the stored installation across paging, disappearance and generation change', { timeout: 15000 }, async t => {
  let alphaAgents = ['one', 'two'];
  const alpha = entry(t, { label: 'g1', namespace: 'alpha', create: confirmed, discover: fixture => agents(alphaAgents)(fixture) });
  const beta = entry(t, { label: 'b1', namespace: 'beta', create: confirmed, discover: agents(['solo']) });
  const f = await connected(t, [alpha, beta]);
  const metadata = await f.client.metadata();
  const agent = label => metadata.agents.find(value => value.label === label);
  assert.deepEqual([agent('g1 one').installationId, agent('g1 one').providerAgentId], ['crew-personal', 'one']);
  assert.equal(agent('b1 solo').providerAgentId, 'solo');
  for (const [id, label] of [['c1', 'g1 one'], ['c2', 'g1 two'], ['c3', 'g1 one'], ['c4', 'b1 solo'], ['c5', 'g1 one']]) {
    assert.deepEqual(await f.client.create(f.scope(id), agent(label).id), f.scope(id));
  }
  const recorded = metadata.agents.find(value => !('kind' in value));
  await f.client.create(f.scope('c6'), recorded.id);
  // The filter's JSON paths: $.kind, $.instance.namespace, $.instance.installationId and $.agent.opaqueId.
  const stored = JSON.parse(f.inspect(db => db.prepare("SELECT installation FROM conversations WHERE conversation='c1'").get().installation));
  assert.deepEqual([stored.kind, stored.instance.namespace, stored.instance.installationId, stored.agent.opaqueId], ['provider', 'alpha', 'crew-personal', 'one']);

  const all = await f.client.catalog(null, 100);
  assert.deepEqual(ids(all), ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  assert.deepEqual(all.find(value => value.scope.conversationId === 'c4').provider, { namespace: 'beta', installationId: 'crew-personal', providerAgentId: 'solo' });
  assert.equal(all.find(value => value.scope.conversationId === 'c6').provider, null);
  const namespace = { kind: 'namespace', namespace: 'alpha' };
  const one = { kind: 'provider-agent', namespace: 'alpha', installationId: 'crew-personal', providerAgentId: 'one' };
  assert.deepEqual(ids(await f.client.catalog(null, 100, namespace)), ['c1', 'c2', 'c3', 'c5']);
  assert.deepEqual(ids(await f.client.catalog(null, 100, one)), ['c1', 'c3', 'c5']);
  assert.deepEqual(ids(await f.client.catalog(null, 100, { kind: 'namespace', namespace: 'beta' })), ['c4']);
  const first = await f.client.catalog(null, 2, namespace), second = await f.client.catalog(first.at(-1).scope.conversationId, 2, namespace);
  assert.deepEqual([ids(first), ids(second)], [['c1', 'c2'], ['c3', 'c5']]);
  assert.deepEqual(ids(await f.client.catalog('c5', 2, namespace)), []);

  alphaAgents = ['two'];
  await f.host.discoverProviders();
  assert.equal((await f.client.metadata()).agents.some(value => value.providerAgentId === 'one'), false);
  assert.deepEqual(ids(await f.client.catalog(null, 100, one)), ['c1', 'c3', 'c5']);

  const next = entry(t, { label: 'g2', namespace: 'alpha', create: confirmed, discover: agents(['one']) });
  assert.equal((await f.host.replaceProviderExtensions([next.value, beta.value])).kind, 'replaced');
  const nextOne = (await f.client.metadata()).agents.find(value => value.label === 'g2 one');
  await f.client.create(f.scope('c7'), nextOne.id);
  assert.deepEqual(ids(await f.client.catalog(null, 100, namespace)), ['c1', 'c2', 'c3', 'c5', 'c7']);
  assert.deepEqual(ids(await f.client.catalog(null, 100, one)), ['c1', 'c3', 'c5', 'c7']);

  const search = await f.client.search('c');
  assert.deepEqual(search.items.find(item => item.scope.conversationId === 'c7')?.provider, { namespace: 'alpha', installationId: 'crew-personal', providerAgentId: 'one' });
  assert.equal(search.items.find(item => item.scope.conversationId === 'c6')?.provider, null);
});

test('an unavailable installation descriptor carries its installation and no provider agent', { timeout: 10000 }, async t => {
  const broken = entry(t, { label: 'broken', namespace: 'alpha', discover() { throw new Error('private'); } });
  const f = await connected(t, [broken]);
  const descriptor = (await f.client.metadata()).agents.find(value => value.kind === 'provider');
  assert.equal(descriptor.availability.kind, 'unavailable');
  assert.equal(descriptor.installationId, 'crew-personal');
  assert.equal(descriptor.providerAgentId, null);
});
