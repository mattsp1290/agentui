import { EventSchema } from '@ag-ui/core/schemas';
import { canonicalJson, copyJson } from '@agentui/contracts';
import type { Json } from '@agentui/contracts';
import { count, identifier, record } from '@agentui/contracts/decode';
import type { AguiOriginalRun, AguiRunBatch, AguiRunSnapshot, ProviderConversation, ProviderModel } from '@agentui/sdk';
import { providerRun } from './provider-commands.js';
import type { ProviderRun } from './provider-commands.js';
import type { ProviderInstallation } from './provider-creation.js';

export interface ObservationMapper<M extends ProviderModel, I extends string> {
  readonly event: (event: M['event']) => readonly AguiRunBatch<I>[];
  readonly snapshot: (state: M['state'], originals: readonly AguiOriginalRun<I>[]) => readonly AguiRunSnapshot<I>[];
}
export type ObservationFrame = { readonly input: Json; readonly encoded: string; readonly bytes: number };
export type RunObservation = { readonly operationId: string; readonly threadId: string; readonly run: ProviderRun } & (
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'events'; readonly first: number; readonly frames: readonly ObservationFrame[] }
);
export type ProviderObservations = { readonly kind: 'snapshot' | 'event'; readonly runs: readonly RunObservation[] } | { readonly kind: 'absent' };

export function parseProviderObservations(value: unknown, kind: 'snapshot' | 'event', binding: ProviderConversation<string>, installation: ProviderInstallation): ProviderObservations {
  const copied = copyJson(value);
  if (!Array.isArray(copied) || copied.length > 128 || Buffer.byteLength(canonicalJson(copied)) > 1_000_000) throw new Error('Observation mapping exceeds limit');
  const operations = new Set<string>();
  const runs = copied.map(value => {
    const input = record(value);
    record(input, ['operationId', 'threadId', 'run', ...(kind === 'snapshot' ? ['kind', ...(input.kind === 'complete' ? ['events'] : [])] : ['firstPosition', 'events'])]);
    const operationId = identifier(input.operationId), threadId = identifier(input.threadId);
    const run = providerRun(input.run, binding, installation), original = { operationId, threadId, run };
    if (kind === 'snapshot' && operations.has(operationId)) throw new Error('Duplicate snapshot original');
    operations.add(operationId);
    if (kind === 'snapshot' && input.kind === 'unavailable') return { ...original, kind: 'unavailable' } as const;
    if (kind === 'snapshot' && input.kind !== 'complete') throw new Error('Invalid observation history');
    const first = kind === 'snapshot' ? 1 : count(input.firstPosition);
    if (first < 1 || !Array.isArray(input.events) || (kind === 'event' && input.events.length === 0) || !Number.isSafeInteger(first + input.events.length)) throw new Error('Invalid observation positions');
    const frames = input.events.map(input => {
      EventSchema.parse(input);
      const encoded = canonicalJson(input);
      return { input, encoded, bytes: Buffer.byteLength(encoded) };
    });
    return { ...original, kind: 'events', first, frames } as const;
  });
  return { kind, runs };
}
