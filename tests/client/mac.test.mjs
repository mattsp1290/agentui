import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceProtocolError } from '@agentui/client/service';
import { createMacConnection, macAccess } from '@agentui/client/mac';
import { EXTENSION_SDK_VERSION, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';

test('Mac adapter uses immutable native observations through the real shared engine including search and chooser', async () => {
  const scope = { hostId: 'host', conversationId: 'chat' }, calls = [];
  const descriptor = { id: 'agent', label: 'Recorded', runtime: RECORDED_RUNTIME, commands: ['send', 'approve'], availability: { kind: 'ready' } };
  const metadata = { agents: [descriptor], defaultAgentId: 'agent', hostId: 'host', principalId: 'principal', compatibility: {
    wireVersion: 5, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME,
    desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' },
  } };
  const old = Promise.withResolvers();
  let current = 'old', oldNotifications = 0, newNotifications = 0;
  const nativeInvoke = async command => {
    calls.push(command);
    if (command.kind === 'status') return { kind: 'ready', observation: current, hostId: 'host', principalId: 'principal' };
    if (command.observation === 'old') return old.promise;
    const request = command.request;
    const value = request.op === 'metadata' ? metadata : request.op === 'search' ? { items: [{ scope, preview: 'Hello', excerpt: 'Message match' }], after: null }
      : request.op === 'provider-observation' ? { kind: 'stopped', reason: 'provider-disconnected' } : request.op === 'create' ? scope : request.op === 'conversation-agent' ? descriptor : [];
    return { status: 200, body: JSON.stringify({ ok: true, value }) };
  };
  const previous = createMacConnection(await macAccess({ kind: 'status' }, nativeInvoke), nativeInvoke, { onUnauthorized: () => oldNotifications++ });
  const pending = previous.metadata();
  current = 'new';
  const next = createMacConnection(await macAccess({ kind: 'status' }, nativeInvoke), nativeInvoke, { onUnauthorized: () => newNotifications++ });
  assert.deepEqual(await next.metadata(), metadata);
  assert.equal((await next.search('match')).items[0].excerpt, 'Message match');
  assert.deepEqual(await next.create(scope, descriptor.id), scope);
  assert.deepEqual(await next.conversationAgent(scope), descriptor);
  for (const action of ['read', 'retry']) assert.deepEqual(await next.providerObservation({ scope, action }), { kind: 'stopped', reason: 'provider-disconnected' });
  old.resolve({ status: 401, body: JSON.stringify({ ok: false, error: { kind: 'unauthorized', message: 'Expired' } }) });
  await assert.rejects(pending, error => error.kind === 'unauthorized');
  assert.equal(oldNotifications, 1); assert.equal(newNotifications, 0);
  assert.deepEqual(await next.metadata(), metadata);
  await assert.rejects(next.pair('invitation'), /native pairing controls/);
  assert.equal(calls.some(command => command.kind === 'execute' && command.request.op === 'pair'), false);
  assert.deepEqual(new Set(calls.filter(command => command.kind === 'execute').map(command => command.observation)), new Set(['old', 'new']));
  const disconnected = createMacConnection({ kind: 'absent', observation: 'absent' }, nativeInvoke);
  const before = calls.length;
  await assert.rejects(disconnected.metadata(), error => error.kind === 'unauthorized');
  assert.equal(calls.length, before);
});

test('native bridge transports provider descriptors and accepts creation refusal only with create HTTP 409', async () => {
  const scope = { hostId: 'host', conversationId: 'chat' };
  const descriptor = { kind: 'provider', id: 'provider', label: 'Remote', namespace: 'example', protocolVersion: '1', commands: [], availability: { kind: 'ready' } };
  let status = 409, mode = 'negative';
  const connection = createMacConnection({ kind: 'ready', observation: 'current', hostId: 'host', principalId: 'principal' }, async command => {
    assert.equal(command.kind, 'execute');
    return mode === 'descriptor' ? { status: 200, body: JSON.stringify({ ok: true, value: descriptor }) }
      : { status, body: JSON.stringify({ ok: false, error: { kind: 'create-rejected', message: 'No conversation was created' } }) };
  });
  mode = 'descriptor'; assert.deepEqual(await connection.conversationAgent(scope), descriptor);
  mode = 'negative'; await assert.rejects(connection.create(scope, descriptor.id), error => error.kind === 'create-rejected');
  for (status of [200, 400, 503]) await assert.rejects(connection.create(scope, descriptor.id), error => error instanceof ServiceProtocolError);
  status = 409; await assert.rejects(connection.conversationAgent(scope), error => error instanceof ServiceProtocolError);
});
