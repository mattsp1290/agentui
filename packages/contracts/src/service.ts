import { parseProviderObservationStatus } from './observation.js';
import type { ProviderObservationStatus } from './observation.js';
import { record, exact, identifier, count, utf8Bytes } from './decode.js';
import type { ConversationScope } from './index.js';
import type { HostCompatibility, NativeRuntimeIdentity } from './compatibility.js';
import { CONVERSATION_PREVIEW_LENGTH } from './conversation.js';
import type { Transcript, TranscriptEvent } from './conversation.js';
import { canonicalJson, DEFAULT_MAX_COMMAND_BYTES, parseCommand, parseReceipt, parseScope } from './durable.js';
import type { ClientCommand, ConversationPort, FeedEnd, Receipt, SubmitResult } from './durable.js';
import { CORE_CATALOG_PAGE, HOST_DEFAULT_PAGE_EVENTS, HOST_DEFAULT_PAGE_BYTES, HOST_DEFAULT_SNAPSHOT_BYTES } from './budgets.js';

const JSON_STRING_ESCAPE_EXPANSION = 6;
const SERVICE_REQUEST_ENVELOPE_HEADROOM_BYTES = 26_000;
export const SERVICE_MAX_COMMAND_BYTES = DEFAULT_MAX_COMMAND_BYTES;
export const SERVICE_MAX_REQUEST_BYTES = SERVICE_MAX_COMMAND_BYTES * JSON_STRING_ESCAPE_EXPANSION + SERVICE_REQUEST_ENVELOPE_HEADROOM_BYTES;
const SERVICE_RESPONSE_ENVELOPE_HEADROOM_BYTES = 100_000;
export const SERVICE_CATALOG_PAGE = CORE_CATALOG_PAGE;
export const SERVICE_SEARCH_QUERY_LENGTH = 200;
export const SERVICE_SEARCH_EXCERPT_LENGTH = 160;
export const SERVICE_EVENT_PAGE = Object.freeze({ events: HOST_DEFAULT_PAGE_EVENTS, bytes: HOST_DEFAULT_PAGE_BYTES });
export const SERVICE_SNAPSHOT_BYTES = HOST_DEFAULT_SNAPSHOT_BYTES;
export const SERVICE_MAX_RESPONSE_BYTES = SERVICE_SNAPSHOT_BYTES + SERVICE_RESPONSE_ENVELOPE_HEADROOM_BYTES;
export const SERVICE_FAILURE_KINDS = ['unauthorized', 'forbidden', 'invalid', 'unavailable', 'create-rejected'] as const;
export type ServiceFailureKind = typeof SERVICE_FAILURE_KINDS[number];
export class ServiceError extends Error {
  constructor(readonly kind: ServiceFailureKind, message: string) { super(message); }
}
export type ServiceRequest =
  | { readonly op: 'pair'; readonly code: string }
  | { readonly op: 'metadata' }
  | { readonly op: 'catalog'; readonly after: string | null; readonly limit: number }
  | { readonly op: 'search'; readonly query: string; readonly after: string | null }
  | { readonly op: 'create'; readonly scope: ConversationScope; readonly agentId: string }
  | { readonly op: 'conversation-agent'; readonly scope: ConversationScope }
  | { readonly op: 'provider-observation'; readonly scope: ConversationScope; readonly action: 'read' | 'retry' }
  | { readonly op: 'submit'; readonly command: ClientCommand }
  | { readonly op: 'receipt' | 'reconcile'; readonly scope: ConversationScope; readonly id: string }
  | { readonly op: 'watch'; readonly scope: ConversationScope; readonly after: number | null; readonly projectionVersion: number }
  | { readonly op: 'pull'; readonly feedId: string; readonly ack: number | null }
  | { readonly op: 'close'; readonly feedId: string };
interface AgentDescription {
  readonly id: string;
  readonly label: string;
  readonly commands: readonly ('send' | 'cancel' | 'approve')[];
  readonly availability: { readonly kind: 'ready' } | { readonly kind: 'unavailable'; readonly reason: string };
}
export type NativeAgentDescriptor = AgentDescription & {
  readonly runtime: NativeRuntimeIdentity;
  readonly model?: { readonly id: string; readonly label: string };
};
export type AgentDescriptor = NativeAgentDescriptor | (AgentDescription & {
  readonly kind: 'provider'; readonly namespace: string; readonly protocolVersion: string;
});
export interface ServiceMetadata {
  readonly agents: readonly AgentDescriptor[];
  readonly defaultAgentId: string;
  readonly hostId: string;
  readonly principalId: string;
  readonly compatibility: HostCompatibility;
}
export type ServicePull =
  | { readonly kind: 'page'; readonly page: number; readonly item: unknown }
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'ended'; readonly end: FeedEnd };
export interface ConversationCatalogEntry {
  readonly scope: ConversationScope;
  readonly preview: string | null;
}
export interface ConversationSearchEntry extends ConversationCatalogEntry {
  readonly excerpt: string | null;
}
export interface ConversationSearchPage {
  readonly items: readonly ConversationSearchEntry[];
  readonly after: string | null;
}
export interface ServiceValueMap {
  readonly pair: null;
  readonly metadata: ServiceMetadata;
  readonly catalog: readonly ConversationCatalogEntry[];
  readonly search: ConversationSearchPage;
  readonly 'conversation-agent': AgentDescriptor | null;
  readonly 'provider-observation': ProviderObservationStatus;
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
  | { readonly ok: false; readonly error: { readonly kind: ServiceFailureKind; readonly message: string } };
/** Host-classified failures reject with ServiceError. Every failed submit promise may follow admission.
 * A resolved rejection concerns this attempt and cannot rule out an earlier same-ID attempt.
 * Preserve previously uncertain commands until authoritative receipt settlement. */
export interface ServiceConnection<E = TranscriptEvent, P = Transcript> {
  pair(code: string): Promise<void>;
  metadata(): Promise<ServiceMetadata>;
  catalog(after?: string | null, limit?: number): Promise<readonly ConversationCatalogEntry[]>;
  search(query: string, after?: string | null): Promise<ConversationSearchPage>;
  create(scope: ConversationScope, agentId: string): Promise<ConversationScope>;
  conversationAgent(scope: ConversationScope): Promise<AgentDescriptor | null>;
  providerObservation(input: { readonly scope: ConversationScope; readonly action: 'read' | 'retry' }): Promise<ProviderObservationStatus>;
  conversation(scope: ConversationScope): ConversationPort<E, P>;
  reconcile(scope: ConversationScope, id: string): Promise<Receipt | null>;
}
function cursor(value: unknown): number | null { return value === null ? null : count(value); }
function nil(value: unknown): null {
  if (value !== null) throw new Error('Expected null service result');
  return null;
}
export function parseServiceRequest(value: unknown): ServiceRequest {
  canonicalJson(value);
  const input = record(value);
  switch (input.op) {
    case 'pair': exact(input, ['op', 'code']); return { op: 'pair', code: identifier(input.code) };
    case 'metadata': exact(input, ['op']); return { op: 'metadata' };
    case 'search': {
      exact(input, ['op', 'query', 'after']);
      const query = identifier(input.query, SERVICE_SEARCH_QUERY_LENGTH).replace(/\s+/gu, ' ').trim();
      if (!query) throw new Error('Enter a search query');
      return { op: 'search', query, after: input.after === null ? null : identifier(input.after) };
    }
    case 'catalog': {
      exact(input, ['op', 'after', 'limit']);
      const limit = count(input.limit);
      if (limit < 1 || limit > SERVICE_CATALOG_PAGE) throw new Error(`Catalog limit must be between 1 and ${SERVICE_CATALOG_PAGE}`);
      return { op: 'catalog', after: input.after === null ? null : identifier(input.after), limit };
    }
    case 'conversation-agent': exact(input, ['op', 'scope']); return { op: 'conversation-agent', scope: parseScope(input.scope) };
    case 'provider-observation':
      exact(input, ['op', 'scope', 'action']);
      if (input.action !== 'read' && input.action !== 'retry') throw new Error('Invalid observation action');
      return { op: 'provider-observation', scope: parseScope(input.scope), action: input.action };
    case 'create': exact(input, ['op', 'scope', 'agentId']); return { op: 'create', scope: parseScope(input.scope), agentId: identifier(input.agentId) };
    case 'submit': {
      exact(input, ['op', 'command']);
      const command = parseCommand(input.command);
      if (utf8Bytes(canonicalJson(command)) > SERVICE_MAX_COMMAND_BYTES) throw new Error('Message too large. Shorten it and try again.');
      return { op: 'submit', command };
    }
    case 'receipt': case 'reconcile':
      exact(input, ['op', 'scope', 'id']);
      return { op: input.op, scope: parseScope(input.scope), id: identifier(input.id) };
    case 'watch': {
      exact(input, ['op', 'scope', 'after', 'projectionVersion']);
      const projectionVersion = count(input.projectionVersion);
      if (!projectionVersion) throw new Error('Invalid projection version');
      return { op: 'watch', scope: parseScope(input.scope), after: cursor(input.after), projectionVersion };
    }
    case 'pull':
      exact(input, ['op', 'feedId', 'ack']);
      return { op: 'pull', feedId: identifier(input.feedId), ack: cursor(input.ack) };
    case 'close': exact(input, ['op', 'feedId']); return { op: 'close', feedId: identifier(input.feedId) };
    default: throw new Error('Unknown service operation');
  }
}
function agentDescriptor(value: unknown): AgentDescriptor {
  const input = record(value);
  exact(input, input.kind === 'provider' ? ['id', 'label', 'kind', 'namespace', 'protocolVersion', 'commands', 'availability']
    : ['id', 'label', 'runtime', 'commands', 'availability', ...(Object.hasOwn(input, 'model') ? ['model'] : [])]);
  const available = record(input.availability);
  let availability: AgentDescriptor['availability'];
  if (available.kind === 'ready') { exact(available, ['kind']); availability = { kind: 'ready' }; }
  else {
    exact(available, ['kind', 'reason']);
    if (available.kind !== 'unavailable') throw new Error('Invalid agent availability');
    availability = { kind: 'unavailable', reason: identifier(available.reason) };
  }
  if (!Array.isArray(input.commands)) throw new Error('Invalid agent commands');
  const commands = input.commands.map((command: unknown) => {
    if (command !== 'send' && command !== 'cancel' && command !== 'approve') throw new Error('Invalid agent command');
    return command;
  });
  const common = { id: identifier(input.id), label: identifier(input.label), commands, availability };
  if (input.kind === 'provider') return { ...common, kind: 'provider', namespace: identifier(input.namespace), protocolVersion: identifier(input.protocolVersion) };
  const runtime = record(input.runtime, ['engine', 'version', 'format']);
  const model = Object.hasOwn(input, 'model') ? record(input.model, ['id', 'label']) : null;
  return { ...common, runtime: { engine: identifier(runtime.engine), version: identifier(runtime.version), format: identifier(runtime.format) },
    ...(model ? { model: { id: identifier(model.id), label: identifier(model.label) } } : {}) };
}
function compatibility(value: unknown): HostCompatibility {
  const input = record(value, ['wireVersion', 'extensionSdkVersion', 'nativeRuntime', 'desiredGitRevision', 'appliedArtifact']);
  const runtime = record(input.nativeRuntime, ['engine', 'version', 'format']);
  const artifact = record(input.appliedArtifact, ['artifactId', 'gitRevision']);
  return { wireVersion: count(input.wireVersion), extensionSdkVersion: identifier(input.extensionSdkVersion),
    nativeRuntime: { engine: identifier(runtime.engine), version: identifier(runtime.version), format: identifier(runtime.format) },
    desiredGitRevision: identifier(input.desiredGitRevision),
    appliedArtifact: { artifactId: identifier(artifact.artifactId), gitRevision: identifier(artifact.gitRevision) } };
}
function feedFrame(value: unknown): unknown {
  canonicalJson(value);
  const input = record(value);
  if (input.kind === 'snapshot') {
    exact(input, ['kind', 'snapshot']);
    if (utf8Bytes(canonicalJson(input.snapshot)) > SERVICE_SNAPSHOT_BYTES) throw new Error('Service snapshot exceeds byte limit');
    return value;
  }
  exact(input, ['kind', 'events']);
  if (input.kind !== 'events' || !Array.isArray(input.events) || input.events.length > SERVICE_EVENT_PAGE.events) throw new Error('Invalid service feed item');
  if (input.events.reduce((bytes, event) => bytes + utf8Bytes(canonicalJson(event)), 0) > SERVICE_EVENT_PAGE.bytes) throw new Error('Service event page exceeds byte limit');
  return value;
}
export function parseServicePull(value: unknown): ServicePull {
  const input = record(value);
  switch (input.kind) {
    case 'page': {
      exact(input, ['kind', 'page', 'item']);
      const page = count(input.page);
      if (!page) throw new Error('Invalid service page number');
      return { kind: 'page', page, item: feedFrame(input.item) };
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
    const input = record(value, ['hostId', 'principalId', 'compatibility', 'agents', 'defaultAgentId']);
    if (!Array.isArray(input.agents)) throw new Error('Invalid agents');
    const agents = input.agents.map(agentDescriptor), defaultAgentId = identifier(input.defaultAgentId);
    if (!agents.some(agent => agent.id === defaultAgentId)) throw new Error('Missing default agent');
    return { agents, defaultAgentId, hostId: identifier(input.hostId), principalId: identifier(input.principalId), compatibility: compatibility(input.compatibility) };
  },
  catalog(value) {
    if (!Array.isArray(value) || value.length > SERVICE_CATALOG_PAGE) throw new Error('Invalid service catalog');
    return value.map(value => {
      const entry = record(value, ['scope', 'preview']);
      if (entry.preview !== null && (typeof entry.preview !== 'string' || !entry.preview ||
        entry.preview.length > CONVERSATION_PREVIEW_LENGTH || entry.preview.replace(/\s+/gu, ' ').trim() !== entry.preview)) {
        throw new Error('Invalid conversation preview');
      }
      return { scope: parseScope(entry.scope), preview: entry.preview };
    });
  },
  search(value) {
    const input = record(value, ['items', 'after']);
    if (!Array.isArray(input.items) || input.items.length > SERVICE_CATALOG_PAGE) throw new Error('Invalid search page');
    const entries = input.items.map(value => {
      const entry = record(value, ['scope', 'preview', 'excerpt']);
      const [catalog] = valueParsers.catalog([{ scope: entry.scope, preview: entry.preview }]);
      if (!catalog) throw new Error('Missing search entry');
      if (entry.excerpt !== null && (typeof entry.excerpt !== 'string' || !entry.excerpt ||
        entry.excerpt.length > SERVICE_SEARCH_EXCERPT_LENGTH)) throw new Error('Invalid search excerpt');
      return { ...catalog, excerpt: entry.excerpt };
    });
    return { items: entries, after: input.after === null ? null : identifier(input.after) };
  },
  'provider-observation': parseProviderObservationStatus,
  'conversation-agent': value => value === null ? null : agentDescriptor(value),
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
  watch(value) { const input = record(value, ['feedId']); return { feedId: identifier(input.feedId) }; },
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
  const kind = SERVICE_FAILURE_KINDS.find(kind => kind === error.kind);
  if (input.ok !== false || kind === undefined ||
    typeof error.message !== 'string' || !error.message) throw new Error('Invalid service error');
  if (kind === 'create-rejected' && request.op !== 'create') throw new Error('Invalid creation refusal');
  return { ok: false, error: { kind, message: error.message } };
}
