import { EXTENSION_SDK_VERSION } from '@agentui/sdk';

/**
 * A server entry that registers one trivial provider per installation. Its agent appears in host metadata while the
 * extension runs, so a test can see an applied build add or remove it. It never calls its service.
 */
const serverEntry = namespace => `import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
const supported = { kind: 'supported' };
function provider(instance) {
  const agent = { instance, kind: 'agent', opaqueId: 'fixture' };
  const confirmed = operation => ({ kind: 'confirmed', evidence: null, value: { kind: 'agentui-created', creation: operation, authority: { kind: 'remote-provider',
    binding: { namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: operation.operationId } } } });
  const backend = { instance,
    capabilities: { create: supported, send: supported, cancel: { kind: 'unsupported', reason: 'Fixture' }, decide: supported, reconcile: supported, observe: supported },
    async discover() { return { kind: 'available', agents: [{ ref: agent, name: '${namespace} fixture agent' }] }; },
    async create(operation) { return confirmed(operation); },
    async submit() { return { kind: 'rejected', reason: 'Fixture', evidence: null }; },
    async reconcileCreation(operation) { return confirmed(operation); },
    async reconcileCommand() { return { kind: 'rejected', reason: 'Fixture', evidence: null }; },
    async snapshot() { return { kind: 'unavailable', reason: 'Fixture' }; },
    observe() { return { close() {}, ended: Promise.resolve({ kind: 'unsupported', cursor: null, reason: 'Fixture' }) }; },
    async close() {} };
  const presentation = { instance,
    decodeRequest(value) { return { text: String(value?.text ?? '') }; },
    decodeCursor(value) { return { stream: Number(value?.stream ?? 0) }; },
    decodeState(value) { return { messages: Array.isArray(value?.messages) ? value.messages.map(String) : [] }; },
    decodeEvent(value) { return { kind: 'message', text: String(value?.text ?? '') }; },
    request(text) { return { text }; },
    snapshot(state) { return { currentRun: null, messages: state.messages.map((text, index) => ({ messageId: String(index), revision: 1, role: 'assistant', text, complete: true })) }; },
    apply(previous, event) { return { state: { messages: [...previous.messages, event.text] }, events: [] }; } };
  return { provider: { apiVersion: 1, async connect() { return { kind: 'connected', backend }; } }, presentation };
}
export default { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate(context) {
  for (const installation of context.installations) {
    const { provider: contribution, presentation } = provider(installation.instance);
    context.providers.add(installation.id, contribution, presentation);
  }
  return { dispose() {} };
} };
`;

/**
 * A small, dependency-free customization repository (npm inputs absent): a root package in `custom/` with same-repository
 * references to two tiny extensions, each with a desktop and a server entry, one grant each, and a settings file.
 */
export function customizationFixtureFiles({ enabled = { alpha: true, beta: true } } = {}) {
  const extension = namespace => ({
    [`ext/${namespace}/package.json`]: JSON.stringify({ name: `fixture-${namespace}`, version: '0.0.0', private: true, type: 'module', agentui: {
      extension: { namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './dist/server.js' }, { kind: 'desktop', module: './dist/desktop.js' }] },
      sources: { './dist/server.js': './server.ts', './dist/desktop.js': './desktop.tsx' } } }, null, 2) + '\n',
    [`ext/${namespace}/server.ts`]: serverEntry(namespace),
    [`ext/${namespace}/desktop.tsx`]: `export default { kind: 'desktop', sdkVersion: '${EXTENSION_SDK_VERSION}', activate() { return { modules: [], dispose() {} }; } };\n`,
  });
  const grant = namespace => ({ id: 'personal', instance: { namespace, installationId: 'personal', generation: '1', protocolVersion: '1' },
    service: 'http://127.0.0.1:9', expectedAuthority: 'remote-provider',
    authentication: { kind: 'environment', variable: `AGENTUI_EXTENSION_${namespace.toUpperCase()}_TOKEN`, revision: '1' } });
  return {
    'custom/package.json': `{
  "name": "fixture-customization",
  "version": "0.0.0",
  "private": true,
  "agentui": {
    "extensions": [
      { "subdirectory": "ext/alpha", "enabled": ${enabled.alpha} },
      { "subdirectory": "ext/beta", "enabled": ${enabled.beta} }
    ],
    "installations": ${JSON.stringify([grant('alpha'), grant('beta')])}
  }
}
`,
    'custom/agentui-settings.json': '{\n  "version": 1,\n  "appearance": "system",\n  "showExtensionViews": true\n}\n',
    ...extension('alpha'), ...extension('beta'),
  };
}
export const fixtureConnection = remote => ({ location: remote, branch: 'customization', subdirectory: 'custom' });
