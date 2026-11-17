import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createBrowserConnection } from '@agentui/client/service';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { crew, crewBackend, crewPresentation } from '../extensions/providers/contracts/crew.ts';
import { local, localBackend, localPresentation } from '../extensions/providers/contracts/local.ts';

const artifact = new URL('../../apps/host/build/tsc/artifact.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './artifact.js' && context.parentURL?.endsWith('/server.js')) {
    const source = `export * from ${JSON.stringify(artifact)};
      import { readInstalledArtifact as read } from ${JSON.stringify(artifact)};
      export function readInstalledArtifact() { return read(${JSON.stringify(fileURLToPath(new URL('../../apps/host/dist/', import.meta.url)))}); }`;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { startBrowserHost } = await import('../../apps/host/build/tsc/server.js');
const secret = 'PRIVATE_CREATION_SECRET';
function extension({ agui = false, native = false, create, lookup, submit, reconcile, request, decode, reconcileSupported = true, service = 'http://127.0.0.1:12345', revision = '1', generation, name } = {}) {
  const base = native ? localBackend : crewBackend, provider = native ? local : crew;
  const presentation = { ...(native ? localPresentation : crewPresentation) };
  if (generation) presentation.instance = { ...presentation.instance, generation };
  const calls = { creates: [], lookups: [], submits: [], reconciles: [], translations: 0, close: 0, dispose: 0 };
  const originalRequest = presentation.request;
  presentation.request = (text, binding) => { calls.translations++; return request ? request(text, binding) : originalRequest(text, binding); };
  if (decode) presentation.decodeRequest = decode;
  let context, credential;
  const binding = operation => ({ kind: 'agentui-created', creation: operation, authority: {
    kind: native ? 'agentui-host' : 'remote-provider', ...(native ? { hostId: operation.scope.hostId } : {}),
    binding: { namespace: presentation.instance.namespace, installationId: presentation.instance.installationId, opaqueSessionId: 'same-session' },
  } });
  const confirmed = operation => ({ kind: 'confirmed', value: binding(operation), evidence: { operationId: operation.operationId } });
  const effect = (operation, state = 'accepted', run = 'same-run') => ({ kind: 'confirmed', value: { kind: 'send', state,
    run: { binding: operation.binding, ref: { kind: 'run', instance: presentation.instance, opaqueId: run } } }, evidence: { accepted: true } });
  const connected = { ...base, instance: presentation.instance,
    capabilities: { ...base.capabilities, reconcile: reconcileSupported ? { kind: 'supported' } : { kind: 'unsupported', reason: 'No lookup' } },
    async discover() { return { kind: 'available', agents: [{ ref: { kind: 'agent', instance: presentation.instance, opaqueId: 'same-agent' }, name: name ?? (native ? 'Local provider' : 'Remote provider') }] }; },
    async create(operation) { calls.creates.push(structuredClone(operation)); return create ? create(operation, { confirmed, context, credential }) : confirmed(operation); },
    async reconcileCreation(operation) { calls.lookups.push(structuredClone(operation)); return lookup ? lookup(operation, { confirmed, context, credential }) : confirmed(operation); },
    async submit(operation) { calls.submits.push(structuredClone(operation)); return submit ? submit(operation, { effect, context, credential }) : effect(operation); },
    async reconcileCommand(operation) { calls.reconciles.push(structuredClone(operation)); return reconcile ? reconcile(operation, { effect, context, credential }) : effect(operation); }, async close() { calls.close++; },
  };
  return { calls, connected, confirmed, effect, get context() { return context; }, get credential() { return credential; }, rename(value) { name = value; }, value: {
    manifest: { namespace: presentation.instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './server.js' }] },
    entry: { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate(value) {
      context = value;
      value.providers[agui ? 'addAgui' : 'add']('service', { ...provider, async connect(request) { credential = request.credential; return { kind: 'connected', backend: connected }; } }, presentation);
      return { async dispose() { calls.dispose++; } };
    } },
    installations: [{ id: 'service', instance: presentation.instance, service, expectedAuthority: native ? 'agentui-host' : 'remote-provider',
      authentication: { kind: 'secret', revision, resolve: async () => secret } }],
  } };
}
async function fixture(t, extensions) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-provider-send-'));
  let running;
  const lost = new Set();
  const client = createBrowserConnection({ fetch: async (url, init) => {
    const response = await fetch(`${running.origin}${url}`, { ...init, headers: { ...init.headers, Origin: running.origin } });
    const op = JSON.parse(init.body).op;
    if (lost.delete(op)) { await response.arrayBuffer(); throw new Error('Lost reply'); }
    return response;
  } });
  const start = async values => {
    running = await startBrowserHost({ agentStartup: { kind: 'recorded' }, directory, port: 0, assetsDirectory: fileURLToPath(new URL('../../apps/desktop/web-dist-browser/', import.meta.url)), extensions: { kind: 'transient', entries: values.map(item => item.value) } });
  };
  await start(extensions);
  t.after(async () => { await running.close(); rmSync(directory, { recursive: true, force: true }); });
  const inspect = action => { const db = new DatabaseSync(join(directory, 'host.sqlite')); try { return action(db); } finally { db.close(); } };
  return { client, directory, inspect, loseNext: op => lost.add(op),
    secondView() {
      return createBrowserConnection({ fetch: (url, init) => fetch(`${running.origin}${url}`, { ...init, headers: { ...init.headers, Origin: running.origin } }) });
    }, get running() { return running; },
    scope: id => ({ hostId: running.hostId, conversationId: id }),
    async restart(values) { await running.close(); await start(values); },
  };
}
const selected = async (f, label = 'Remote provider') => (await f.client.metadata()).agents.find(agent => agent.label === label);
const unavailable = promise => assert.rejects(promise, error => error.kind === 'unavailable');
const send = (scope, id = 'send', text = 'Hello') => ({ version: 1, scope, clientCommandId: id, body: { kind: 'send', text } });
const stored = (f, conversation) => f.inspect(db => db.prepare('SELECT target,observation,receipt FROM commands WHERE conversation=?').get(conversation));
async function create(f, name = 'chat', label) { const scope = f.scope(name); await f.client.create(scope, (await selected(f, label)).id); return scope; }


const actualInput = text => ({ runId: 'actual-run', threadId: 'actual-thread', messages: [{ id: 'user', role: 'user', content: text }],
  tools: [], context: [], state: null, forwardedProps: {} });
const offered = (scope, id = 'offered') => ({ version: 2, scope, clientCommandId: id, body: { kind: 'send', text: 'Hello', frontend: {
  platform: 'desktop', tools: [{ definition: { name: 'test__inspect', description: 'Inspect', parameters: { type: 'object' } }, activationId: 'original-a' }],
} } });
const aguiExtension = options => extension({ agui: true, request: actualInput, decode: value => value,
  submit: (operation, { effect }) => effect(operation, 'completed', operation.request.runId),
  reconcile: (operation, { effect }) => effect(operation, 'completed', operation.request.runId), ...options });

export { extension, fixture, create, stored, send, unavailable, actualInput, offered, aguiExtension, secret, selected };
