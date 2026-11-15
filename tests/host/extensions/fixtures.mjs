import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { createCrewFixture } from '../../extensions/providers/contracts/crew.ts';

const artifact = new URL('../../../apps/host/build/tsc/artifact.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './artifact.js' && context.parentURL?.endsWith('/server.js')) {
    const source = `export * from ${JSON.stringify(artifact)};
      import { readInstalledArtifact as read } from ${JSON.stringify(artifact)};
      export function readInstalledArtifact() { return read(${JSON.stringify(fileURLToPath(new URL('../../../apps/host/dist/', import.meta.url)))}); }`;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return next(specifier, context);
} });
export const { startBrowserHost } = await import('../../../apps/host/build/tsc/server.js');
const fixtures = new Map();
export const secret = 'PRIVATE_EXTENSION_CREDENTIAL_81';
export const service = 'http://127.0.0.1:12345';
export function options(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-server-lifecycle-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, port: 0, assetsDirectory: fileURLToPath(new URL('../../../apps/desktop/web-dist-browser/', import.meta.url)) };
}
export function listenerLog() {
  const emitter = new EventEmitter();
  return { emitter, get active() { return emitter.listenerCount('update'); }, maximum: 0, events: [], deliveries: [] };
}
export function entry(t, { label = 'entry', listeners = listenerLog(), ...hooks } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-server-entry-'));
  t.after(() => { fixtures.delete(directory); rmSync(directory, { recursive: true, force: true }); });
  const instance = { namespace: 'example-crew', installationId: 'crew-personal', generation: label, protocolVersion: 'crew-v2' };
  const { crewBackend, crew, crewPresentation } = createCrewFixture(instance);
  const calls = { import: 0, activate: 0, connect: 0, discover: 0, close: 0, dispose: 0, commands: 0, resolve: 0 };
  const fixture = { calls, hooks, listeners, context: null, credential: null, label };
  const connected = { ...crewBackend,
    async discover() {
      calls.discover++;
      return fixture.context.credentials.use({ credential: fixture.credential, service }, async value => {
        assert.equal(value, secret);
        await hooks.discover?.(fixture);
        return { kind: 'available', agents: [{ ref: { instance, kind: 'agent', opaqueId: label }, name: label }] };
      });
    },
    async close() { calls.close++; listeners.events.push(`${label}:close`); await hooks.close?.(fixture); },
    async create() { calls.commands++; assert.fail('unexpected remote create'); },
    async submit() { calls.commands++; assert.fail('unexpected remote command'); },
    async reconcileCreation() { calls.commands++; assert.fail('unexpected remote reconcile'); },
    async reconcileCommand() { calls.commands++; assert.fail('unexpected remote reconcile'); },
    observe() { calls.commands++; assert.fail('unexpected remote observe'); },
  };
  const listener = () => listeners.deliveries.push(label);
  fixture.activate = async context => {
    calls.activate++; fixture.context = context;
    listeners.events.push(`${label}:activate`);
    listeners.emitter.on('update', listener);
    listeners.maximum = Math.max(listeners.maximum, listeners.emitter.listenerCount('update'));
    try {
      context.providers.add('service', { ...crew, async connect(request) {
        calls.connect++; fixture.credential = request.credential;
        return { kind: 'connected', backend: connected };
      } }, crewPresentation);
      await hooks.activate?.(fixture);
    } catch (error) { listeners.emitter.off('update', listener); throw error; }
    return { async dispose() {
      calls.dispose++; listeners.events.push(`${label}:dispose-start`);
      await hooks.dispose?.(fixture);
      listeners.emitter.off('update', listener); listeners.events.push(`${label}:dispose-end`);
    } };
  };
  fixtures.set(directory, fixture);
  const module = `import { imported, activate } from ${JSON.stringify(import.meta.url)};
    await imported(${JSON.stringify(directory)});
    export default { kind: 'server', sdkVersion: ${JSON.stringify(EXTENSION_SDK_VERSION)},
      activate: context => activate(${JSON.stringify(directory)}, context) };`;
  writeFileSync(join(directory, 'server.mjs'), module);
  const manifest = { namespace: instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION,
    entries: [{ kind: 'server', module: './server.mjs' }] };
  const installations = [{ id: 'service', instance, service, authentication: { kind: 'secret', revision: 'first',
    async resolve() { calls.resolve++; return secret; } } }];
  fixture.value = { kind: 'installed', directory, manifest, installations };
  fixture.importedValue = { manifest, entry: { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate: fixture.activate }, installations };
  fixture.directory = directory;
  fixture.write = source => writeFileSync(join(directory, 'server.mjs'), source);
  fixture.mkdir = name => mkdirSync(join(directory, name));
  return fixture;
}
export async function imported(key) {
  const fixture = fixtures.get(key);
  fixture.calls.import++; fixture.listeners.events.push(`${fixture.label}:import`);
  await fixture.hooks.import?.(fixture);
}
export function activate(key, context) { return fixtures.get(key).activate(context); }
export async function turn() { await new Promise(resolve => setImmediate(resolve)); }
export async function settledStatus(host) {
  for (let attempts = 0; attempts < 100; attempts++) {
    const status = host.extensionStatus();
    if (status.kind !== 'changing') return status;
    await turn();
  }
  assert.fail('extension lifecycle did not settle');
}
