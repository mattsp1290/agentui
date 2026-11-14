import { createConversationStore } from '@agentui/client';

export const scope = { hostId: 'host-a', conversationId: 'conversation-a' };
export const projection = {
  version: 1,
  initial: () => ({ text: '' }),
  decodeEvent(value) {
    if (typeof value !== 'string') throw new Error('Invalid text event');
    return value;
  },
  decodeState(value) {
    if (!value || typeof value.text !== 'string') throw new Error('Invalid text state');
    return { text: value.text };
  },
  apply: (state, event) => ({ text: state.text + event }),
};
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function storage(initial = null) {
  return {
    value: initial,
    writes: [],
    async load() { return structuredClone(this.value); },
    async save(records) { this.value = structuredClone(records); this.writes.push(this.value); },
  };
}
export function receipt(command, kind = 'pending', sequence = 1) {
  const state = ['uncertain', 'not-dispatched', 'rejected'].includes(kind) ? { kind, reason: 'recorded reason' } : { kind };
  return { scope: command.scope, clientCommandId: command.clientCommandId, hostOperationId: 'operation', sequence, state };
}
export function fakePort(boundScope = scope) {
  return {
    scope: boundScope,
    submitted: [],
    watches: [],
    async submit(command) { this.submitted.push(structuredClone(command)); return { kind: 'receipt', receipt: receipt(command) }; },
    async receipt() { return null; },
    watch(request, receive) {
      const end = deferred();
      const stream = {
        request, receive, closed: 0, ended: end.promise,
        finish: end.resolve,
        close() { if (this.closed++) return; end.resolve({ kind: 'closed', cursor: null, reason: 'Closed' }); },
      };
      this.watches.push(stream);
      return stream;
    },
  };
}
export function fixture({ drafts = storage(), port = fakePort(), selectedScope = port.scope, createCommandId, selectedProjection = projection } = {}) {
  let counter = 0;
  const store = createConversationStore({ scope: selectedScope, port, projection: selectedProjection, drafts, createCommandId: createCommandId ?? (() => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`) });
  return { store, drafts, port };
}
export function snapshot(cursor = 0, text = '', selectedScope = scope, receipts = {}, decisions = {}) {
  return { kind: 'snapshot', snapshot: { scope: selectedScope, projectionVersion: 1, cursor, document: { domain: { text }, receipts, decisions } } };
}
export function events(...texts) {
  return { kind: 'events', events: texts.map(([sequence, event]) => ({ scope, sequence, event: { kind: 'domain', event } })) };
}
export async function connected(options) {
  const result = fixture(options);
  await result.store.connect();
  const stream = result.port.watches.at(-1);
  await stream.receive(snapshot(0, '', result.port.scope));
  return { ...result, stream };
}
