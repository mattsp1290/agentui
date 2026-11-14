import { record as object, nonempty, count as integer, identifier, exact } from './decode.js';
import type { ConversationScope } from './index.js';

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export const DEFAULT_MAX_COMMAND_BYTES = 64_000;
export type CommandBody =
  | { readonly kind: 'send'; readonly text: string }
  | { readonly kind: 'approve'; readonly pendingId: string; readonly choiceId: string }
  | { readonly kind: 'cancel'; readonly runId: string };
export interface ClientCommand {
  readonly version: 1;
  readonly scope: ConversationScope;
  readonly clientCommandId: string;
  readonly body: CommandBody;
}
export type ReceiptState =
  /** Admitted and possibly executing. Retrying this id never dispatches again. */
  | { readonly kind: 'pending' }
  | { readonly kind: 'accepted' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'not-dispatched'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'uncertain'; readonly reason: string };
export interface Receipt {
  readonly scope: ConversationScope;
  readonly clientCommandId: string;
  readonly hostOperationId: string;
  readonly sequence: number;
  readonly state: ReceiptState;
}
/** Rejections are not persisted and leave the command id available.
 * A full host snapshot budget returns conversation-capacity. Storage faults, settlement conflicts and
 * invalid driver results reject the promise; admitted receipts remain persisted. */
export type SubmitResult =
  | { readonly kind: 'receipt'; readonly receipt: Receipt }
  | { readonly kind: 'rejected'; readonly reason: string };
export interface PendingDecision {
  readonly pendingId: string;
  readonly runId: string;
  readonly choices: readonly string[];
  readonly prompt: string;
}
const TERMINAL_RECEIPT_RETENTION = 128;
export interface ConversationDocument<P> {
  readonly domain: P;
  /** All unresolved receipts and the latest 128 terminal receipts. Older receipts remain available through receipt(id).
   * Unresolved receipts occupy snapshot capacity until authoritative settlement; retained terminal receipts
   * are pruned only after newer terminal receipts exceed the retention count. No forced release is provided. */
  readonly receipts: Readonly<Record<string, Receipt>>;
  readonly decisions: Readonly<Record<string, PendingDecision>>;
}
export type HostEvent<E> =
  | { readonly kind: 'domain'; readonly event: E }
  | { readonly kind: 'receipt'; readonly receipt: Receipt }
  | { readonly kind: 'decision-opened'; readonly decision: PendingDecision }
  | { readonly kind: 'decision-closed'; readonly pendingId: string };
export interface Envelope<E> {
  readonly scope: ConversationScope;
  readonly sequence: number;
  readonly event: HostEvent<E>;
}
export interface Snapshot<P> {
  readonly scope: ConversationScope;
  readonly projectionVersion: number;
  readonly cursor: number;
  readonly document: ConversationDocument<P>;
}
export type FeedItem<E, P> =
  | { readonly kind: 'snapshot'; readonly snapshot: Snapshot<P> }
  | { readonly kind: 'events'; readonly events: readonly Envelope<E>[] };
export type FeedEnd = {
  readonly kind: 'closed' | 'refused' | 'resync' | 'failed';
  readonly cursor: number | null;
  readonly reason: string;
};
export interface Feed {
  close(): void;
  readonly ended: Promise<FeedEnd>;
}
export interface ConversationPort<E, P> {
  readonly scope: ConversationScope;
  submit(command: ClientCommand): Promise<SubmitResult>;
  receipt(clientCommandId: string): Promise<Receipt | null>;
  watch(request: { readonly after: number | null; readonly projectionVersion: number },
    receive: (item: FeedItem<E, P>) => Promise<void>): Feed;
}
/**
 * E and P must be plain JSON values accepted by canonicalJson. Decoders must accept their own outputs,
 * because appended and stored values are decoded again on read and write.
 * apply must return the next domain state without mutating its state or event input.
 * Version changes are refused; no in-place upgrader is provided. A migration must preserve commands,
 * evidence, captured targets, private runs, decisions, reservations and deduplication identities.
 * Replaying domain events alone does not preserve those guarantees.
 */
export interface Projection<E, P> {
  readonly version: number;
  initial(): P;
  decodeEvent(value: unknown): E;
  decodeState(value: unknown): P;
  apply(state: P, event: E): P;
}
export function sameScope(a: ConversationScope, b: ConversationScope): boolean {
  return a.hostId === b.hostId && a.conversationId === b.conversationId;
}
export function foldDocument<E, P>(document: ConversationDocument<P>, event: HostEvent<E>,
  projection: Projection<E, P>): ConversationDocument<P> {
  switch (event.kind) {
    case 'domain': return { ...document, domain: projection.apply(document.domain, event.event) };
    case 'receipt': {
      const receipts = { ...document.receipts, [event.receipt.clientCommandId]: event.receipt };
      const terminal = Object.values(receipts).filter(value => value.state.kind === 'completed' ||
        value.state.kind === 'rejected' || value.state.kind === 'not-dispatched')
        .sort((a, b) => b.sequence - a.sequence);
      for (const value of terminal.slice(TERMINAL_RECEIPT_RETENTION)) delete receipts[value.clientCommandId];
      return { ...document, receipts };
    }
    case 'decision-opened': return { ...document, decisions: { ...document.decisions, [event.decision.pendingId]: event.decision } };
    case 'decision-closed': {
      const decisions = { ...document.decisions };
      delete decisions[event.pendingId];
      return { ...document, decisions };
    }
  }
}
export function parseScope(value: unknown): ConversationScope {
  const input = object(value);
  exact(input, ['hostId', 'conversationId']);
  return { hostId: identifier(input.hostId), conversationId: identifier(input.conversationId) };
}
export function parseCommand(value: unknown): ClientCommand {
  const input = object(value);
  exact(input, ['version', 'scope', 'clientCommandId', 'body']);
  if (input.version !== 1) throw new Error('Unsupported command version');
  const body = object(input.body);
  let parsed: CommandBody;
  switch (body.kind) {
    case 'send':
      exact(body, ['kind', 'text']);
      parsed = { kind: 'send', text: nonempty(body.text) };
      break;
    case 'approve':
      exact(body, ['kind', 'pendingId', 'choiceId']);
      parsed = { kind: 'approve', pendingId: identifier(body.pendingId), choiceId: identifier(body.choiceId) };
      break;
    case 'cancel':
      exact(body, ['kind', 'runId']);
      parsed = { kind: 'cancel', runId: identifier(body.runId) };
      break;
    default: throw new Error('Unsupported command kind');
  }
  return { version: 1, scope: parseScope(input.scope), clientCommandId: identifier(input.clientCommandId), body: parsed };
}
export function parseDecision(value: unknown): PendingDecision {
  const input = object(value, ['pendingId', 'runId', 'choices', 'prompt']);
  if (!Array.isArray(input.choices)) throw new Error('Expected array');
  const choices = input.choices.map(nonempty);
  if (choices.length === 0 || new Set(choices).size !== choices.length) throw new Error('Invalid choices');
  return { pendingId: nonempty(input.pendingId), runId: nonempty(input.runId), choices, prompt: nonempty(input.prompt) };
}
export function parseReceipt(value: unknown): Receipt {
  const input = object(value, ['scope', 'clientCommandId', 'hostOperationId', 'sequence', 'state']), state = object(input.state);
  const base = { scope: parseScope(input.scope), clientCommandId: nonempty(input.clientCommandId),
    hostOperationId: nonempty(input.hostOperationId), sequence: integer(input.sequence) };
  switch (state.kind) {
    case 'pending': case 'accepted': case 'completed':
      exact(state, ['kind']); return { ...base, state: { kind: state.kind } };
    case 'not-dispatched': case 'rejected': case 'uncertain':
      exact(state, ['kind', 'reason']);
      return { ...base, state: { kind: state.kind, reason: nonempty(state.reason) } };
    default: throw new Error('Invalid receipt');
  }
}
export function parseHostEvent<E>(value: unknown, scope: ConversationScope, sequence: number,
  projection: Pick<Projection<E, unknown>, 'decodeEvent'>): HostEvent<E> {
  const event = object(value);
  switch (event.kind) {
    case 'domain': exact(event, ['kind', 'event']); return { kind: 'domain', event: projection.decodeEvent(event.event) };
    case 'receipt': {
      exact(event, ['kind', 'receipt']);
      const parsed = parseReceipt(event.receipt);
      if (!sameScope(parsed.scope, scope) || parsed.sequence !== sequence) throw new Error('Corrupt receipt event');
      return { kind: 'receipt', receipt: parsed };
    }
    case 'decision-opened': exact(event, ['kind', 'decision']); return { kind: 'decision-opened', decision: parseDecision(event.decision) };
    case 'decision-closed': exact(event, ['kind', 'pendingId']); return { kind: 'decision-closed', pendingId: nonempty(event.pendingId) };
    default: throw new Error('Corrupt event');
  }
}
export class JsonLimitError extends Error {}
export function canonicalJson(value: unknown, budget: { readonly maxNodes: number; readonly maxDepth: number } = { maxNodes: 100_000, maxDepth: 64 }): string {
  if (!Number.isSafeInteger(budget.maxNodes) || budget.maxNodes < 1 || budget.maxNodes > 100_000 ||
    !Number.isSafeInteger(budget.maxDepth) || budget.maxDepth < 1 || budget.maxDepth > 64) throw new Error('Invalid JSON budget');
  const ancestors = new Set<object>();
  let nodes = 0;
  let characters = 0;
  const token = (text: string): string => {
    characters += text.length;
    if (characters > 16_000_000) throw new JsonLimitError('JSON exceeds size limit');
    return text;
  };
  const encode = (value: unknown, depth: number): string => {
    if (++nodes > budget.maxNodes || depth > budget.maxDepth) throw new JsonLimitError('JSON exceeds structural limit');
    if (value === null || typeof value === 'boolean') return token(JSON.stringify(value));
    if (typeof value === 'string') {
      if (value.length > 16_000_000) throw new JsonLimitError('JSON exceeds size limit');
      return token(JSON.stringify(value));
    }
    if (typeof value === 'number' && Number.isFinite(value)) return token(JSON.stringify(value));
    if (!value || typeof value !== 'object') throw new Error('Invalid JSON value');
    if (ancestors.has(value)) throw new Error('Cyclic JSON value');
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new Error('Expected plain JSON object');
    if (Object.getOwnPropertySymbols(value).length) throw new Error('Invalid JSON symbol key');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !('value' in descriptor)) throw new Error('Invalid JSON array item');
          items.push(encode(descriptor.value, depth + 1));
        }
        token('[]' + ','.repeat(Math.max(0, items.length - 1)));
        return `[${items.join(',')}]`;
      }
      const fields = Object.keys(value).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw new Error('Invalid JSON property');
        return `${token(JSON.stringify(key) + ':')}${encode(descriptor.value, depth + 1)}`;
      });
      token('{}' + ','.repeat(Math.max(0, fields.length - 1)));
      return `{${fields.join(',')}}`;
    } finally { ancestors.delete(value); }
  };
  return encode(value, 0);
}
