import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBrowserConnection } from '@agentui/client/service';
import { options, startBrowserHost } from '../../../tests/host/extensions/fixtures.mjs';
import { crewService } from './support/crew-service.mjs';
import { listedMembers } from '../dist/operations.js';

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
  // 65 two-byte characters fit in 128 UTF-16 code units but exceed Crew's 128 UTF-8 bytes; 64 fit both.
  assert.deepEqual(await f.call('members.create', { requestId: randomUUID(), engine: 'codex', profile: 'é'.repeat(65) }), { kind: 'refused', code: 'invalid-input' });
  assert.deepEqual(await f.call('members.create', { requestId: randomUUID(), engine: 'codex', profile: 'é'.repeat(64) }), { kind: 'refused', code: 'unknown-profile' });
  assert.deepEqual(await f.call('members.list', { extra: true }), { kind: 'refused', code: 'invalid-input' });
  // Crew's own bounds on instructions: 16,384 UTF-8 bytes, no control characters but tab and newline. Without this check the
  // client throws before sending and the call reads as an unknown outcome.
  for (const instructions of ['é'.repeat(8_193), 'Line one\rLine two', 'Bell\u0007']) {
    assert.deepEqual(await f.call('members.create', { requestId: randomUUID(), engine: 'codex', profile: 'test', instructions }), { kind: 'refused', code: 'invalid-input' }, JSON.stringify(instructions.slice(0, 20)));
  }
  assert.equal(remote.members.length, 3, 'no refused instructions reached Crew');
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

test('members.list stops at a byte budget well under the operation output limit and reports truncation', () => {
  // 1,000 members whose 128-byte profiles each escape to 256 JSON bytes exceed 256,000 bytes; the list cuts before that.
  const page = Array.from({ length: 1_000 }, () => ({ memberId: randomUUID(), engine: 'codex', profile: '"'.repeat(128) }));
  const members = [];
  assert.equal(listedMembers(members)(page), 'truncated');
  assert.ok(members.length > 0 && members.length < page.length);
  assert.ok(Buffer.byteLength(JSON.stringify({ members, truncated: true })) < 256_000);
  const small = [];
  assert.equal(listedMembers(small)(page.slice(0, 10)), undefined);
  assert.equal(small.length, 10);
});
