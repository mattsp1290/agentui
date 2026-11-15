import { record, count, identifier } from './decode.js';
import type { Projection } from './durable.js';
import { COMMAND_OUTPUT_BYTES, COMMAND_TEXT_BYTES, COMMAND_CWD_BYTES, escapedBytes, parseCommandActivity, updateCommandActivity } from './command-activity.js';
import type { CommandActivity } from './command-activity.js';
export * from './command-activity.js';

export interface TranscriptMessage {
  readonly messageId: string;
  readonly revision: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly complete: boolean;
}
export const CONVERSATION_PREVIEW_LENGTH = 80;
export function conversationPreview(transcript: Transcript): string | null {
  const text = transcript.messages.find(message => message.role === 'user')?.text.replace(/\s+/gu, ' ').trim();
  if (!text) return null;
  return text.length > CONVERSATION_PREVIEW_LENGTH ? `${text.slice(0, CONVERSATION_PREVIEW_LENGTH - 1).replace(/[\uD800-\uDBFF]$/u, '').trimEnd()}…` : text;
}
export function conversationLabel(entry: { readonly scope: { readonly conversationId: string }; readonly preview: string | null }): string {
  return entry.preview ?? `New chat · ${entry.scope.conversationId.slice(-8)}`;
}
export type RunOutcome = 'completed' | 'interrupted' | 'failed' | 'connection-lost';
export type CurrentRun =
  | { readonly kind: 'running'; readonly runId: string }
  | { readonly kind: 'stopping'; readonly runId: string; readonly clientCommandId: string }
  | { readonly kind: 'ended'; readonly runId: string; readonly outcome: RunOutcome };
export interface Transcript {
  readonly messages: readonly TranscriptMessage[];
  readonly currentRun: CurrentRun | null;
  readonly activities?: readonly CommandActivity[];
}
export type TranscriptEvent =
  | { readonly kind: 'command-updated'; readonly activity: CommandActivity }
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
    case 'command-updated':
      record(value, ['kind', 'activity']);
      return { kind: 'command-updated', activity: parseCommandActivity(input.activity) };
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
  record(value, ['messages', ...(Object.hasOwn(input, 'currentRun') ? ['currentRun'] : []),
    ...(Object.hasOwn(input, 'activities') ? ['activities'] : [])]);
  if (!Array.isArray(input.messages)) throw new Error('Invalid transcript');
  const messages = input.messages.map(item => message(item, false));
  if (new Set(messages.map(item => item.messageId)).size !== messages.length) throw new Error('Duplicate transcript message');
  let activities: readonly CommandActivity[] | undefined;
  if (Object.hasOwn(input, 'activities')) {
    if (!Array.isArray(input.activities) || !input.activities.length) throw new Error('Invalid activity collection');
    activities = input.activities.map(parseCommandActivity);
    if (new Set(activities.map(item => item.activityId)).size !== activities.length) throw new Error('Duplicate command activity');
  }
  return { messages, currentRun: Object.hasOwn(input, 'currentRun') ? currentRun(input.currentRun) : null,
    ...(activities ? { activities } : {}) };
}
export const transcriptProjection: Projection<TranscriptEvent, Transcript> = {
  version: 2,
  initial: () => ({ messages: [], currentRun: null }),
  decodeState: parseTranscript,
  decodeEvent: parseTranscriptEvent,
  reserveBytes(state) {
    const run = state.currentRun;
    if (!run || run.kind === 'ended' || !state.activities?.some(item => item.runId === run.runId)) return 0;
    return 256 + state.activities.filter(item => item.runId === run.runId && item.status.kind === 'running')
      .reduce((bytes, item) => bytes + COMMAND_OUTPUT_BYTES - escapedBytes(item.output) +
        COMMAND_TEXT_BYTES - escapedBytes(item.command) + COMMAND_CWD_BYTES - escapedBytes(item.cwd) + 256, 0);
  },
  apply(state, event) {
    const run = state.currentRun;
    switch (event.kind) {
      case 'command-updated': {
        const activities = updateCommandActivity(state.activities ?? [], event.activity);
        return activities === state.activities ? state : { ...state, activities };
      }
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
