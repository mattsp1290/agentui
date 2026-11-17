import { z } from 'zod';
import { canonicalJson } from '@agentui/contracts';
import type { BackendProvider, ConnectedProvider, CreationIntent, ProviderCommand, ProviderPresentation } from '@agentui/sdk';
import { instance, request } from './model.js';
import type { ReportModel } from './model.js';
import { ReportStore } from './store.js';

export function reportProvider(path: string) {
  const store = new ReportStore(path);
  const unsupported = { kind: 'unsupported', reason: 'Reports support creation and send only' } as const;
  async function create(value: CreationIntent<'reports'>, lookup = false) {
    const result = store.settle(value, lookup);
    if (result.kind !== 'confirmed') return result;
    if (result.value.kind !== 'agentui-created') throw new Error('Invalid report creation');
    return { ...result, value: result.value };
  }
  async function submit(value: ProviderCommand<ReportModel, 'reports'>, lookup = false) {
    if (value.kind !== 'send') return unsupported;
    const result = store.settle(value, lookup);
    if (result.kind !== 'confirmed') return result;
    if (result.value.kind === 'agentui-created') throw new Error('Invalid report settlement');
    return { ...result, value: result.value };
  }
  const connected: ConnectedProvider<ReportModel, 'reports'> = {
    instance, capabilities: { create: { kind: 'supported' }, send: { kind: 'supported' }, reconcile: { kind: 'supported' },
      cancel: unsupported, decide: unsupported, observe: unsupported },
    async discover() { return { kind: 'available', agents: [{ ref: { instance, kind: 'agent', opaqueId: 'writer' }, name: 'Report writer' }] }; },
    create, submit, reconcileCreation: value => create(value, true), reconcileCommand: value => submit(value, true),
    async snapshot() { return unsupported; },
    observe() { return { close() {}, ended: Promise.resolve({ ...unsupported, cursor: null }) }; },
    outputs: { async list(value) { return store.list(value); }, async read(value) { return store.read(value); } },
    async close() { store.close(); },
  };
  const backend: BackendProvider<ReportModel, 'reports'> = { apiVersion: 1, async connect(value) {
    if (value.apiVersion !== 1 || canonicalJson(value.instance) !== canonicalJson(instance) || value.credential !== null) return { kind: 'unavailable', reason: 'Report configuration mismatch' };
    return { kind: 'connected', backend: connected };
  } };
  const presentation: ProviderPresentation<ReportModel, 'reports'> = {
    instance, decodeRequest: value => request.parse(value), request: text => request.parse({ text }),
    decodeCursor: value => z.null().parse(value), decodeState: value => z.null().parse(value), decodeEvent: value => z.null().parse(value),
    snapshot: () => ({ currentRun: null, messages: [] }), apply: () => ({ state: null, events: [] }),
  };
  return { backend, presentation, close: () => store.close() };
}
