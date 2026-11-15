import { record, count, identifier } from './decode.js';
import type { Projection } from './durable.js';

export interface TranscriptMessage {
  readonly messageId: string;
  readonly revision: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly complete: boolean;
}
export type RunOutcome = 'completed' | 'interrupted' | 'failed' | 'connection-lost';
export type CurrentRun =
  | { readonly kind: 'running'; readonly runId: string }
  | { readonly kind: 'stopping'; readonly runId: string; readonly clientCommandId: string }
  | { readonly kind: 'ended'; readonly runId: string; readonly outcome: RunOutcome };
export interface Transcript {
  readonly messages: readonly TranscriptMessage[];
  readonly currentRun: CurrentRun | null;
}
export type TranscriptEvent =
  | (TranscriptMessage & { readonly kind: 'message-updated' })
  | { readonly kind: 'run-started'; readonly runId: string; readonly previousRunId: string | null }
  | { readonly kind: 'run-stop-requested' | 'run-stop-rejected'; readonly runId: string; readonly clientCommandId: string }
  | { readonly kind: 'run-ended'; readonly runId: string; readonly outcome: RunOutcome };

function message(value: unknown, event: boolean): TranscriptMessage {
  const input = record(value, event ? ['kind', 'messageId', 'revision', 'role', 'text', 'complete']
    : ['messageId', 'revision', 'role', 'text', 'complete']);
  const messageId = identifier(input.messageId), revision = count(input.revision);
  if (revision < 1 || (input.role !== 'user' && input.role !== 'assistant') || typeof input.text !== 'string' ||
    typeof input.complete !== 'boolean') throw new Error('Invalid transcript message');
  return { messageId, revision, role: input.role, text: input.text, complete: input.complete };
}
function outcome(value: unknown): RunOutcome {
  if (value !== 'completed' && value !== 'interrupted' && value !== 'failed' && value !== 'connection-lost') {
    throw new Error('Invalid run outcome');
  }
  return value;
}
function currentRun(value: unknown): CurrentRun | null {
  if (value === null) return null;
  const input = record(value);
  const runId = identifier(input.runId);
  switch (input.kind) {
    case 'running':
      record(value, ['kind', 'runId']);
      return { kind: 'running', runId };
    case 'stopping':
      record(value, ['kind', 'runId', 'clientCommandId']);
      return { kind: 'stopping', runId, clientCommandId: identifier(input.clientCommandId) };
    case 'ended':
      record(value, ['kind', 'runId', 'outcome']);
      return { kind: 'ended', runId, outcome: outcome(input.outcome) };
    default: throw new Error('Invalid current run');
  }
}
export function parseTranscriptEvent(value: unknown): TranscriptEvent {
  const input = record(value);
  switch (input.kind) {
    case 'message-updated': return { kind: 'message-updated', ...message(value, true) };
    case 'run-started':
      record(value, ['kind', 'runId', 'previousRunId']);
      return { kind: input.kind, runId: identifier(input.runId),
        previousRunId: input.previousRunId === null ? null : identifier(input.previousRunId) };
    case 'run-stop-requested':
    case 'run-stop-rejected':
      record(value, ['kind', 'runId', 'clientCommandId']);
      return { kind: input.kind, runId: identifier(input.runId), clientCommandId: identifier(input.clientCommandId) };
    case 'run-ended':
      record(value, ['kind', 'runId', 'outcome']);
      return { kind: input.kind, runId: identifier(input.runId), outcome: outcome(input.outcome) };
    default: throw new Error('Invalid transcript event');
  }
}
export function parseTranscript(value: unknown): Transcript {
  const input = record(value);
  record(value, Object.hasOwn(input, 'currentRun') ? ['messages', 'currentRun'] : ['messages']);
  if (!Array.isArray(input.messages)) throw new Error('Invalid transcript');
  const messages = input.messages.map(item => message(item, false));
  if (new Set(messages.map(item => item.messageId)).size !== messages.length) throw new Error('Duplicate transcript message');
  return { messages, currentRun: Object.hasOwn(input, 'currentRun') ? currentRun(input.currentRun) : null };
}
export const transcriptProjection: Projection<TranscriptEvent, Transcript> = {
  version: 1,
  initial: () => ({ messages: [], currentRun: null }),
  decodeState: parseTranscript,
  decodeEvent: parseTranscriptEvent,
  apply(state, event) {
    const run = state.currentRun;
    switch (event.kind) {
      case 'run-started':
        if (run && (run.kind !== 'ended' || run.runId === event.runId || run.runId !== event.previousRunId)) return state;
        return { ...state, currentRun: { kind: 'running', runId: event.runId } };
      case 'run-stop-requested':
        if (run?.kind !== 'running' || run.runId !== event.runId) return state;
        return { ...state, currentRun: { kind: 'stopping', runId: event.runId, clientCommandId: event.clientCommandId } };
      case 'run-stop-rejected':
        if (run?.kind !== 'stopping' || run.runId !== event.runId || run.clientCommandId !== event.clientCommandId) return state;
        return { ...state, currentRun: { kind: 'running', runId: event.runId } };
      case 'run-ended':
        if (!run || run.kind === 'ended' || run.runId !== event.runId) return state;
        return { ...state, currentRun: { kind: 'ended', runId: event.runId, outcome: event.outcome } };
      case 'message-updated': break;
    }
    const index = state.messages.findIndex(item => item.messageId === event.messageId);
    const next: TranscriptMessage = { messageId: event.messageId, revision: event.revision,
      role: event.role, text: event.text, complete: event.complete };
    const previous = state.messages[index];
    if (!previous) return { ...state, messages: [...state.messages, next] };
    if (previous.role !== event.role) throw new Error('Transcript message role changed');
    if (event.revision < previous.revision) return state;
    if (event.revision === previous.revision) {
      if (previous.text !== event.text || previous.complete !== event.complete) throw new Error('Conflicting transcript revision');
      return state;
    }
    if (previous.complete) throw new Error('Completed transcript message changed');
    return { ...state, messages: state.messages.map((item, position) => position === index ? next : item) };
  },
};
