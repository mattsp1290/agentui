import { parseFrontendOffer } from './frontend-sends.js';
import type { OfferedCommand } from './frontend-sends.js';
import { parsePermissionScope } from './permissions.js';
import type { PermissionScope } from './permissions.js';
import { record, nonempty, count, identifier, exact, utf8Bytes } from './decode.js';
import type { ConversationScope, ProviderBinding, RunAuthority, RunIdentity } from './index.js';
import { parseImageId } from './image.js';
import type { ImageId } from './image.js';

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export const DEFAULT_MAX_COMMAND_BYTES = 64_000;
export const JSON_MAX_NODES = 100_000;
export const JSON_MAX_DEPTH = 64;
export type CommandBody =
  | { readonly kind: 'send'; readonly text: string; readonly imageId?: ImageId }
  | { readonly kind: 'approve'; readonly pendingId: string; readonly choiceId: string }
  | { readonly kind: 'cancel'; readonly runId: string }
  | { readonly kind: 'revoke-permission'; readonly permissionId: string; readonly scope: PermissionScope };
export type ClientCommand = LegacyCommand | OfferedCommand;
export interface LegacyCommand {
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
/** Rejections leave the command id available, except an owner-specific frontend unavailability tombstone.
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
  readonly choiceLabels?: Readonly<Record<string, string>>;
  readonly reserved?: true;
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
  reserveBytes?(state: P): number;
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
  const input = record(value);
  exact(input, ['hostId', 'conversationId']);
  return { hostId: identifier(input.hostId), conversationId: identifier(input.conversationId) };
}
export function parseProviderBinding(value: unknown): ProviderBinding {
  const input = record(value, ['namespace', 'installationId', 'opaqueSessionId']);
  return { namespace: nonempty(input.namespace), installationId: nonempty(input.installationId), opaqueSessionId: nonempty(input.opaqueSessionId) };
}
export function parseRunAuthority(value: unknown): RunAuthority {
  const input = record(value);
  switch (input.kind) {
    case 'agentui-host':
      exact(input, ['kind', 'hostId', 'binding']);
      return { kind: 'agentui-host', hostId: identifier(input.hostId), binding: parseProviderBinding(input.binding) };
    case 'remote-provider':
      exact(input, ['kind', 'binding']);
      return { kind: 'remote-provider', binding: parseProviderBinding(input.binding) };
    default: throw new Error('Invalid run authority');
  }
}
export function parseRunIdentity(value: unknown): RunIdentity {
  const input = record(value, ['conversation', 'runId', 'authority']);
  const conversation = parseScope(input.conversation);
  const authority = parseRunAuthority(input.authority);
  if (authority.kind === 'agentui-host' && authority.hostId !== conversation.hostId) throw new Error('Run authority host mismatch');
  return { conversation, runId: nonempty(input.runId), authority };
}
/**
 * Local scope and command IDs are limited to 1024 UTF-16 units. Approval and cancel targets preserve
 * nonempty provider-owned IDs. Semantic parsing does not enforce host resource budgets.
 * New host admission checks canonical command bytes and event and snapshot capacity before durable
 * persistence and dispatch. Earlier driver capability calls and application-owned draft storage are
 * outside those host limits.
 */
export function parseCommand(value: unknown): ClientCommand {
  const input = record(value);
  exact(input, ['version', 'scope', 'clientCommandId', 'body']);
  const body = record(input.body);
  if (input.version === 2) {
    exact(body, ['kind', 'text', 'frontend']);
    if (body.kind !== 'send') throw new Error('Invalid offered command');
    const command: OfferedCommand = { version: 2, scope: parseScope(input.scope), clientCommandId: identifier(input.clientCommandId),
      body: { kind: 'send', text: nonempty(body.text), frontend: parseFrontendOffer(body.frontend) } };
    if (utf8Bytes(canonicalJson(command)) > DEFAULT_MAX_COMMAND_BYTES) throw new Error('Command too large');
    return command;
  }
  if (input.version !== 1) throw new Error('Unsupported command version');
  let parsed: CommandBody;
  switch (body.kind) {
    case 'send':
      if (Object.hasOwn(body, 'imageId')) {
        exact(body, ['kind', 'text', 'imageId']);
        if (typeof body.text !== 'string') throw new Error('Invalid text');
        parsed = { kind: 'send', text: body.text, imageId: parseImageId(body.imageId) };
      } else {
        exact(body, ['kind', 'text']);
        parsed = { kind: 'send', text: nonempty(body.text) };
      }
      break;
    case 'approve':
      exact(body, ['kind', 'pendingId', 'choiceId']);
      parsed = { kind: 'approve', pendingId: nonempty(body.pendingId), choiceId: nonempty(body.choiceId) };
      break;
    case 'revoke-permission':
      exact(body, ['kind', 'permissionId', 'scope']);
      parsed = { kind: 'revoke-permission', permissionId: identifier(body.permissionId), scope: parsePermissionScope(body.scope) };
      break;
    case 'cancel':
      exact(body, ['kind', 'runId']);
      parsed = { kind: 'cancel', runId: nonempty(body.runId) };
      break;
    default: throw new Error('Unsupported command kind');
  }
  return { version: 1, scope: parseScope(input.scope), clientCommandId: identifier(input.clientCommandId), body: parsed };
}
export function parseDecision(value: unknown): PendingDecision {
  const input = record(value);
  exact(input, ['pendingId', 'runId', 'choices', 'prompt', ...(Object.hasOwn(input, 'choiceLabels') ? ['choiceLabels'] : []), ...(Object.hasOwn(input, 'reserved') ? ['reserved'] : [])]);
  if (!Array.isArray(input.choices)) throw new Error('Expected array');
  const choices = input.choices.map(nonempty);
  if (choices.length === 0 || new Set(choices).size !== choices.length) throw new Error('Invalid choices');
  let choiceLabels: Readonly<Record<string, string>> | undefined;
  if (Object.hasOwn(input, 'choiceLabels')) {
    const labels = record(input.choiceLabels, choices);
    choiceLabels = Object.fromEntries(choices.map(id => {
      const label = nonempty(labels[id]);
      if (!label.trim()) throw new Error('Invalid choice label');
      return [id, label];
    }));
  }
  if (Object.hasOwn(input, 'reserved') && (input.reserved !== true || !choiceLabels)) throw new Error('Invalid reservation');
  return { pendingId: nonempty(input.pendingId), runId: nonempty(input.runId), choices, prompt: nonempty(input.prompt),
    ...(choiceLabels ? { choiceLabels } : {}), ...(input.reserved === true ? { reserved: true } : {}) };
}
export function parseReceipt(value: unknown): Receipt {
  const input = record(value, ['scope', 'clientCommandId', 'hostOperationId', 'sequence', 'state']), state = record(input.state);
  const base = { scope: parseScope(input.scope), clientCommandId: nonempty(input.clientCommandId),
    hostOperationId: nonempty(input.hostOperationId), sequence: count(input.sequence) };
  switch (state.kind) {
    case 'pending': case 'accepted': case 'completed':
      exact(state, ['kind']); return { ...base, state: { kind: state.kind } };
    case 'not-dispatched': case 'rejected': case 'uncertain':
      exact(state, ['kind', 'reason']);
      return { ...base, state: { kind: state.kind, reason: nonempty(state.reason) } };
    default: throw new Error('Invalid receipt');
  }
}
export class FeedMismatchError extends Error {}
function checkFeedScope(actual: ConversationScope, expected: ConversationScope): void {
  if (!sameScope(actual, expected)) throw new FeedMismatchError('Host scope mismatch; connect to the requested host and conversation');
}
export function parseDocument<P>(value: unknown, decodeState: (value: unknown) => P,
  scope: ConversationScope, cursor: number): ConversationDocument<P> {
  const input = record(value, ['domain', 'receipts', 'decisions']);
  const receipts = Object.fromEntries(Object.entries(record(input.receipts)).map(([id, value]) => {
    const receipt = parseReceipt(value);
    checkFeedScope(receipt.scope, scope);
    if (id !== receipt.clientCommandId || receipt.sequence > cursor) throw new Error('Snapshot receipt identity or cursor mismatch');
    return [id, receipt];
  }));
  const decisions = Object.fromEntries(Object.entries(record(input.decisions)).map(([id, value]) => {
    const decision = parseDecision(value);
    if (id !== decision.pendingId) throw new Error('Snapshot decision identity mismatch');
    return [id, decision];
  }));
  return { domain: decodeState(input.domain), receipts, decisions };
}
export function parseHostEvent<E>(value: unknown, scope: ConversationScope, sequence: number,
  projection: Pick<Projection<E, unknown>, 'decodeEvent'>): HostEvent<E> {
  const event = record(value);
  switch (event.kind) {
    case 'domain': exact(event, ['kind', 'event']); return { kind: 'domain', event: projection.decodeEvent(event.event) };
    case 'receipt': {
      exact(event, ['kind', 'receipt']);
      const parsed = parseReceipt(event.receipt);
      checkFeedScope(parsed.scope, scope);
      if (parsed.sequence !== sequence) throw new Error('Corrupt receipt event');
      return { kind: 'receipt', receipt: parsed };
    }
    case 'decision-opened': exact(event, ['kind', 'decision']); return { kind: 'decision-opened', decision: parseDecision(event.decision) };
    case 'decision-closed': exact(event, ['kind', 'pendingId']); return { kind: 'decision-closed', pendingId: nonempty(event.pendingId) };
    default: throw new Error('Corrupt event');
  }
}
export function parseFeedItem<E, P>(value: unknown, projection: Pick<Projection<E, P>, 'version' | 'decodeState' | 'decodeEvent'>,
  expectedScope: ConversationScope): FeedItem<E, P> {
  const input = record(JSON.parse(canonicalJson(value)));
  switch (input.kind) {
    case 'snapshot': {
      exact(input, ['kind', 'snapshot']);
      const snapshot = record(input.snapshot, ['scope', 'projectionVersion', 'cursor', 'document']);
      const scope = parseScope(snapshot.scope);
      checkFeedScope(scope, expectedScope);
      const projectionVersion = count(snapshot.projectionVersion);
      if (projectionVersion !== projection.version) throw new FeedMismatchError('Projection version mismatch; update the app and host together');
      const cursor = count(snapshot.cursor);
      const document = parseDocument(snapshot.document, value => projection.decodeState(value), scope, cursor);
      return { kind: 'snapshot', snapshot: { scope, projectionVersion, cursor, document } };
    }
    case 'events': {
      exact(input, ['kind', 'events']);
      if (!Array.isArray(input.events)) throw new Error('Invalid feed events');
      const events = input.events.map(value => {
        const envelope = record(value, ['scope', 'sequence', 'event']);
        const scope = parseScope(envelope.scope);
        checkFeedScope(scope, expectedScope);
        const sequence = count(envelope.sequence);
        return { scope, sequence, event: parseHostEvent(envelope.event, scope, sequence, projection) };
      });
      return { kind: 'events', events };
    }
    default: throw new Error('Invalid feed item');
  }
}
export class JsonLimitError extends Error {}
type JsonBudget = { readonly maxNodes: number; readonly maxDepth: number };
const defaultJsonBudget: JsonBudget = { maxNodes: JSON_MAX_NODES, maxDepth: JSON_MAX_DEPTH };
export function canonicalJson(value: unknown, budget: JsonBudget = defaultJsonBudget): string {
  return serializeJson(value, budget, true);
}
/** Copies bounded plain JSON in authored key order without invoking getters or toJSON. */
export function copyJson(value: unknown, budget: JsonBudget = defaultJsonBudget): Json {
  return JSON.parse(serializeJson(value, budget, false));
}
function serializeJson(value: unknown, budget: JsonBudget, sortKeys: boolean): string {
  if (!Number.isSafeInteger(budget.maxNodes) || budget.maxNodes < 1 || budget.maxNodes > JSON_MAX_NODES ||
    !Number.isSafeInteger(budget.maxDepth) || budget.maxDepth < 1 || budget.maxDepth > JSON_MAX_DEPTH) throw new Error('Invalid JSON budget');
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
      const keys = Object.keys(value);
      if (sortKeys) keys.sort();
      const fields = keys.map(key => {
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
