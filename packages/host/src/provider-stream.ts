import { parseProviderObservations } from './provider-observations.js';
import type { ObservationMapper, ProviderObservations } from './provider-observations.js';
import type { AguiOriginalRun } from '@agentui/sdk';
import type { FrontendObservations, PreparedProviderObservations } from './frontend-observations.js';
import { canonicalJson, copyJson, parseDecision } from '@agentui/contracts';
import type { Json, PendingDecision, ObservationStopReason } from '@agentui/contracts';
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
  hasFrontendObservations?(scope: ProviderCreation['intent']['scope']): boolean;
  prepareProviderObservations?(original: ProviderCreation, event: { readonly id: string; readonly payload: string } | null,
    factory: typeof FrontendObservations, map: (originals: readonly AguiOriginalRun<string>[]) => ProviderObservations):
    { readonly kind: 'duplicate'; readonly checkpoint: ProviderCheckpoint } | { readonly kind: 'prepared'; readonly value: PreparedProviderObservations };
  providerCheckpoint(original: ProviderCreation): ProviderCheckpoint | null;
  commitProvider(original: ProviderCreation, expected: number | null,
    event: { readonly id: string; readonly payload: string } | null, render: () => ProviderChange, prepared?: PreparedProviderObservations): ProviderCheckpoint;
}
export interface ProviderStream { close(): void; readonly drained: Promise<ObservationStopReason | 'closed'> }
export class ObservationFailure extends Error {
  constructor(readonly reason: ObservationStopReason) { super(reason); }
}
export function observationFailure(error: unknown, fallback: ObservationStopReason): ObservationStopReason {
  return error instanceof ObservationFailure ? error.reason : fallback;
}
export function providerCheckpoint(value: unknown): ProviderCheckpoint {
  const input = record(value, ['revision', 'projectionVersion', 'state', 'cursor']);
  const revision = count(input.revision), projectionVersion = count(input.projectionVersion);
  if (revision < 1 || projectionVersion < 1) throw new Error('Invalid provider checkpoint');
  return { revision, projectionVersion, state: copyJson(input.state), cursor: copyJson(input.cursor) };
}

export async function observeProvider<M extends ProviderModel, I extends string>(connected: ConnectedProvider<M, I>,
  presentation: ProviderPresentation<M, I>, original: ProviderCreation, binding: ProviderConversation<I>,
  authorize: () => void, store: ProviderStreamStore, freshSnapshot = false, observations?: ObservationMapper<M, I>): Promise<ProviderStream> {
  const observationFactory = observations || store.hasFrontendObservations?.(original.intent.scope)
    ? (await import('./frontend-observations.js')).FrontendObservations : undefined;
  const storedBinding = creationBinding(binding, original.intent, original.installation);
  let committed: ProviderCheckpoint | null;
  try { committed = store.providerCheckpoint(original); }
  catch { throw new ObservationFailure('invalid-projection'); }
  let stopping = false;
  const ensureRunning = () => {
    if (stopping) throw new Error('Provider stream closed');
    authorize();
    if (stopping) throw new Error('Provider stream closed');
  };
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
  try { restore(); } catch { throw new ObservationFailure('invalid-projection'); }
  const apply = (value: unknown, source: 'snapshot' | 'feed') => {
    if (source === 'snapshot') ensureRunning();
    const item = record(bounded(value));
    if (item.kind !== 'snapshot' && item.kind !== 'event') throw new Error('Invalid provider item');
    record(item, item.kind === 'snapshot' ? ['kind', 'snapshot'] : ['kind', 'cursor', 'eventId', 'event']);
    const event = item.kind === 'event' ? { id: identifier(item.eventId), payload: canonicalJson(item) } : null;
    const revision = committed?.revision ?? null;
    let prepared: { kind: 'snapshot'; state: M['state'] } | { kind: 'event'; event: M['event'] } | undefined;
    const mapped = observationFactory ? store.prepareProviderObservations?.(original, event, observationFactory, originals => {
      if (!observations) return { kind: 'absent' };
      let mapped: unknown;
      if (item.kind === 'snapshot') {
        const input = record(item.snapshot, ['binding', 'cursor', 'projectionVersion', 'state', 'decisions']);
        prepared = { kind: 'snapshot', state: decode(presentation.decodeState, input.state) };
        const context = originals.map(value => ({ ...value, run: { binding, ref: { ...value.run.ref, instance: binding.creation.agent.instance } } }));
        mapped = observations.snapshot(structuredClone(prepared.state), structuredClone(context));
      } else {
        prepared = { kind: 'event', event: decode(presentation.decodeEvent, item.event) };
        mapped = observations.event(structuredClone(prepared.event));
      }
      const parsed = parseProviderObservations(mapped, prepared.kind, storedBinding, original.installation);
      ensureRunning();
      return parsed;
    }) : undefined;
    if (mapped?.kind === 'duplicate') { committed = mapped.checkpoint; restore(); return false; }
    committed = store.commitProvider(original, revision, event, () => {
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
        const state = prepared?.kind === 'snapshot' ? structuredClone(prepared.state) : decode(presentation.decodeState, input.state), nextCursor = cursor(input.cursor);
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
        const nextCursor = cursor(item.cursor), event = prepared?.kind === 'event' ? structuredClone(prepared.event) : decode(presentation.decodeEvent, item.event);
        const result = record(bounded(presentation.apply(decode(presentation.decodeState, committed.state), event, refs)), ['state', 'events']);
        if (!Array.isArray(result.events)) throw new Error('Invalid provider events');
        const state = decode(presentation.decodeState, result.state);
        change = { checkpoint: { projectionVersion: committed.projectionVersion, state: bounded(decode(presentation.decodeState, state)), cursor: bounded(nextCursor) }, runs: [],
          output: { kind: 'events', events: result.events.map(parseTranscriptEvent) } };
      }
      if (source === 'snapshot' || observationFactory) ensureRunning();
      return { ...change, runs: [...runs.values()] };
    }, mapped?.value);
    restore();
    return event !== null && committed.revision > (revision ?? 0);
  };
  const snapshot = async () => {
    ensureRunning();
    let result: Awaited<ReturnType<typeof connected.snapshot>>;
    try { result = await connected.snapshot(binding); }
    catch { throw new ObservationFailure('snapshot-unavailable'); }
    ensureRunning();
    switch (result.kind) {
      case 'unsupported': case 'version-unsupported': throw new ObservationFailure('unsupported');
      case 'authentication-failed': case 'unauthorized': throw new ObservationFailure('original-credentials-unavailable');
      case 'unavailable': throw new ObservationFailure('snapshot-unavailable');
      case 'available': break;
      default: { const _exhaustive: never = result; throw new ObservationFailure(_exhaustive); }
    }
    try { apply({ kind: 'snapshot', snapshot: result.snapshot }, 'snapshot'); }
    catch (error) { throw new ObservationFailure(observationFailure(error, 'invalid-projection')); }
  };
  if (!committed || freshSnapshot) await snapshot();
  if (!committed) throw new ObservationFailure('invalid-projection');
  let failed: ObservationStopReason | null = null;
  let cleanupError: Error | undefined;
  let rejectClose!: (error: Error) => void;
  const closeFailure = new Promise<never>((_resolve, reject) => { rejectClose = reject; });
  void closeFailure.catch(() => {});
  let tail = Promise.resolve();
  let closeAttempt = () => {};
  const close = () => {
    stopping = true;
    closeAttempt();
  };
  const fail = (error: unknown) => { failed ??= observationFailure(error, 'invalid-projection'); try { close(); } catch {} };
  const openAttempt = () => {
    ensureRunning();
    if (!committed) throw new Error('Provider baseline missing');
    let phase: 'accepting' | 'closing' | 'released' = 'accepting';
    let feed: ProviderFeed<M, I> | undefined;
    let progressed = false;
    const accepting = () => phase === 'accepting';
    const release = () => {
      if (phase === 'released') return;
      phase = 'closing';
      if (!feed) return;
      phase = 'released';
      try { feed.close(); }
      catch (error) {
        cleanupError = new Error('Provider stream cleanup failed');
        rejectClose(cleanupError);
        throw error;
      }
    };
    closeAttempt = release;
    const after = cursor(committed.cursor);
    ensureRunning();
    feed = connected.observe({ binding, after }, value => {
      if (stopping || !accepting()) return Promise.reject(new Error('Provider stream closed'));
      let copied: Json;
      try {
        copied = bounded(value); ensureRunning();
        if (!accepting()) throw new Error('Provider stream closed');
      } catch (error) { fail(error); return Promise.reject(new Error('Invalid provider item')); }
      const task = tail.then(() => {
        if (failed) throw new Error('Provider stream failed');
        if (apply(copied, 'feed')) progressed = true;
      });
      tail = task.catch(fail);
      return task;
    });
    if (stopping || !accepting()) { try { release(); } catch {} }
    const ended = feed.ended.then(end => { phase = 'released'; return end; }, error => { phase = 'released'; throw error; });
    return { ended, progressed: () => progressed };
  };
  let first: ReturnType<typeof openAttempt>;
  try { first = openAttempt(); }
  catch (error) { stopping = true; await tail; throw new ObservationFailure(observationFailure(error, 'provider-disconnected')); }
  const drained = (async (): Promise<ObservationStopReason | 'closed'> => {
    let attempt = first, recoverySpent = false;
    try {
      while (true) {
        const end = await Promise.race([attempt.ended, closeFailure]);
        await tail;
        if (failed) return failed;
        if (stopping) return 'closed';
        switch (end.kind) {
          case 'unsupported': case 'version-unsupported': return 'unsupported';
          case 'authentication-failed': case 'unauthorized': return 'original-credentials-unavailable';
          case 'closed': case 'disconnected': case 'unavailable': return 'provider-disconnected';
          case 'resync': break;
          default: { const _exhaustive: never = end.kind; return _exhaustive; }
        }
        if (attempt.progressed()) recoverySpent = false;
        if (recoverySpent) return 'retry-exhausted';
        recoverySpent = true;
        try {
          await snapshot();
          attempt = openAttempt();
        } catch (error) { return stopping ? 'closed' : observationFailure(error, 'recovery-failed'); }
      }
    } finally {
      stopping = true;
      await tail;
    }
  })().then(reason => { if (cleanupError) throw cleanupError; return reason; }, error => { throw cleanupError ?? error; });
  return { close, drained };
}
