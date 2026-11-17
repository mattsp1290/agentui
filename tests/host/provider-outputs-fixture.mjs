import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderRegistry, openLocalHost } from '@agentui/host';
import { createServerExtensions } from '@agentui/host/extensions';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { transcriptProjection } from '@agentui/contracts/conversation';

export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const turn = () => new Promise(resolve => setImmediate(resolve));
export const secret = 'OUTPUT_CREDENTIAL_PRIVATE_SENTINEL';
export const unavailable = { kind: 'unavailable', reason: 'outputs-unavailable' };
export const invalid = { kind: 'invalid', reason: 'outputs-invalid' };
export const unsupported = { kind: 'unsupported', reason: 'outputs-unsupported' };
export const missing = { kind: 'missing', reason: 'output-missing' };
export function providerFixture({ generation = '1', expectedAuthority = 'remote-provider' } = {}) {
  const instance = { namespace: 'outputs', installationId: 'reports', generation, protocolVersion: '1' };
  const installation = { kind: 'provider', contributionId: 'reports', instance, agent: { opaqueId: 'writer', name: 'Writer' }, presentationVersion: 1, expectedAuthority };
  const calls = { connect: 0, list: 0, read: 0, close: 0, dispose: 0, authorityClose: 0 };
  const state = { authorized: true, scoped: true, bytes: new TextEncoder().encode('A provider report.\n'), credential: { kind: 'credential-handle', instance, hostId: 'host', opaqueHandle: secret } };
  const binding = creation => ({ kind: 'agentui-created', creation, authority: { kind: expectedAuthority,
    ...(expectedAuthority === 'agentui-host' ? { hostId: creation.scope.hostId } : {}),
    binding: { namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: 'session' } } });
  const row = (binding, opaqueId = 'report') => ({ reference: { binding: structuredClone(binding), ref: { instance: structuredClone(instance), kind: 'output', opaqueId } },
    name: 'report.txt', mediaType: 'text/plain', byteLength: state.bytes.length, sha256: hash(state.bytes) });
  const hooks = {};
  const outputs = {
    async list(value) { assert.equal(this, outputs); calls.list++; return hooks.list ? hooks.list(value) : { kind: 'complete', outputs: [row(value)] }; },
    async read(value) { assert.equal(this, outputs); calls.read++; return hooks.read ? hooks.read(value) : { kind: 'available', bytes: state.bytes }; },
  };
  const connected = { instance, outputs,
    capabilities: Object.fromEntries(['create', 'send', 'cancel', 'decide', 'reconcile', 'observe'].map(key => [key,
      key === 'observe' ? { kind: 'unsupported', reason: 'No observation' } : { kind: 'supported' }])),
    async discover() { return hooks.discover ? hooks.discover() : { kind: 'available', agents: [{ ref: { kind: 'agent', instance, opaqueId: 'writer' }, name: 'Writer' }] }; },
    async create(operation) { return hooks.create ? hooks.create(operation) : { kind: 'confirmed', value: binding(operation), evidence: null }; },
    async close() { calls.close++; },
  };
  const presentation = { instance, decodeRequest: value => value, decodeCursor: value => value, decodeState: value => value, decodeEvent: value => value,
    request: text => ({ text }), snapshot() { return { currentRun: null, messages: [] }; }, apply: state => ({ state, events: [] }) };
  const authority = { credentials: { async use() { assert.fail('No external credential operation'); } },
    issue() { return { get credential() { return state.credential; }, expectedAuthority,
      assertAuthorized() { if (!state.authorized) throw new Error(secret); } }; },
    async close() { calls.authorityClose++; state.authorized = false; },
  };
  const extension = { authority,
    manifest: { namespace: instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.mjs' }] },
    entry: { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION,
      activate(context) { context.providers.add('reports', { apiVersion: 1, async connect(request) { calls.connect++; return hooks.connect ? hooks.connect(request) : { kind: 'connected', backend: connected }; } }, presentation);
        return { async dispose() { calls.dispose++; } }; },
    },
  };
  return { instance, installation, calls, state, binding, row, hooks, outputs, connected, extension };
}
export async function fixture(t, options = {}) {
  const f = providerFixture(options);
  const directory = mkdtempSync(join(tmpdir(), 'agentui-outputs-'));
  const registry = options.owner ? createServerExtensions() : createProviderRegistry([f.extension]);
  if (options.owner) assert.equal((await registry.replace({ async prepare() { return { kind: 'ready', extensions: [f.extension] }; } })).kind, 'replaced');
  else { await registry.activate(); await registry.discover(); }
  const host = openLocalHost({ path: join(directory, 'host.sqlite'), projection: transcriptProjection, driver: [], providers: registry, authorize: () => f.state.scoped });
  t.after(async () => { host.close(); await host.drained; await registry.close(); rmSync(directory, { recursive: true, force: true }); });
  const scope = { hostId: 'host', conversationId: 'chat' };
  assert.equal((await host.createProviderConversation(scope, f.installation, registry)).kind, 'confirmed');
  return { ...f, registry, host, scope, original: host.creation(scope),
    async id() { const result = await host.conversationOutputs(scope); assert.equal(result.kind, 'available'); return result.outputs[0].outputId; } };
}
