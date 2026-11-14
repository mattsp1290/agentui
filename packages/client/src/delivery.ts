import { canonicalJson, foldDocument, parseDecision, parseHostEvent, parseReceipt, parseScope, sameScope } from '@agentui/contracts';
import type { ConversationDocument, ConversationScope, FeedItem, Projection, Receipt } from '@agentui/contracts';
import { copyJson, integer, object } from './local-state.js';

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
  const input = object(copyJson(item));
  if (input.kind === 'snapshot') {
    const snapshot = object(input.snapshot);
    checkScope(snapshot.scope, scope);
    if (snapshot.projectionVersion !== projection.version) throw new DeliveryError('mismatch', 'Projection version mismatch; update the client or select a compatible host');
    const cursor = integer(snapshot.cursor);
    if (state.cursor !== null && cursor < state.cursor) throw new DeliveryError('resync', 'Host snapshot cursor regressed; reconnect for a fresh snapshot');
    const document = object(snapshot.document);
    const receipts = Object.fromEntries(Object.entries(object(document.receipts)).map(([id, value]) => {
      const receipt = decodeReceipt(value, scope);
      if (id !== receipt.clientCommandId || receipt.sequence > cursor) throw new Error('Snapshot receipt identity or cursor mismatch');
      return [id, receipt];
    }));
    const decisions = Object.fromEntries(Object.entries(object(document.decisions)).map(([id, value]) => {
      const parsed = parseDecision(value);
      if (id !== parsed.pendingId) throw new Error('Snapshot decision identity mismatch');
      return [id, parsed];
    }));
    return { document: { domain: projection.decodeState(document.domain), receipts, decisions }, cursor, identities: new Map() };
  }
  if (input.kind !== 'events' || !Array.isArray(input.events)) throw new Error('Invalid feed item');
  if (state.cursor === null) throw new DeliveryError('resync', 'Events arrived before a snapshot; reconnect for a snapshot');
  let cursor = state.cursor;
  let document = state.document;
  const identities = new Map(state.identities);
  for (const value of input.events) {
    const envelope = object(value);
    checkScope(envelope.scope, scope);
    const sequence = integer(envelope.sequence);
    const identity = canonicalJson(envelope);
    if (sequence <= cursor) {
      if (identities.get(sequence) !== identity) throw new DeliveryError('resync', 'Unknown or changed duplicate sequence; reconnect for a snapshot');
      continue;
    }
    if (sequence !== cursor + 1) throw new DeliveryError('resync', 'Event sequence gap; reconnect for a snapshot');
    const inputEvent = object(envelope.event);
    if (inputEvent.kind === 'receipt') checkScope(object(inputEvent.receipt).scope, scope);
    const event = parseHostEvent(inputEvent, scope, sequence, projection);
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
