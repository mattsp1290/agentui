import { EventSchema } from '@ag-ui/core/schemas';
import { canonicalJson, copyJson } from '@agentui/contracts';
import { count, identifier, record } from '@agentui/contracts/decode';
import type { AguiOriginalRun, AguiRunBatch, AguiRunSnapshot, ProviderConversation, ProviderModel } from '@agentui/sdk';
import { providerRun } from './provider-commands.js';
import type { ProviderRun } from './provider-commands.js';
import type { ProviderInstallation } from './provider-creation.js';

export interface ObservationMapper<M extends ProviderModel, I extends string> {
  readonly event: (event: M['event']) => readonly AguiRunBatch<I>[];
  readonly snapshot: (state: M['state'], originals: readonly AguiOriginalRun<I>[]) => readonly AguiRunSnapshot<I>[];
}
export type ObservationFrame = { readonly encoded: string; readonly bytes: number };
export type ObservationIdentity = { readonly operationId: string; readonly threadId: string; readonly run: ProviderRun };
export type ObservationHistory = { readonly kind: 'unavailable' }
  | { readonly kind: 'events'; readonly first: number; readonly frames: readonly ObservationFrame[] };
export type RunObservation = ObservationIdentity & ObservationHistory;
export type ProviderObservations = { readonly kind: 'event'; readonly runs: readonly RunObservation[] }
  | { readonly kind: 'snapshot'; readonly value: unknown; readonly binding: ProviderConversation<string> }
  | { readonly kind: 'absent' };

export function observationArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length) throw new Error('Invalid observation array');
  return value;
}
export function observationItem(values: readonly unknown[], index: number): unknown {
  const property = Object.getOwnPropertyDescriptor(values, String(index));
  if (!property || !('value' in property)) throw new Error('Invalid observation array item');
  return property.value;
}
export function observationHeader(value: unknown, kind: 'snapshot' | 'event', binding: ProviderConversation<string>, installation: ProviderInstallation) {
  const input = record(value);
  record(input, ['operationId', 'threadId', 'run', ...(kind === 'snapshot' ? ['kind', ...(input.kind === 'complete' ? ['events'] : [])] : ['firstPosition', 'events'])]);
  const identity = { operationId: identifier(input.operationId), threadId: identifier(input.threadId), run: providerRun(copyJson(input.run), binding, installation) };
  if (kind === 'snapshot' && input.kind === 'unavailable') return { identity, first: 1, events: null };
  if (kind === 'snapshot' && input.kind !== 'complete') throw new Error('Invalid observation history');
  const first = kind === 'snapshot' ? 1 : count(input.firstPosition), events = observationArray(input.events);
  if (first < 1 || (kind === 'event' && events.length === 0) || !Number.isSafeInteger(first + events.length)) throw new Error('Invalid observation positions');
  return { identity, first, events };
}
export function* observationFrames(events: readonly unknown[]): Generator<ObservationFrame> {
  for (let index = 0; index < events.length; index++) {
    const input = copyJson(observationItem(events, index));
    EventSchema.parse(input);
    const encoded = canonicalJson(input);
    yield { encoded, bytes: Buffer.byteLength(encoded) };
  }
}
export function parseProviderObservations(value: unknown, binding: ProviderConversation<string>, installation: ProviderInstallation): ProviderObservations {
  const copied = copyJson(value), entries = observationArray(copied);
  if (entries.length > 128 || Buffer.byteLength(canonicalJson(copied)) > 1_000_000) throw new Error('Observation mapping exceeds limit');
  const runs = entries.map(value => {
    const { identity, first, events } = observationHeader(value, 'event', binding, installation);
    if (events === null) throw new Error('Missing observation events');
    return { ...identity, kind: 'events', first, frames: [...observationFrames(events)] } as const;
  });
  return { kind: 'event', runs };
}
