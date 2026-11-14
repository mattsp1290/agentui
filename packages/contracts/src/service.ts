import { record, exact, identifier as text, count as integer, utf8Bytes } from './decode.js';
import type { ConversationScope } from './index.js';
import type { HostCompatibility } from './compatibility.js';
import type { Transcript, TranscriptEvent } from './conversation.js';
import { transcriptProjection } from './conversation.js';
import { canonicalJson, DEFAULT_MAX_COMMAND_BYTES, parseCommand, parseDecision, parseHostEvent, parseReceipt, parseScope } from './durable.js';
import type { ClientCommand, ConversationDocument, ConversationPort, FeedEnd, FeedItem, Receipt, SubmitResult } from './durable.js';

export const SERVICE_MAX_REQUEST_BYTES = 410_000;
export const SERVICE_MAX_RESPONSE_BYTES = 4_100_000;
export const SERVICE_MAX_SEND_TEXT = DEFAULT_MAX_COMMAND_BYTES;
export const SERVICE_MAX_COMMAND_BYTES = DEFAULT_MAX_COMMAND_BYTES;
export type ServiceRequest =
  | { readonly op: 'pair'; readonly code: string }
  | { readonly op: 'metadata' }
  | { readonly op: 'catalog'; readonly after: string | null; readonly limit: number }
  | { readonly op: 'create'; readonly scope: ConversationScope }
  | { readonly op: 'submit'; readonly command: ClientCommand }
  | { readonly op: 'receipt' | 'reconcile'; readonly scope: ConversationScope; readonly id: string }
  | { readonly op: 'watch'; readonly scope: ConversationScope; readonly after: number | null; readonly projectionVersion: number }
  | { readonly op: 'pull'; readonly feedId: string; readonly ack: number | null }
  | { readonly op: 'close'; readonly feedId: string };
export interface ServiceMetadata {
  readonly hostId: string;
  readonly principalId: string;
  readonly compatibility: HostCompatibility;
}
export type ServicePull =
  | { readonly kind: 'page'; readonly page: number; readonly item: FeedItem<TranscriptEvent, Transcript> }
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'ended'; readonly end: FeedEnd };
export interface ServiceValueMap {
  readonly pair: null;
  readonly metadata: ServiceMetadata;
  readonly catalog: readonly ConversationScope[];
  readonly create: ConversationScope;
  readonly submit: SubmitResult;
  readonly receipt: Receipt | null;
  readonly reconcile: Receipt | null;
  readonly watch: { readonly feedId: string };
  readonly pull: ServicePull;
  readonly close: null;
}
export type ServiceResponse<T = ServiceValueMap[keyof ServiceValueMap]> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly kind: 'unauthorized' | 'forbidden' | 'invalid' | 'unavailable'; readonly message: string } };
export interface ServiceConnection {
  pair(code: string): Promise<void>;
  metadata(): Promise<ServiceMetadata>;
  catalog(after?: string | null, limit?: number): Promise<readonly ConversationScope[]>;
  create(scope: ConversationScope): Promise<ConversationScope>;
  conversation(scope: ConversationScope): ConversationPort<TranscriptEvent, Transcript>;
  reconcile(scope: ConversationScope, id: string): Promise<Receipt | null>;
}
function cursor(value: unknown): number | null { return value === null ? null : integer(value); }
function nil(value: unknown): null {
  if (value !== null) throw new Error('Expected null service result');
  return null;
}
export function parseServiceRequest(value: unknown): ServiceRequest {
  canonicalJson(value);
  const input = record(value);
  switch (input.op) {
    case 'pair': exact(input, ['op', 'code']); return { op: 'pair', code: text(input.code) };
    case 'metadata': exact(input, ['op']); return { op: 'metadata' };
    case 'catalog': {
      exact(input, ['op', 'after', 'limit']);
      const limit = integer(input.limit);
      if (limit < 1 || limit > 100) throw new Error('Catalog limit must be between 1 and 100');
      return { op: 'catalog', after: input.after === null ? null : text(input.after), limit };
    }
    case 'create': exact(input, ['op', 'scope']); return { op: 'create', scope: parseScope(input.scope) };
    case 'submit': {
      exact(input, ['op', 'command']);
      const command = parseCommand(input.command);
      if (command.body.kind === 'send' && command.body.text.length > SERVICE_MAX_SEND_TEXT) throw new Error('Message too large. Shorten it and try again.');
      if (utf8Bytes(canonicalJson(command)) > SERVICE_MAX_COMMAND_BYTES) throw new Error('Message too large. Shorten it and try again.');
      return { op: 'submit', command };
    }
    case 'receipt': case 'reconcile':
      exact(input, ['op', 'scope', 'id']);
      return { op: input.op, scope: parseScope(input.scope), id: text(input.id) };
    case 'watch': {
      exact(input, ['op', 'scope', 'after', 'projectionVersion']);
      const projectionVersion = integer(input.projectionVersion);
      if (!projectionVersion) throw new Error('Invalid projection version');
      return { op: 'watch', scope: parseScope(input.scope), after: cursor(input.after), projectionVersion };
    }
    case 'pull':
      exact(input, ['op', 'feedId', 'ack']);
      return { op: 'pull', feedId: text(input.feedId), ack: cursor(input.ack) };
    case 'close': exact(input, ['op', 'feedId']); return { op: 'close', feedId: text(input.feedId) };
    default: throw new Error('Unknown service operation');
  }
}
function compatibility(value: unknown): HostCompatibility {
  const input = record(value, ['wireVersion', 'extensionSdkVersion', 'nativeRuntime', 'desiredGitRevision', 'appliedArtifact']);
  const runtime = record(input.nativeRuntime, ['engine', 'version', 'format']);
  const artifact = record(input.appliedArtifact, ['artifactId', 'gitRevision']);
  return { wireVersion: integer(input.wireVersion), extensionSdkVersion: text(input.extensionSdkVersion),
    nativeRuntime: { engine: text(runtime.engine), version: text(runtime.version), format: text(runtime.format) },
    desiredGitRevision: text(input.desiredGitRevision),
    appliedArtifact: { artifactId: text(artifact.artifactId), gitRevision: text(artifact.gitRevision) } };
}
function feedItem(value: unknown): FeedItem<TranscriptEvent, Transcript> {
  const input = record(value);
  if (input.kind === 'snapshot') {
    exact(input, ['kind', 'snapshot']);
    const snapshot = record(input.snapshot, ['scope', 'projectionVersion', 'cursor', 'document']);
    const raw = record(snapshot.document, ['domain', 'receipts', 'decisions']);
    const receipts = Object.fromEntries(Object.entries(record(raw.receipts)).map(([id, item]) => [id, parseReceipt(item)]));
    const decisions = Object.fromEntries(Object.entries(record(raw.decisions)).map(([id, item]) => [id, parseDecision(item)]));
    const document: ConversationDocument<Transcript> = { domain: transcriptProjection.decodeState(raw.domain), receipts, decisions };
    return { kind: 'snapshot', snapshot: { scope: parseScope(snapshot.scope), projectionVersion: integer(snapshot.projectionVersion),
      cursor: integer(snapshot.cursor), document } };
  }
  exact(input, ['kind', 'events']);
  if (input.kind !== 'events' || !Array.isArray(input.events) || input.events.length > 64) throw new Error('Invalid service feed item');
  if (utf8Bytes(canonicalJson(input)) > 256_000) throw new Error('Service event page exceeds byte limit');
  return { kind: 'events', events: input.events.map(value => {
    const envelope = record(value, ['scope', 'sequence', 'event']);
    const scope = parseScope(envelope.scope), sequence = integer(envelope.sequence);
    return { scope, sequence, event: parseHostEvent(envelope.event, scope, sequence, transcriptProjection) };
  }) };
}
export function parseServicePull(value: unknown): ServicePull {
  const input = record(value);
  switch (input.kind) {
    case 'page': {
      exact(input, ['kind', 'page', 'item']);
      const page = integer(input.page);
      if (!page) throw new Error('Invalid service page number');
      return { kind: 'page', page, item: feedItem(input.item) };
    }
    case 'heartbeat': exact(input, ['kind']); return { kind: 'heartbeat' };
    case 'ended': {
      exact(input, ['kind', 'end']);
      const end = record(input.end, ['kind', 'cursor', 'reason']);
      if (end.kind !== 'closed' && end.kind !== 'refused' && end.kind !== 'resync' && end.kind !== 'failed') throw new Error('Invalid service feed end');
      if (typeof end.reason !== 'string' || !end.reason) throw new Error('Invalid service feed reason');
      return { kind: 'ended', end: { kind: end.kind, cursor: cursor(end.cursor), reason: end.reason } };
    }
    default: throw new Error('Invalid service pull');
  }
}
const valueParsers: { readonly [K in keyof ServiceValueMap]: (value: unknown) => ServiceValueMap[K] } = {
  pair: nil, close: nil,
  metadata(value) {
    const input = record(value, ['hostId', 'principalId', 'compatibility']);
    return { hostId: text(input.hostId), principalId: text(input.principalId), compatibility: compatibility(input.compatibility) };
  },
  catalog(value) {
    if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid service catalog');
    return value.map(parseScope);
  },
  create: parseScope,
  submit(value) {
    const input = record(value);
    if (input.kind === 'receipt') { exact(input, ['kind', 'receipt']); return { kind: 'receipt', receipt: parseReceipt(input.receipt) }; }
    exact(input, ['kind', 'reason']);
    if (input.kind !== 'rejected' || typeof input.reason !== 'string' || !input.reason) throw new Error('Invalid submit result');
    return { kind: 'rejected', reason: input.reason };
  },
  receipt: value => value === null ? null : parseReceipt(value),
  reconcile: value => value === null ? null : parseReceipt(value),
  watch(value) { const input = record(value, ['feedId']); return { feedId: text(input.feedId) }; },
  pull: parseServicePull,
};
export function parseServiceResponse<K extends keyof ServiceValueMap>(request: { readonly op: K }, value: unknown): ServiceResponse<ServiceValueMap[K]> {
  canonicalJson(value);
  const input = record(value);
  if (input.ok === true) {
    exact(input, ['ok', 'value']);
    return { ok: true, value: valueParsers[request.op](input.value) };
  }
  exact(input, ['ok', 'error']);
  const error = record(input.error, ['kind', 'message']);
  if (input.ok !== false || (error.kind !== 'unauthorized' && error.kind !== 'forbidden' && error.kind !== 'invalid' && error.kind !== 'unavailable') ||
    typeof error.message !== 'string' || !error.message) throw new Error('Invalid service error');
  return { ok: false, error: { kind: error.kind, message: error.message } };
}
