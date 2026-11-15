import { canonicalJson, copyJson, parseDecision } from '@agentui/contracts';
import type { Json, PendingDecision } from '@agentui/contracts';
import { count, identifier, record } from '@agentui/contracts/decode';
import { parseTranscript, parseTranscriptEvent } from '@agentui/contracts/conversation';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import type { ConnectedProvider, ConversationRef, ProviderConversation, ProviderCursor, ProviderFeed, ProviderModel, ProviderPresentation } from '@agentui/sdk';
import { providerReference, providerRun } from './provider-commands.js';
import type { ProviderRun } from './provider-commands.js';
import { creationBinding } from './provider-creation.js';
import type { ProviderCreation, ProviderInstallation } from './provider-creation.js';

export interface ProviderCheckpoint {
  readonly revision: number;
  readonly projectionVersion: number;
  readonly state: Json;
  readonly cursor: Json;
}
export interface ProviderDecision {
  readonly kind: 'provider';
  readonly visible: PendingDecision;
  readonly reference: ConversationRef<string, 'decision'>;
  readonly choices: readonly { readonly id: string; readonly reference: ConversationRef<string, 'choice'>; readonly label: string }[];
}
export function providerDecision(value: unknown, binding: ProviderConversation<string>, selected: ProviderInstallation): ProviderDecision {
  const input = record(value, ['kind', 'visible', 'reference', 'choices']);
  record(input.visible, ['pendingId', 'runId', 'prompt', 'choices']);
  const visible = parseDecision(input.visible), reference = providerReference(input.reference, binding, selected, 'decision');
  if (input.kind !== 'provider' || reference.ref.opaqueId !== visible.pendingId || !Array.isArray(input.choices)) throw new Error('Invalid provider decision');
  const choices = input.choices.map(value => {
    const choice = record(value, ['id', 'reference', 'label']);
    const reference = providerReference(choice.reference, binding, selected, 'choice'), label = identifier(choice.label);
    if (reference.ref.opaqueId !== choice.id || !label.trim()) throw new Error('Invalid provider choice');
    return { id: reference.ref.opaqueId, reference, label };
  });
  if (canonicalJson(choices.map(choice => choice.id)) !== canonicalJson(visible.choices)) throw new Error('Invalid provider choices');
  return { kind: 'provider', visible, reference, choices };
}
export function visibleProviderDecision(pending: ProviderDecision, reserved: boolean): PendingDecision {
  return parseDecision({ ...pending.visible, choiceLabels: Object.fromEntries(pending.choices.map(choice => [choice.id, choice.label])),
    ...(reserved ? { reserved: true } : {}) });
}
export interface ProviderChange {
  readonly checkpoint: Omit<ProviderCheckpoint, 'revision'>;
  readonly runs: readonly ProviderRun[];
  readonly output: { readonly kind: 'snapshot'; readonly transcript: Transcript; readonly decisions: readonly ProviderDecision[] }
    | { readonly kind: 'events'; readonly events: readonly TranscriptEvent[] };
}
export interface ProviderStreamStore {
  providerCheckpoint(original: ProviderCreation): ProviderCheckpoint | null;
  commitProvider(original: ProviderCreation, expected: number | null,
    event: { readonly id: string; readonly payload: string } | null, render: () => ProviderChange): ProviderCheckpoint;
}
export interface ProviderStream { close(): void; readonly drained: Promise<void> }
export function providerCheckpoint(value: unknown): ProviderCheckpoint {
  const input = record(value, ['revision', 'projectionVersion', 'state', 'cursor']);
  const revision = count(input.revision), projectionVersion = count(input.projectionVersion);
  if (revision < 1 || projectionVersion < 1) throw new Error('Invalid provider checkpoint');
  return { revision, projectionVersion, state: copyJson(input.state), cursor: copyJson(input.cursor) };
}

export async function observeProvider<M extends ProviderModel, I extends string>(connected: ConnectedProvider<M, I>,
  presentation: ProviderPresentation<M, I>, original: ProviderCreation, binding: ProviderConversation<I>,
  authorize: () => void, store: ProviderStreamStore): Promise<ProviderStream> {
  const storedBinding = creationBinding(binding, original.intent, original.installation);
  let committed = store.providerCheckpoint(original);
  const bounded = (value: unknown): Json => {
    const result = copyJson(value);
    if (Buffer.byteLength(canonicalJson(result)) > 1_000_000) throw new Error('Provider observation exceeds limit');
    return result;
  };
  const decode = <T extends Json>(decoder: (value: unknown) => T, value: unknown): T => {
    const copied = bounded(value), encoded = canonicalJson(copied), result = decoder(copied);
    if (canonicalJson(bounded(result)) !== encoded) throw new Error('Provider decoder changed saved value');
    return result;
  };
  const cursor = (value: unknown): ProviderCursor<M, I> => {
    const input = record(value, ['binding', 'kind', 'opaque']);
    if (input.kind !== 'provider-cursor' || canonicalJson(input.binding) !== canonicalJson(binding)) throw new Error('Foreign provider cursor');
    return { kind: 'provider-cursor', binding, opaque: decode(presentation.decodeCursor, input.opaque) };
  };
  const restore = () => {
    if (committed) { decode(presentation.decodeState, committed.state); cursor(committed.cursor); }
  };
  restore();
  const apply = (value: unknown, source: 'snapshot' | 'feed') => {
    if (source === 'snapshot') authorize();
    const item = record(bounded(value));
    if (item.kind !== 'snapshot' && item.kind !== 'event') throw new Error('Invalid provider item');
    record(item, item.kind === 'snapshot' ? ['kind', 'snapshot'] : ['kind', 'cursor', 'eventId', 'event']);
    const event = item.kind === 'event' ? { id: identifier(item.eventId), payload: canonicalJson(item) } : null;
    committed = store.commitProvider(original, committed?.revision ?? null, event, () => {
      const runs = new Map<string, ProviderRun>();
      const run = (value: unknown) => {
        const parsed = providerRun(value, storedBinding, original.installation);
        runs.set(parsed.identity.runId, parsed);
        return parsed.identity;
      };
      const refs = { run };
      let change: ProviderChange;
      if (item.kind === 'snapshot') {
        const input = record(item.snapshot, ['binding', 'cursor', 'projectionVersion', 'state', 'decisions']);
        if (canonicalJson(input.binding) !== canonicalJson(binding) || !Array.isArray(input.decisions)) throw new Error('Foreign provider snapshot');
        const projectionVersion = count(input.projectionVersion);
        if (projectionVersion < 1 || (committed && committed.projectionVersion !== projectionVersion)) throw new Error('Incompatible provider projection');
        const state = decode(presentation.decodeState, input.state), nextCursor = cursor(input.cursor);
        const decisions = input.decisions.map(value => {
          const decision = record(value, ['ref', 'run', 'prompt', 'choices']);
          const reference = providerReference(decision.ref, storedBinding, original.installation, 'decision');
          if (!Array.isArray(decision.choices)) throw new Error('Invalid provider choices');
          const choices = decision.choices.map(value => {
            const choice = record(value, ['ref', 'label']);
            const reference = providerReference(choice.ref, storedBinding, original.installation, 'choice');
            return { id: reference.ref.opaqueId, reference, label: identifier(choice.label) };
          });
          const visible = parseDecision({ pendingId: reference.ref.opaqueId, runId: run(decision.run).runId,
            prompt: decision.prompt, choices: choices.map(choice => choice.id) });
          return providerDecision({ kind: 'provider', visible, reference, choices }, storedBinding, original.installation);
        });
        if (new Set(decisions.map(value => value.visible.pendingId)).size !== decisions.length) throw new Error('Duplicate provider decision');
        const transcript = parseTranscript(bounded(presentation.snapshot(decode(presentation.decodeState, state), refs)));
        change = { checkpoint: { projectionVersion, state: bounded(decode(presentation.decodeState, state)), cursor: bounded(nextCursor) }, runs: [],
          output: { kind: 'snapshot', transcript, decisions } };
      } else {
        if (!committed) throw new Error('Provider baseline missing');
        const nextCursor = cursor(item.cursor), event = decode(presentation.decodeEvent, item.event);
        const result = record(bounded(presentation.apply(decode(presentation.decodeState, committed.state), event, refs)), ['state', 'events']);
        if (!Array.isArray(result.events)) throw new Error('Invalid provider events');
        const state = decode(presentation.decodeState, result.state);
        change = { checkpoint: { projectionVersion: committed.projectionVersion, state: bounded(decode(presentation.decodeState, state)), cursor: bounded(nextCursor) }, runs: [],
          output: { kind: 'events', events: result.events.map(parseTranscriptEvent) } };
      }
      if (source === 'snapshot') authorize();
      return { ...change, runs: [...runs.values()] };
    });
    restore();
  };
  if (!committed) {
    const result = await connected.snapshot(binding);
    authorize();
    if (result.kind !== 'available') throw new Error('Provider snapshot unavailable');
    apply({ kind: 'snapshot', snapshot: result.snapshot }, 'snapshot');
  }
  if (!committed) throw new Error('Provider baseline missing');
  let stopped = false, failed = false, feedClosed = false;
  let rejectClose!: (error: Error) => void;
  const closeFailure = new Promise<never>((_resolve, reject) => { rejectClose = reject; });
  void closeFailure.catch(() => {});
  let feed: ProviderFeed<M, I> | undefined;
  let tail = Promise.resolve();
  const close = () => {
    stopped = true;
    if (!feed || feedClosed) return;
    feedClosed = true;
    try { feed.close(); } catch (error) { rejectClose(new Error('Provider stream cleanup failed')); throw error; }
  };
  const fail = () => { failed = true; try { close(); } catch {} };
  authorize();
  try { feed = connected.observe({ binding, after: cursor(committed.cursor) }, value => {
    if (stopped) return Promise.reject(new Error('Provider stream closed'));
    let copied: Json;
    try { copied = bounded(value); authorize(); }
    catch { fail(); return Promise.reject(new Error('Invalid provider item')); }
    const task = tail.then(() => {
      if (failed) throw new Error('Provider stream failed');
      apply(copied, 'feed');
    });
    tail = task.catch(fail);
    return task;
  }); } catch (error) { failed = true; stopped = true; await tail; throw error; }
  if (stopped) fail();
  const drained = Promise.race([feed.ended, closeFailure]).finally(async () => {
    stopped = true;
    await tail;
  }).then(() => {});
  return { close, drained };
}
