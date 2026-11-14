import { canonicalJson, foldDocument, parseFeedItem, FeedMismatchError, parseReceipt, parseScope, sameScope } from '@agentui/contracts';
import type { ConversationDocument, ConversationScope, FeedItem, Projection, Receipt } from '@agentui/contracts';

const RETAINED_SEQUENCE_IDENTITIES = 256;

export class DeliveryError extends Error {
  constructor(readonly kind: 'resync' | 'mismatch', message: string) { super(message); }
}
function checkScope(value: unknown, scope: ConversationScope): void {
  if (!sameScope(parseScope(value), scope)) throw new DeliveryError('mismatch', 'Host scope mismatch; connect to the requested host and conversation');
}
export function decodeReceipt(value: unknown, scope: ConversationScope): Receipt {
  const receipt = parseReceipt(value);
  checkScope(receipt.scope, scope);
  return receipt;
}
export interface DeliveryState<P> {
  readonly document: ConversationDocument<P>;
  readonly cursor: number | null;
  readonly identities: ReadonlyMap<number, string>;
}
export function applyDelivery<E, P>(state: DeliveryState<P>, item: FeedItem<E, P>, scope: ConversationScope, projection: Projection<E, P>): DeliveryState<P> {
  let input: FeedItem<E, P>;
  try { input = parseFeedItem(item, projection, scope); }
  catch (error) {
    if (error instanceof FeedMismatchError) throw new DeliveryError('mismatch', error.message);
    throw error;
  }
  if (input.kind === 'snapshot') {
    const { cursor, document } = input.snapshot;
    if (state.cursor !== null && cursor < state.cursor) throw new DeliveryError('resync', 'Host snapshot cursor regressed; reconnect for a fresh snapshot');
    return { document, cursor, identities: new Map() };
  }
  if (state.cursor === null) throw new DeliveryError('resync', 'Events arrived before a snapshot; reconnect for a snapshot');
  let cursor = state.cursor;
  let document = state.document;
  const identities = new Map(state.identities);
  const rawEvents = item.kind === 'events' ? item.events : [];
  for (const [index, envelope] of input.events.entries()) {
    const { sequence, event } = envelope;
    const identity = canonicalJson(rawEvents[index]);
    if (sequence <= cursor) {
      if (identities.get(sequence) !== identity) throw new DeliveryError('resync', 'Unknown or changed duplicate sequence; reconnect for a snapshot');
      continue;
    }
    if (sequence !== cursor + 1) throw new DeliveryError('resync', 'Event sequence gap; reconnect for a snapshot');
    document = foldDocument(document, event, projection);
    cursor = sequence;
    identities.set(sequence, identity);
    if (identities.size > RETAINED_SEQUENCE_IDENTITIES) {
      const oldest = identities.keys().next();
      if (!oldest.done) identities.delete(oldest.value);
    }
  }
  return cursor === state.cursor ? state : { document, cursor, identities };
}
