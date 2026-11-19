import test from 'node:test';
import assert from 'node:assert/strict';
import { ServiceError, ServiceProtocolError } from '@agentui/client/service';
import { createMacConnection, macConnect } from '@agentui/client/mac';
import { SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';

const access = { observation: 'current' };

test('native connection failures give safe recovery for the reported category on connect and execution', async () => {
  const secret = 'private-host-response-and-profile-path';
  const generic = 'Native connection unavailable. Reconnect, or restart AgentUI if the problem continues. Local work is retained.';
  const guidance = [
    ['forbidden', /installed AgentUI app/],
    ['profile-unavailable', /local profile.*access/i],
    ['profile-in-use', /other AgentUI instance/],
    ['network-failed', /host is running/],
    ['stale', /host connection changed.*Reconnect/],
    ['host-changed', /different AgentUI host.*Reconnect/],
    ...[secret, new Error(secret), { message: secret }, `network-failed ${secret}`, 'keychain-denied', null].map(cause => [cause, generic]),
  ];
  for (const [cause, expected] of guidance) {
    const invoke = async () => { throw cause; };
    const connection = createMacConnection(access, invoke);
    for (const run of [() => macConnect(invoke), () => connection.metadata()]) {
      await assert.rejects(run, error => {
        assert.ok(error instanceof ServiceError);
        assert.equal(error.kind, 'unavailable');
        if (typeof expected === 'string') assert.equal(error.message, expected);
        else assert.match(error.message, expected);
        assert.doesNotMatch(error.message, /Keychain|[Pp]air/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        return true;
      });
    }
  }
});

test('invalid native responses report a protocol problem without response contents', async () => {
  const secret = 'private-host-response-and-profile-path';
  for (const value of [{ kind: secret, observation: 'current' }, { ...access, kind: 'ready' }, { observation: '' }, { ...access, hostId: 'host' }, { ...access, secret }]) {
    await assert.rejects(macConnect(async () => value), error => {
      assert.match(error.message, /Invalid native.*response/);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  }
  const connection = createMacConnection(access, async () => ({ status: 600, body: secret }));
  await assert.rejects(connection.metadata(), error => {
    assert.match(error.message, /Invalid native.*response/);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test('connect sends only the connect command and returns only the observation', async () => {
  const calls = [];
  assert.deepEqual(await macConnect(async command => { calls.push(command); return access; }), access);
  assert.deepEqual(calls, [{ kind: 'connect' }]);
});

test('Mac adapter uses immutable native observations through the real shared engine including search and chooser', async () => {
  const scope = { hostId: 'host', conversationId: 'chat' }, calls = [];
  const descriptor = { id: 'agent', label: 'Recorded', runtime: RECORDED_RUNTIME, imageInput: { kind: 'unsupported', reason: 'This agent cannot receive images.' }, frontendOffers: 'unsupported', commands: ['send', 'approve'], availability: { kind: 'ready' } };
  const metadata = { extensions: [], agents: [descriptor], defaultAgentId: 'agent', hostId: 'host', principalId: 'principal', compatibility: {
    wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME,
    desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' },
  } };
  const old = Promise.withResolvers();
  let current = 'old';
  const nativeInvoke = async command => {
    calls.push(command);
    if (command.kind === 'connect') return { observation: current };
    if (command.observation === 'old') return old.promise;
    const request = command.request;
    const value = request.op === 'metadata' ? metadata : request.op === 'search' ? { items: [{ scope, preview: 'Hello', provider: null, excerpt: 'Message match' }], after: null }
      : request.op === 'provider-observation' ? { kind: 'stopped', reason: 'provider-disconnected' } : request.op === 'create' ? scope : request.op === 'conversation-agent' ? descriptor : [];
    return { status: 200, body: JSON.stringify({ ok: true, value }) };
  };
  const previous = createMacConnection(await macConnect(nativeInvoke), nativeInvoke);
  const pending = previous.metadata();
  current = 'new';
  const next = createMacConnection(await macConnect(nativeInvoke), nativeInvoke);
  assert.deepEqual(await next.metadata(), metadata);
  assert.equal((await next.search('match')).items[0].excerpt, 'Message match');
  assert.deepEqual(await next.create(scope, descriptor.id), scope);
  assert.deepEqual(await next.conversationAgent(scope), descriptor);
  for (const action of ['read', 'retry']) assert.deepEqual(await next.providerObservation({ scope, action }), { kind: 'stopped', reason: 'provider-disconnected' });
  old.reject('stale');
  await assert.rejects(pending, error => error instanceof ServiceError && /host connection changed/.test(error.message));
  assert.deepEqual(await next.metadata(), metadata);
  assert.deepEqual(new Set(calls.filter(command => command.kind === 'execute').map(command => command.observation)), new Set(['old', 'new']));
});

test('native bridge transports provider descriptors and accepts creation refusal only with create HTTP 409', async () => {
  const scope = { hostId: 'host', conversationId: 'chat' };
  const descriptor = { kind: 'provider', id: 'provider', label: 'Remote', namespace: 'example', protocolVersion: '1', installationId: 'personal', providerAgentId: 'agent', imageInput: { kind: 'unsupported', reason: 'This agent cannot receive images.' }, frontendOffers: 'unsupported', commands: [], availability: { kind: 'ready' } };
  let status = 409, mode = 'negative';
  const connection = createMacConnection(access, async command => {
    assert.equal(command.kind, 'execute');
    return mode === 'descriptor' ? { status: 200, body: JSON.stringify({ ok: true, value: descriptor }) }
      : { status, body: JSON.stringify({ ok: false, error: { kind: 'create-rejected', message: 'No conversation was created' } }) };
  });
  mode = 'descriptor'; assert.deepEqual(await connection.conversationAgent(scope), descriptor);
  mode = 'negative'; await assert.rejects(connection.create(scope, descriptor.id), error => error.kind === 'create-rejected');
  for (status of [200, 400, 503]) await assert.rejects(connection.create(scope, descriptor.id), error => error instanceof ServiceProtocolError);
  status = 409; await assert.rejects(connection.conversationAgent(scope), error => error instanceof ServiceProtocolError);
});
