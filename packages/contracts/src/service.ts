import { parseOutputList, parseOutputRead } from './output-service.js';
import { parseOutputId } from './output.js';
import type { OutputId, OutputListing, OutputRead } from './output.js';
import type { OutputListValue, OutputReadValue } from './output-service.js';
import { parseFrontendBinding } from './frontend-sends.js';
import type { FrontendBinding, FrontendBindingRequest, FrontendEligibility } from './frontend-sends.js';
import { IMAGE_FAILURE_KINDS, parseImageInputCapability, parseImageAttachment, parseImageBase64, parseImageId, parseImageName, parseUploadId } from './image.js';
import type { ImageAttachment, ImageId, ImageInputCapability, UploadId } from './image.js';
import { parseConversationPermissions } from './permissions.js';
import type { ConversationPermissions } from './permissions.js';
import { parseContinuationCarried, parseContinuationRefusal, parseConversationClosure, parseProviderObservationStatus } from './observation.js';
import type { ContinuationCarried, ContinuationRefusal, ConversationClosure, ProviderObservationStatus } from './observation.js';
import { record, exact, identifier, count, utf8Bytes } from './decode.js';
import type { ConversationScope } from './index.js';
import type { HostCompatibility, NativeRuntimeIdentity } from './compatibility.js';
import { CONVERSATION_PREVIEW_LENGTH } from './conversation.js';
import type { Transcript, TranscriptEvent } from './conversation.js';
import { canonicalJson, copyJson, DEFAULT_MAX_COMMAND_BYTES, JsonLimitError, parseCommand, parseReceipt, parseScope, sameScope } from './durable.js';
import type { ClientCommand, ConversationPort, FeedEnd, Json, Receipt, SubmitResult } from './durable.js';
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
export const SERVICE_FAILURE_KINDS = ['forbidden', 'invalid', 'unavailable', 'create-rejected', ...IMAGE_FAILURE_KINDS] as const;
export type ServiceFailureKind = typeof SERVICE_FAILURE_KINDS[number];
export class ServiceError extends Error {
  constructor(readonly kind: ServiceFailureKind, message: string) { super(message); }
}
export type ContinuationAction = 'read' | 'check' | 'start';
/** Canonical JSON byte limits for one extension operation call. */
export const EXTENSION_CALL_INPUT_BYTES = DEFAULT_MAX_COMMAND_BYTES;
export const EXTENSION_CALL_OUTPUT_BYTES = 256_000;
export const EXTENSION_CALL_FAILURES = ['unknown-extension', 'unknown-installation', 'unknown-operation',
  'unavailable', 'too-large', 'invalid-result', 'threw', 'timeout'] as const;
export type ExtensionCallFailure = typeof EXTENSION_CALL_FAILURES[number];
export interface ExtensionCallRequest {
  readonly namespace: string;
  /** `ProviderInstance.installationId` of the installation the operation runs for. */
  readonly installationId: string;
  readonly operation: string;
  readonly input: Json;
}
export type ExtensionCallValue =
  | { readonly kind: 'ok'; readonly output: Json }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'failed'; readonly cause: ExtensionCallFailure };
export interface ExtensionInstallationStatus {
  readonly installationId: string;
  readonly status: 'available' | 'unavailable';
}
/** A configured server extension namespace. It never carries a credential, handle or service origin. */
export interface ExtensionDescriptor {
  readonly namespace: string;
  readonly state: 'active' | 'failed';
  readonly operations: readonly string[];
  readonly installations: readonly ExtensionInstallationStatus[];
}
const EXTENSION_NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/u;
const EXTENSION_OPERATION = /^[a-z][a-z0-9.-]{0,63}$/u;
const EXTENSION_REFUSAL = /^[a-z][a-z0-9-]{0,63}$/u;
function patterned(value: unknown, pattern: RegExp, name: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`Invalid extension ${name}`);
  return value;
}
/** An extension call input or output over its byte or structural limit. */
export class ExtensionCallTooLarge extends Error {}
function boundedJson(value: unknown, limit: number): Json {
  let copy: Json;
  try { copy = copyJson(value); }
  catch (error) { throw error instanceof JsonLimitError ? new ExtensionCallTooLarge('Extension call value exceeds limit') : error; }
  if (utf8Bytes(canonicalJson(copy)) > limit) throw new ExtensionCallTooLarge('Extension call value exceeds byte limit');
  return copy;
}
export function parseExtensionCallRequest(value: unknown): ExtensionCallRequest {
  const input = record(value, ['namespace', 'installationId', 'operation', 'input']);
  return { namespace: patterned(input.namespace, EXTENSION_NAMESPACE, 'namespace'), installationId: identifier(input.installationId),
    operation: patterned(input.operation, EXTENSION_OPERATION, 'operation'), input: boundedJson(input.input, EXTENSION_CALL_INPUT_BYTES) };
}
export function parseExtensionCallValue(value: unknown): ExtensionCallValue {
  const input = record(value);
  switch (input.kind) {
    case 'ok': exact(input, ['kind', 'output']); return { kind: 'ok', output: boundedJson(input.output, EXTENSION_CALL_OUTPUT_BYTES) };
    case 'refused': exact(input, ['kind', 'code']); return { kind: 'refused', code: patterned(input.code, EXTENSION_REFUSAL, 'refusal') };
    case 'failed': {
      exact(input, ['kind', 'cause']);
      const cause = EXTENSION_CALL_FAILURES.find(cause => cause === input.cause);
      if (!cause) throw new Error('Invalid extension call failure');
      return { kind: 'failed', cause };
    }
    default: throw new Error('Invalid extension call result');
  }
}
function extensionDescriptor(value: unknown): ExtensionDescriptor {
  const input = record(value, ['namespace', 'state', 'operations', 'installations']);
  if (input.state !== 'active' && input.state !== 'failed') throw new Error('Invalid extension state');
  if (!Array.isArray(input.operations) || !Array.isArray(input.installations)) throw new Error('Invalid extension descriptor');
  const operations = input.operations.map(operation => patterned(operation, EXTENSION_OPERATION, 'operation'));
  if (new Set(operations).size !== operations.length || (input.state === 'failed' && operations.length)) throw new Error('Invalid extension operations');
  return { namespace: patterned(input.namespace, EXTENSION_NAMESPACE, 'namespace'), state: input.state, operations,
    installations: input.installations.map(item => {
      const installation = record(item, ['installationId', 'status']);
      if (installation.status !== 'available' && installation.status !== 'unavailable') throw new Error('Invalid extension installation status');
      return { installationId: identifier(installation.installationId), status: installation.status };
    }) };
}
export interface ContinuationView {
  readonly predecessor: ConversationScope | null;
  readonly carried: ContinuationCarried | null;
  /** `unknown` while no loaded provider can read the conversation's saved closure; `null` means it is open. */
  readonly closure: ConversationClosure | 'unknown' | null;
  readonly successor: null | { readonly kind: 'starting' | 'pending' | 'unconfirmed' }
    | { readonly kind: 'refused'; readonly refusal: ContinuationRefusal }
    | { readonly kind: 'confirmed'; readonly scope: ConversationScope };
}
export type ServiceRequest =
  | { readonly op: 'output-list'; readonly scope: ConversationScope }
  | { readonly op: 'output-read'; readonly scope: ConversationScope; readonly outputId: OutputId }
  | ({ readonly op: 'frontend-binding' } & FrontendBindingRequest)
  | { readonly op: 'image-upload'; readonly scope: ConversationScope; readonly uploadId: UploadId; readonly name: string; readonly byteLength: number; readonly base64: string }
  | { readonly op: 'image-read'; readonly scope: ConversationScope; readonly imageId: ImageId }
  | { readonly op: 'metadata' }
  | { readonly op: 'catalog'; readonly after: string | null; readonly limit: number; readonly filter?: CatalogFilter }
  | { readonly op: 'search'; readonly query: string; readonly after: string | null }
  | { readonly op: 'create'; readonly scope: ConversationScope; readonly agentId: string }
  | { readonly op: 'conversation-permissions'; readonly scope: ConversationScope }
  | { readonly op: 'conversation-agent'; readonly scope: ConversationScope }
  | { readonly op: 'provider-observation'; readonly scope: ConversationScope; readonly action: 'read' | 'retry' }
  | { readonly op: 'continuation'; readonly scope: ConversationScope; readonly action: ContinuationAction }
  | { readonly op: 'submit'; readonly command: ClientCommand }
  | { readonly op: 'receipt' | 'reconcile' | 'abandon'; readonly scope: ConversationScope; readonly id: string }
  | { readonly op: 'watch'; readonly scope: ConversationScope; readonly after: number | null; readonly projectionVersion: number }
  | { readonly op: 'pull'; readonly feedId: string; readonly ack: number | null }
  | { readonly op: 'close'; readonly feedId: string }
  | ({ readonly op: 'extension-call' } & ExtensionCallRequest);
/** Narrows `catalog` to one namespace or one provider agent, read from the installation stored with each conversation. */
export type CatalogFilter =
  | { readonly kind: 'namespace'; readonly namespace: string }
  | { readonly kind: 'provider-agent'; readonly namespace: string; readonly installationId: string; readonly providerAgentId: string };
/** The provider identity stored with a conversation; `null` for native and recorded conversations. */
export interface ConversationProvider {
  readonly namespace: string;
  readonly installationId: string;
  readonly providerAgentId: string;
}
interface AgentDescription {
  readonly imageInput: ImageInputCapability;
  readonly frontendOffers: FrontendEligibility;
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
  /** `ProviderInstance.installationId`. */
  readonly installationId: string;
  /** The provider's agent `opaqueId`, visible to clients; `null` for an installation-level descriptor. */
  readonly providerAgentId: string | null;
});
export interface ServiceMetadata {
  readonly agents: readonly AgentDescriptor[];
  readonly defaultAgentId: string | null;
  readonly hostId: string;
  readonly principalId: string;
  readonly compatibility: HostCompatibility;
  /** Sorted by namespace; each installation list is sorted by installation ID. */
  readonly extensions: readonly ExtensionDescriptor[];
}
export type ServicePull =
  | { readonly kind: 'page'; readonly page: number; readonly item: unknown }
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'ended'; readonly end: FeedEnd };
export interface ConversationCatalogEntry {
  readonly scope: ConversationScope;
  readonly preview: string | null;
  readonly provider: ConversationProvider | null;
}
export interface ConversationSearchEntry extends ConversationCatalogEntry {
  readonly excerpt: string | null;
}
export interface ConversationSearchPage {
  readonly items: readonly ConversationSearchEntry[];
  readonly after: string | null;
}
export interface ServiceValueMap {
  readonly 'output-list': OutputListValue;
  readonly 'output-read': OutputReadValue;
  readonly 'frontend-binding': FrontendBinding;
  readonly 'image-upload': { readonly scope: ConversationScope; readonly attachment: ImageAttachment };
  readonly 'image-read': { readonly scope: ConversationScope; readonly attachment: ImageAttachment; readonly base64: string };
  readonly metadata: ServiceMetadata;
  readonly catalog: readonly ConversationCatalogEntry[];
  readonly search: ConversationSearchPage;
  readonly 'conversation-permissions': ConversationPermissions;
  readonly 'conversation-agent': AgentDescriptor | null;
  readonly 'provider-observation': ProviderObservationStatus;
  readonly continuation: ContinuationView;
  readonly create: ConversationScope;
  readonly submit: SubmitResult;
  readonly receipt: Receipt | null;
  readonly reconcile: Receipt | null;
  readonly abandon: Receipt | null;
  readonly watch: { readonly feedId: string };
  readonly pull: ServicePull;
  readonly close: null;
  readonly 'extension-call': ExtensionCallValue;
}
export type ServiceResponse<T = ServiceValueMap[keyof ServiceValueMap]> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly kind: ServiceFailureKind; readonly message: string } };
/** Host-classified failures reject with ServiceError. Every failed submit promise may follow admission.
 * A resolved rejection concerns this attempt and cannot rule out an earlier same-ID attempt.
 * Preserve previously uncertain commands until authoritative receipt settlement. */
export interface ServiceConnection<E = TranscriptEvent, P = Transcript> {
  conversationOutputs(scope: ConversationScope): Promise<OutputListing>;
  readOutput(scope: ConversationScope, outputId: OutputId): Promise<OutputRead>;
  frontendBinding(input: FrontendBindingRequest): Promise<FrontendBinding>;
  uploadImage(input: { readonly scope: ConversationScope; readonly uploadId: UploadId; readonly name: string; readonly bytes: Uint8Array }): Promise<ImageAttachment>;
  readImage(scope: ConversationScope, imageId: ImageId): Promise<{ readonly attachment: ImageAttachment; readonly bytes: Uint8Array }>;
  metadata(): Promise<ServiceMetadata>;
  catalog(after?: string | null, limit?: number, filter?: CatalogFilter): Promise<readonly ConversationCatalogEntry[]>;
  search(query: string, after?: string | null): Promise<ConversationSearchPage>;
  create(scope: ConversationScope, agentId: string): Promise<ConversationScope>;
  conversationPermissions(scope: ConversationScope): Promise<ConversationPermissions>;
  conversationAgent(scope: ConversationScope): Promise<AgentDescriptor | null>;
  providerObservation(input: { readonly scope: ConversationScope; readonly action: 'read' | 'retry' }): Promise<ProviderObservationStatus>;
  /** `read` reports stored state, `check` only looks up unsettled attempts, and `start` continues a concluded conversation once. */
  continuation(input: { readonly scope: ConversationScope; readonly action: ContinuationAction }): Promise<ContinuationView>;
  conversation(scope: ConversationScope): ConversationPort<E, P>;
  reconcile(scope: ConversationScope, id: string): Promise<Receipt | null>;
  /** Stop waiting on a provider send that blocks its conversation. The result says nothing about whether the send took effect. */
  abandon(scope: ConversationScope, id: string): Promise<Receipt | null>;
  /** Calls a server extension operation once. No retry and no outbox entry: a lost reply leaves the outcome unknown. */
  extensionCall(request: ExtensionCallRequest): Promise<ExtensionCallValue>;
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
    case 'output-list': exact(input, ['op', 'scope']); return { op: 'output-list', scope: parseScope(input.scope) };
    case 'output-read': exact(input, ['op', 'scope', 'outputId']); return { op: 'output-read', scope: parseScope(input.scope), outputId: parseOutputId(input.outputId) };
    case 'frontend-binding':
      exact(input, ['op', 'scope', 'id', 'action']);
      if (input.action !== 'recover' && input.action !== 'unavailable') throw new Error('Invalid binding action');
      return { op: 'frontend-binding', scope: parseScope(input.scope), id: identifier(input.id), action: input.action };
    case 'image-upload': {
      exact(input, ['op', 'scope', 'uploadId', 'name', 'byteLength', 'base64']);
      const byteLength = count(input.byteLength);
      return { op: 'image-upload', scope: parseScope(input.scope), uploadId: parseUploadId(input.uploadId), name: parseImageName(input.name),
        byteLength, base64: parseImageBase64(input.base64, byteLength) };
    }
    case 'image-read': exact(input, ['op', 'scope', 'imageId']); return { op: 'image-read', scope: parseScope(input.scope), imageId: parseImageId(input.imageId) };
    case 'metadata': exact(input, ['op']); return { op: 'metadata' };
    case 'search': {
      exact(input, ['op', 'query', 'after']);
      const query = identifier(input.query, SERVICE_SEARCH_QUERY_LENGTH).replace(/\s+/gu, ' ').trim();
      if (!query) throw new Error('Enter a search query');
      return { op: 'search', query, after: input.after === null ? null : identifier(input.after) };
    }
    case 'catalog': {
      const filtered = Object.hasOwn(input, 'filter');
      exact(input, filtered ? ['op', 'after', 'limit', 'filter'] : ['op', 'after', 'limit']);
      const limit = count(input.limit);
      if (limit < 1 || limit > SERVICE_CATALOG_PAGE) throw new Error(`Catalog limit must be between 1 and ${SERVICE_CATALOG_PAGE}`);
      return { op: 'catalog', after: input.after === null ? null : identifier(input.after), limit, ...(filtered ? { filter: parseCatalogFilter(input.filter) } : {}) };
    }
    case 'conversation-permissions': exact(input, ['op', 'scope']); return { op: 'conversation-permissions', scope: parseScope(input.scope) };
    case 'conversation-agent': exact(input, ['op', 'scope']); return { op: 'conversation-agent', scope: parseScope(input.scope) };
    case 'provider-observation':
      exact(input, ['op', 'scope', 'action']);
      if (input.action !== 'read' && input.action !== 'retry') throw new Error('Invalid observation action');
      return { op: 'provider-observation', scope: parseScope(input.scope), action: input.action };
    case 'continuation':
      exact(input, ['op', 'scope', 'action']);
      if (input.action !== 'read' && input.action !== 'check' && input.action !== 'start') throw new Error('Invalid continuation action');
      return { op: 'continuation', scope: parseScope(input.scope), action: input.action };
    case 'create': exact(input, ['op', 'scope', 'agentId']); return { op: 'create', scope: parseScope(input.scope), agentId: identifier(input.agentId) };
    case 'submit': {
      exact(input, ['op', 'command']);
      const command = parseCommand(input.command);
      if (utf8Bytes(canonicalJson(command)) > SERVICE_MAX_COMMAND_BYTES) throw new Error('Message too large. Shorten it and try again.');
      return { op: 'submit', command };
    }
    case 'receipt': case 'reconcile': case 'abandon':
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
    case 'extension-call': {
      const { op: _op, ...fields } = input;
      return { op: 'extension-call', ...parseExtensionCallRequest(fields) };
    }
    default: throw new Error('Unknown service operation');
  }
}
export function parseCatalogFilter(value: unknown): CatalogFilter {
  const input = record(value);
  if (input.kind === 'namespace') {
    exact(input, ['kind', 'namespace']);
    return { kind: 'namespace', namespace: patterned(input.namespace, EXTENSION_NAMESPACE, 'namespace') };
  }
  if (input.kind !== 'provider-agent') throw new Error('Invalid catalog filter');
  exact(input, ['kind', 'namespace', 'installationId', 'providerAgentId']);
  return { kind: 'provider-agent', namespace: patterned(input.namespace, EXTENSION_NAMESPACE, 'namespace'),
    installationId: identifier(input.installationId), providerAgentId: identifier(input.providerAgentId) };
}
function conversationProvider(value: unknown): ConversationProvider | null {
  if (value === null) return null;
  const input = record(value, ['namespace', 'installationId', 'providerAgentId']);
  return { namespace: identifier(input.namespace), installationId: identifier(input.installationId), providerAgentId: identifier(input.providerAgentId) };
}
function agentDescriptor(value: unknown): AgentDescriptor {
  const input = record(value);
  exact(input, input.kind === 'provider' ? ['imageInput', 'frontendOffers', 'id', 'label', 'kind', 'namespace', 'protocolVersion', 'installationId', 'providerAgentId', 'commands', 'availability']
    : ['imageInput', 'frontendOffers', 'id', 'label', 'runtime', 'commands', 'availability', ...(Object.hasOwn(input, 'model') ? ['model'] : [])]);
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
  if (input.frontendOffers !== 'unsupported' && (input.frontendOffers !== 'ag-ui-capture-and-bind' || input.kind !== 'provider' || !commands.includes('send'))) throw new Error('Invalid frontend eligibility');
  const common: AgentDescription = { imageInput: parseImageInputCapability(input.imageInput), frontendOffers: input.frontendOffers, id: identifier(input.id), label: identifier(input.label), commands, availability };
  if (input.kind === 'provider') return { ...common, kind: 'provider', namespace: identifier(input.namespace), protocolVersion: identifier(input.protocolVersion),
    installationId: identifier(input.installationId), providerAgentId: input.providerAgentId === null ? null : identifier(input.providerAgentId) };
  const runtime = record(input.runtime, ['engine', 'version', 'format']);
  const model = Object.hasOwn(input, 'model') ? record(input.model) : null;
  if (model) exact(model, ['id', 'label']);
  return { ...common, runtime: { engine: identifier(runtime.engine), version: identifier(runtime.version), format: identifier(runtime.format) },
    ...(model ? { model: { id: identifier(model.id), label: identifier(model.label) } } : {}) };
}
function compatibility(value: unknown): HostCompatibility {
  const input = record(value, ['wireVersion', 'extensionSdkVersion', 'nativeRuntime', 'desiredGitRevision', 'appliedArtifact']);
  const runtime = input.nativeRuntime === null ? null : record(input.nativeRuntime, ['engine', 'version', 'format']);
  const artifact = record(input.appliedArtifact, ['artifactId', 'gitRevision']);
  return { wireVersion: count(input.wireVersion), extensionSdkVersion: identifier(input.extensionSdkVersion),
    nativeRuntime: runtime === null ? null : { engine: identifier(runtime.engine), version: identifier(runtime.version), format: identifier(runtime.format) },
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
function catalogEntries(value: unknown) {
  if (!Array.isArray(value) || value.length > SERVICE_CATALOG_PAGE) throw new Error('Invalid service catalog');
  return value.map(value => {
    const entry = record(value, ['scope', 'preview', 'provider']);
    if (entry.preview !== null && (typeof entry.preview !== 'string' || !entry.preview ||
      entry.preview.length > CONVERSATION_PREVIEW_LENGTH || entry.preview.replace(/\s+/gu, ' ').trim() !== entry.preview)) {
      throw new Error('Invalid conversation preview');
    }
    return { scope: parseScope(entry.scope), preview: entry.preview, provider: conversationProvider(entry.provider) };
  });
}
/** Linked segments share the requested conversation's host and are never that conversation. */
function parseContinuationView(value: unknown, scope: ConversationScope): ContinuationView {
  const input = record(value, ['predecessor', 'carried', 'closure', 'successor']);
  const linked = (candidate: unknown): ConversationScope => {
    const other = parseScope(candidate);
    if (other.hostId !== scope.hostId || sameScope(other, scope)) throw new Error('Foreign continuation scope');
    return other;
  };
  const predecessor = input.predecessor === null ? null : linked(input.predecessor);
  const carried = input.carried === null ? null : parseContinuationCarried(input.carried);
  if (carried && !predecessor) throw new Error('Carried turns require a predecessor');
  let successor: ContinuationView['successor'] = null;
  if (input.successor !== null) {
    const next = record(input.successor);
    switch (next.kind) {
      case 'starting': case 'pending': case 'unconfirmed': exact(next, ['kind']); successor = { kind: next.kind }; break;
      case 'refused': exact(next, ['kind', 'refusal']); successor = { kind: 'refused', refusal: parseContinuationRefusal(next.refusal) }; break;
      case 'confirmed': exact(next, ['kind', 'scope']); successor = { kind: 'confirmed', scope: linked(next.scope) }; break;
      default: throw new Error('Invalid continuation successor');
    }
  }
  if (predecessor && successor?.kind === 'confirmed' && sameScope(predecessor, successor.scope)) throw new Error('Cyclic continuation');
  return { predecessor, carried, closure: input.closure === null || input.closure === 'unknown' ? input.closure : parseConversationClosure(input.closure), successor };
}
type ContextualOp = 'frontend-binding' | 'output-list' | 'output-read' | 'continuation';
type ResponseRequest = { readonly op: Exclude<keyof ServiceValueMap, ContextualOp> } | Extract<ServiceRequest, { readonly op: ContextualOp }>;
type RequestFor<K extends keyof ServiceValueMap> = ResponseRequest & { readonly op: K };
const valueParsers: { readonly [K in keyof ServiceValueMap]: (value: unknown, request: RequestFor<K>) => ServiceValueMap[K] } = {
  'output-list': (value, request) => parseOutputList(request, value),
  'output-read': (value, request) => parseOutputRead(request, value),
  'frontend-binding'(value, request) {
    const binding = parseFrontendBinding(value);
    if (binding.kind === 'bound' ? binding.command.clientCommandId !== request.id || !sameScope(binding.command.scope, request.scope) : binding.id !== request.id) throw new Error('Foreign frontend binding');
    return binding;
  },
  'image-upload'(value) {
    const input = record(value, ['scope', 'attachment']);
    return { scope: parseScope(input.scope), attachment: parseImageAttachment(input.attachment) };
  },
  'image-read'(value) {
    const input = record(value, ['scope', 'attachment', 'base64']), attachment = parseImageAttachment(input.attachment);
    return { scope: parseScope(input.scope), attachment, base64: parseImageBase64(input.base64, attachment.byteLength) };
  },
  close: nil,
  metadata(value) {
    const input = record(value, ['hostId', 'principalId', 'compatibility', 'agents', 'defaultAgentId', 'extensions']);
    if (!Array.isArray(input.agents) || !Array.isArray(input.extensions)) throw new Error('Invalid agents');
    const extensions = input.extensions.map(extensionDescriptor);
    if (extensions.some((extension, index) => index > 0 && extensions[index - 1]!.namespace >= extension.namespace) ||
      extensions.some(extension => extension.installations.some((installation, index) =>
        index > 0 && extension.installations[index - 1]!.installationId >= installation.installationId))) throw new Error('Unsorted extensions');
    const agents = input.agents.map(agentDescriptor), defaultAgentId = input.defaultAgentId === null ? null : identifier(input.defaultAgentId);
    if (defaultAgentId === null ? agents.some(agent => agent.availability.kind === 'ready') : !agents.some(agent => agent.id === defaultAgentId)) throw new Error('Missing default agent');
    return { agents, defaultAgentId, hostId: identifier(input.hostId), principalId: identifier(input.principalId), compatibility: compatibility(input.compatibility), extensions };
  },
  catalog: catalogEntries,
  search(value) {
    const input = record(value, ['items', 'after']);
    if (!Array.isArray(input.items) || input.items.length > SERVICE_CATALOG_PAGE) throw new Error('Invalid search page');
    const entries = input.items.map(value => {
      const entry = record(value, ['scope', 'preview', 'provider', 'excerpt']);
      const [catalog] = catalogEntries([{ scope: entry.scope, preview: entry.preview, provider: entry.provider }]);
      if (!catalog) throw new Error('Missing search entry');
      if (entry.excerpt !== null && (typeof entry.excerpt !== 'string' || !entry.excerpt ||
        entry.excerpt.length > SERVICE_SEARCH_EXCERPT_LENGTH)) throw new Error('Invalid search excerpt');
      return { ...catalog, excerpt: entry.excerpt };
    });
    return { items: entries, after: input.after === null ? null : identifier(input.after) };
  },
  'conversation-permissions': parseConversationPermissions,
  'provider-observation': parseProviderObservationStatus,
  continuation: (value, request) => parseContinuationView(value, request.scope),
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
  abandon: value => value === null ? null : parseReceipt(value),
  watch(value) { const input = record(value, ['feedId']); return { feedId: identifier(input.feedId) }; },
  pull: parseServicePull,
  'extension-call': parseExtensionCallValue,
};
export function parseServiceResponse<K extends keyof ServiceValueMap>(request: RequestFor<K>, value: unknown): ServiceResponse<ServiceValueMap[K]> {
  canonicalJson(value);
  const input = record(value);
  if (input.ok === true) {
    exact(input, ['ok', 'value']);
    return { ok: true, value: valueParsers[request.op](input.value, request) };
  }
  exact(input, ['ok', 'error']);
  const error = record(input.error, ['kind', 'message']);
  const kind = SERVICE_FAILURE_KINDS.find(kind => kind === error.kind);
  if (input.ok !== false || kind === undefined ||
    typeof error.message !== 'string' || !error.message) throw new Error('Invalid service error');
  if (IMAGE_FAILURE_KINDS.some(imageKind => imageKind === kind) &&
    (request.op !== 'image-upload' && request.op !== 'image-read' || error.message.length > 256)) throw new Error('Invalid image failure');
  if (kind === 'create-rejected' && request.op !== 'create') throw new Error('Invalid creation refusal');
  return { ok: false, error: { kind, message: error.message } };
}
