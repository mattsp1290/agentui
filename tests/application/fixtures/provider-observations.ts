/// <reference types="node" />
/// <reference lib="esnext" />
import { randomUUID } from 'node:crypto';
import { EventSchema, RunAgentInputSchema } from '@ag-ui/core/schemas';
import { canonicalJson, copyJson, parseRunAuthority, parseScope } from '@agentui/contracts';
import { identifier, record } from '@agentui/contracts/decode';
import { transcriptProjection } from '@agentui/contracts/conversation';
import type { Event, RunAgentInput } from '@agentui/protocol';
import type { AguiObservations, AguiOriginalRun, AguiRunBatch, AguiRunSnapshot, BackendProvider, ConnectedProvider,
  Json, ProviderConversation, ProviderInstance, ProviderModel, ProviderPresentation, ServerExtensionContext } from '@agentui/sdk';

type Model = { request: RunAgentInput; cursor: string; state: Json; event: Json };
export const instance: ProviderInstance<string> = Object.freeze({ namespace: 'observation-test', installationId: 'fixture', generation: '1', protocolVersion: '1' });
function binding(value: unknown): ProviderConversation<string> {
  const input = record(value), creation = record(input.creation), agent = record(creation.agent);
  if (input.kind !== 'agentui-created' || creation.kind !== 'create' || agent.kind !== 'agent' || canonicalJson(agent.instance) !== canonicalJson(instance)) throw new Error('binding');
  return { kind: 'agentui-created', creation: { kind: 'create', operationId: identifier(creation.operationId), scope: parseScope(creation.scope),
    agent: { kind: 'agent', instance, opaqueId: identifier(agent.opaqueId) } }, authority: parseRunAuthority(input.authority) };
}
export function controlledProvider(service: string) {
  const streamId = randomUUID();
  const counters = { acknowledgements: 0, eventMaps: 0, snapshotMaps: 0, failures: [] as unknown[] };
  let current: ProviderConversation<string> | undefined;
  let serial = 0;
  let disconnect = () => {};
  const post = async (path: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(service + path, { method: 'POST', body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    return response.json();
  };
  const original = (value: unknown): AguiOriginalRun<string> => {
    const input = record(value);
    if (!current) throw new Error('binding missing');
    return { operationId: identifier(input.operationId), threadId: identifier(input.threadId),
      run: { binding: current, ref: { kind: 'run', instance, opaqueId: identifier(input.runId) } } };
  };
  const frames = (value: unknown) => { if (!Array.isArray(value)) throw new Error('events'); return value.map(event => { EventSchema.parse(event); return event as Event; }); };
  const mappings: AguiObservations<Model, string> = {
    event(value) {
      counters.eventMaps++;
      const input = record(value);
      if (!Array.isArray(input.batches)) throw new Error('batches');
      return input.batches.map((value): AguiRunBatch<string> => {
        const input = record(value), events = frames(input.events), first = events.shift();
        if (!first || typeof input.firstPosition !== 'number') throw new Error('batch');
        return { ...original(input), firstPosition: input.firstPosition, events: [first, ...events] };
      });
    },
    snapshot(value, originals) {
      counters.snapshotMaps++;
      const input = record(value);
      if (!Array.isArray(input.histories)) throw new Error('histories');
      return input.histories.map((value): AguiRunSnapshot<string> => {
        const input = record(value), selected = originals.find(item => item.operationId === input.operationId) ?? original(input);
        return input.kind === 'unavailable' ? { ...selected, kind: 'unavailable' } : { ...selected, kind: 'complete', events: frames(input.events) };
      });
    },
  };
  const presentation: ProviderPresentation<Model, string> = {
    instance, decodeRequest: value => { RunAgentInputSchema.parse(value); return value as RunAgentInput; }, decodeCursor: identifier, decodeState: copyJson, decodeEvent: copyJson,
    request: text => ({ runId: `run-${++serial}`, threadId: 'thread', messages: [{ id: 'user', role: 'user', content: text }], tools: [], context: [], state: null, forwardedProps: {} }),
    snapshot: () => transcriptProjection.initial(),
    apply: (state, _event) => ({ state, events: [{ kind: 'message-updated', messageId: `answer-${++serial}`, revision: 1, role: 'assistant', text: 'Observed', complete: true }] }),
  };
  const effect: ConnectedProvider<Model, string>['submit'] = async operation => {
    const input = record(await post('/submit', operation));
    if (input.kind === 'pending') return { kind: 'pending', evidence: null };
    if (input.kind === 'uncertain') return { kind: 'uncertain', reason: 'lost', evidence: null };
    if (input.kind === 'rejected') return { kind: 'rejected', reason: 'rejected', evidence: null };
    if (operation.kind !== 'send') throw new Error('send only');
    return { kind: 'confirmed', value: { kind: 'send', state: 'completed', run: { binding: operation.binding,
      ref: { kind: 'run', instance, opaqueId: identifier(input.runId) } } }, evidence: null };
  };
  const connected: ConnectedProvider<Model, string> = {
    instance, capabilities: { create: { kind: 'supported' }, send: { kind: 'supported' }, reconcile: { kind: 'supported' }, observe: { kind: 'supported' },
      cancel: { kind: 'unsupported', reason: 'unused' }, decide: { kind: 'unsupported', reason: 'unused' } },
    async discover() { return { kind: 'available', agents: [{ ref: { kind: 'agent', instance, opaqueId: 'agent' }, name: 'Controlled observations' }] }; },
    async create(operation) { current = binding(await post('/create', operation)); return { kind: 'confirmed', value: current, evidence: null }; },
    async reconcileCreation() { return { kind: 'unsupported', reason: 'unused' }; },
    submit: effect, reconcileCommand: effect,
    async snapshot(value) {
      current = value;
      const input = record(await post('/snapshot', value));
      return { kind: 'available', snapshot: { binding: value, cursor: { kind: 'provider-cursor', binding: value, opaque: identifier(input.cursor) },
        projectionVersion: 1, state: copyJson(input.state), decisions: [] } };
    },
    observe(input, receive) {
      current = input.binding;
      const abort = new AbortController(), end = Promise.withResolvers<Awaited<ReturnType<ConnectedProvider<Model, string>['observe']>['ended']>>();
      let closed = false;
      const close = () => { if (!closed) { closed = true; abort.abort(); end.resolve({ kind: 'closed', cursor: null, reason: 'closed' }); } };
      disconnect = close;
      void (async () => {
        try {
          while (!closed) {
            const item = record(await post('/next', { ...input, streamId }, abort.signal));
            if (closed) return;
            try { await receive({ kind: 'event', eventId: identifier(item.id), cursor: { kind: 'provider-cursor', binding: input.binding, opaque: identifier(item.cursor) }, event: copyJson(item.event) }); } catch (error) { counters.failures.push(error); throw error; }
            counters.acknowledgements++;
          }
        } catch (error) { if (!closed) counters.failures.push(error); }
        finally { close(); }
      })();
      return { close, ended: end.promise };
    },
    async close() {},
  };
  const backend: BackendProvider<Model, string> = { apiVersion: 1, async connect() { return { kind: 'connected', backend: connected }; } };
  return { streamId, counters, presentation, mappings, connected, backend, disconnect: () => disconnect(),
    activate(context: ServerExtensionContext, enabled = true) { context.providers.addAgui('fixture', backend, presentation, enabled ? mappings : undefined); return { dispose() {} }; } };
}
export type ControlledModel = Model & ProviderModel;
