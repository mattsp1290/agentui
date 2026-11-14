import { record, count, identifier } from './decode.js';
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

function message(value: unknown, event: boolean): TranscriptMessage {
  const input = record(value, event ? ['kind', 'messageId', 'revision', 'role', 'text', 'complete']
    : ['messageId', 'revision', 'role', 'text', 'complete']);
  const messageId = identifier(input.messageId), revision = count(input.revision);
  if (revision < 1 || (input.role !== 'user' && input.role !== 'assistant') || typeof input.text !== 'string' ||
    typeof input.complete !== 'boolean') throw new Error('Invalid transcript message');
  return { messageId, revision, role: input.role, text: input.text, complete: input.complete };
}
export function parseTranscriptEvent(value: unknown): TranscriptEvent {
  if (record(value).kind !== 'message-updated') throw new Error('Invalid transcript event');
  return { kind: 'message-updated', ...message(value, true) };
}
export function parseTranscript(value: unknown): Transcript {
  const input = record(value, ['messages']);
  if (!Array.isArray(input.messages)) throw new Error('Invalid transcript');
  const messages = input.messages.map(item => message(item, false));
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
