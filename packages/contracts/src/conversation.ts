import type { Projection } from './durable.js';

export interface TranscriptMessage {
  readonly messageId: string;
  readonly revision: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly complete: boolean;
}
export interface Transcript {
  readonly messages: readonly TranscriptMessage[];
}
export type TranscriptEvent = TranscriptMessage & { readonly kind: 'message-updated' };

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unexpected transcript field');
}
function message(value: unknown, event: boolean): TranscriptMessage {
  if (!isObject(value)) throw new Error('Invalid transcript message');
  exact(value, event ? ['kind', 'messageId', 'revision', 'role', 'text', 'complete']
    : ['messageId', 'revision', 'role', 'text', 'complete']);
  if (typeof value.messageId !== 'string' || !value.messageId || value.messageId.length > 1024 ||
    typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
    (value.role !== 'user' && value.role !== 'assistant') || typeof value.text !== 'string' ||
    typeof value.complete !== 'boolean') throw new Error('Invalid transcript message');
  return { messageId: value.messageId, revision: value.revision, role: value.role,
    text: value.text, complete: value.complete };
}
export function parseTranscriptEvent(value: unknown): TranscriptEvent {
  if (!isObject(value) || value.kind !== 'message-updated') throw new Error('Invalid transcript event');
  return { kind: 'message-updated', ...message(value, true) };
}
export function parseTranscript(value: unknown): Transcript {
  if (!isObject(value) || !Array.isArray(value.messages)) throw new Error('Invalid transcript');
  exact(value, ['messages']);
  const messages = value.messages.map(item => message(item, false));
  if (new Set(messages.map(item => item.messageId)).size !== messages.length) throw new Error('Duplicate transcript message');
  return { messages };
}
export const transcriptProjection: Projection<TranscriptEvent, Transcript> = {
  version: 1,
  initial: () => ({ messages: [] }),
  decodeState: parseTranscript,
  decodeEvent: parseTranscriptEvent,
  apply(state, event) {
    const index = state.messages.findIndex(item => item.messageId === event.messageId);
    const next: TranscriptMessage = { messageId: event.messageId, revision: event.revision,
      role: event.role, text: event.text, complete: event.complete };
    const previous = state.messages[index];
    if (!previous) return { messages: [...state.messages, next] };
    if (previous.role !== event.role) throw new Error('Transcript message role changed');
    if (event.revision < previous.revision) return state;
    if (event.revision === previous.revision) {
      if (previous.text !== event.text || previous.complete !== event.complete) throw new Error('Conflicting transcript revision');
      return state;
    }
    if (previous.complete) throw new Error('Completed transcript message changed');
    return { messages: state.messages.map((item, position) => position === index ? next : item) };
  },
};
