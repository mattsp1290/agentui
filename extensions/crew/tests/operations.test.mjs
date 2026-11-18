import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBrowserConnection } from '@agentui/client/service';
import { options, startBrowserHost } from '../../../tests/host/extensions/fixtures.mjs';
import { crewService } from './support/crew-service.mjs';

const directory = fileURLToPath(new URL('../', import.meta.url));
const token = 'PRIVATE_CREW_OPERATION_TOKEN_77';
const instance = { namespace: 'crew', installationId: 'personal', generation: '1', protocolVersion: '1' };
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).agentui.extension;

/** The built extension through an installed entry and the host's real credential authority. */
async function open(t, service, { operationDeadlineMs } = {}) {
  const host = await startBrowserHost({ ...options(t), agentStartup: { kind: 'extensions' }, ...(operationDeadlineMs ? { operationDeadlineMs } : {}),
    extensions: { kind: 'transient', entries: [{ kind: 'installed', directory, manifest, installations: [{ id: 'personal', instance, service,
      expectedAuthority: 'remote-provider', authentication: { kind: 'secret', revision: '1', resolve: async () => token } }] }] } });
  t.after(() => host.close());
  const raw = [];
  const client = createBrowserConnection({ fetch: async (path, init) => {
    const response = await fetch(host.origin + path, { ...init, headers: { ...init.headers, Origin: host.origin } });
    raw.push(await response.clone().text());
    return response;
  } });
  const call = (operation, input) => client.extensionCall({ namespace: 'crew', installationId: 'personal', operation, input });
  return { host, client, call, raw };
}

test('members.list and members.create run through the host authority and a created member becomes an agent', { timeout: 30_000 }, async t => {
  const first = randomUUID(), second = randomUUID();
  const remote = await crewService(t, { memberId: first, token, instance, members: [{ memberId: second, engine: 'pi', profile: 'research' }] });
  const f = await open(t, remote.origin);
  assert.deepEqual(await f.call('members.list', {}), { kind: 'ok', output: { truncated: false,
    members: [{ memberId: first, engine: 'codex', profile: 'test' }, { memberId: second, engine: 'pi', profile: 'research' }] } });
  const requestId = randomUUID();
  const created = await f.call('members.create', { requestId, engine: 'claude', profile: 'research', instructions: 'Review pull requests.' });
  assert.equal(created.kind, 'ok');
  const memberId = created.output.member.memberId;
  assert.deepEqual(created.output.member, { memberId, engine: 'claude', profile: 'research' });
  const agent = (await f.client.metadata()).agents.find(value => value.providerAgentId === memberId);
  assert.ok(agent, 'the new member is discovered before the reply');
  assert.deepEqual([agent.namespace, agent.installationId, agent.label], ['crew', 'personal', 'claude · research']);
  assert.deepEqual(await f.call('members.create', { requestId, engine: 'claude', profile: 'research', instructions: 'Review pull requests.' }), created);
  assert.equal(remote.members.length, 3, 'a repeated requestId creates no second member');
  assert.deepEqual(await f.call('members.create', { requestId: randomUUID(), engine: 'codex', profile: 'missing' }), { kind: 'refused', code: 'unknown-profile' });
  assert.deepEqual(await f.call('members.create', { requestId: 'not-a-uuid', engine: 'codex', profile: 'test' }), { kind: 'refused', code: 'invalid-input' });
  assert.deepEqual(await f.call('members.list', { extra: true }), { kind: 'refused', code: 'invalid-input' });
  const text = f.raw.join('\n');
  for (const value of [token, remote.origin, 'unknown_profile']) assert.equal(text.includes(value), false, value);
});

test('an unreachable service is refused as unreachable, not thrown', { timeout: 30_000 }, async t => {
  const closed = createServer();
  await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${closed.address().port}`;
  await new Promise(resolve => closed.close(resolve));
  const f = await open(t, origin);
  assert.deepEqual(await f.call('members.list', {}), { kind: 'refused', code: 'unreachable' });
});

test('a service that never answers is abandoned when the host deadline aborts the signal, leaving no pending credential use', { timeout: 30_000 }, async t => {
  const remote = await crewService(t, { memberId: randomUUID(), token, instance });
  const f = await open(t, remote.origin, { operationDeadlineMs: 400 });
  remote.holdMembers(new Promise(() => {}));
  assert.deepEqual(await f.call('members.create', { requestId: randomUUID(), engine: 'codex', profile: 'test' }), { kind: 'failed', cause: 'timeout' });
  assert.equal(f.host.extensionStatus().pending, 0);
  remote.holdMembers(null);
  // Replacement retires the generation, which waits for every pending credential use. It completes, so none is left.
  const replaced = await Promise.race([f.host.replaceProviderExtensions([]), new Promise(resolve => setTimeout(() => resolve('stuck'), 5000))]);
  assert.deepEqual(replaced, { kind: 'replaced', generation: null });
});
