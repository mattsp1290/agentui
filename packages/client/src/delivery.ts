import { canonicalJson, foldDocument, parseScope, sameScope } from '@agentui/contracts';
import type { ConversationDocument, ConversationScope, FeedItem, HostEvent, Projection, Receipt } from '@agentui/contracts';
import { copyJson, integer, object, string } from './local-state.js';

export class DeliveryError extends Error {
  constructor(readonly kind: 'resync' | 'mismatch', message: string) { super(message); }
}
function checkScope(value: unknown, scope: ConversationScope): void {
  if (!sameScope(parseScope(value), scope)) throw new DeliveryError('mismatch', 'Host scope mismatch; connect to the requested host and conversation');
}
export function decodeReceipt(value: unknown, scope: ConversationScope): Receipt {
  const input = object(value);
  checkScope(input.scope, scope);
  const state = object(input.state);
  const base = { scope, clientCommandId: string(input.clientCommandId), hostOperationId: string(input.hostOperationId), sequence: integer(input.sequence) };
  switch (state.kind) {
    case 'pending': case 'accepted': case 'completed': return { ...base, state: { kind: state.kind } };
    case 'uncertain': case 'not-dispatched': case 'rejected': return { ...base, state: { kind: state.kind, reason: string(state.reason) } };
    default: throw new Error('Unsupported receipt state');
  }
}
function decision(value: unknown) {
  const input = object(value);
  if (!Array.isArray(input.choices)) throw new Error('Invalid decision choices');
  return { pendingId: string(input.pendingId), runId: string(input.runId), choices: input.choices.map(string), prompt: string(input.prompt) };
}
function decodeEvent<E, P>(value: unknown, scope: ConversationScope, projection: Projection<E, P>): HostEvent<E> {
  const input = object(value);
  switch (input.kind) {
    case 'domain': return { kind: 'domain', event: projection.decodeEvent(input.event) };
    case 'receipt': return { kind: 'receipt', receipt: decodeReceipt(input.receipt, scope) };
    case 'decision-opened': return { kind: 'decision-opened', decision: decision(input.decision) };
    case 'decision-closed': return { kind: 'decision-closed', pendingId: string(input.pendingId) };
    default: throw new Error('Unsupported host event');
  }
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
    const document = object(snapshot.document);
    const receipts: Record<string, Receipt> = {};
    for (const [id, value] of Object.entries(object(document.receipts))) {
      const receipt = decodeReceipt(value, scope);
      if (id !== receipt.clientCommandId || receipt.sequence > cursor) throw new Error('Snapshot receipt identity or cursor mismatch');
      Object.defineProperty(receipts, id, { value: receipt, enumerable: true });
    }
    const decisions = Object.fromEntries(Object.entries(object(document.decisions)).map(([id, value]) => {
      const parsed = decision(value);
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
    const event = decodeEvent(envelope.event, scope, projection);
    if (event.kind === 'receipt' && event.receipt.sequence !== sequence) throw new Error('Receipt sequence differs from its envelope');
    document = foldDocument(document, event, projection);
    cursor = sequence;
    identities.set(sequence, identity);
    if (identities.size > 256) {
      const oldest = identities.keys().next();
      if (!oldest.done) identities.delete(oldest.value);
    }
  }
  return cursor === state.cursor ? state : { document, cursor, identities };
}
