import { record, utf8Bytes } from './decode.js';

export const CUSTOMIZATION_SETTINGS_BYTES = 16_384;
export const CUSTOMIZATION_APPEARANCES = ['system', 'light', 'dark'] as const;
export type CustomizationAppearance = typeof CUSTOMIZATION_APPEARANCES[number];
/** A portable agent selector. It names an agent by what it is, not by a host-local agent ID. */
export type CustomizationDefaultAgent =
  | { readonly kind: 'native'; readonly harness: string; readonly model?: string }
  | { readonly kind: 'provider'; readonly namespace: string; readonly installationId: string; readonly providerAgentId: string };
/** The connected repository's `agentui-settings.json`, with defaults applied. */
export interface CustomizationSettings {
  readonly version: 1;
  readonly appearance: CustomizationAppearance;
  readonly showExtensionViews: boolean;
  readonly defaultAgent?: CustomizationDefaultAgent;
}

function bounded(value: unknown, bytes: number): string {
  if (typeof value !== 'string' || !value.trim() || utf8Bytes(value) > bytes || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Invalid settings string');
  }
  return value;
}
function defaultAgent(value: unknown): CustomizationDefaultAgent {
  const input = record(value);
  if (input.kind === 'native') {
    record(value, input.model === undefined ? ['kind', 'harness'] : ['kind', 'harness', 'model']);
    return { kind: 'native', harness: bounded(input.harness, 64), ...(input.model === undefined ? {} : { model: bounded(input.model, 128) }) };
  }
  if (input.kind !== 'provider') throw new Error('Invalid default agent');
  record(value, ['kind', 'namespace', 'installationId', 'providerAgentId']);
  return { kind: 'provider', namespace: bounded(input.namespace, 64), installationId: bounded(input.installationId, 1024),
    providerAgentId: bounded(input.providerAgentId, 1024) };
}
/** Parses a settings value. Absent members take their defaults; unknown members and other versions are refused. */
export function parseCustomizationSettings(value: unknown): CustomizationSettings {
  const input = record(value);
  const allowed = ['version', 'appearance', 'showExtensionViews', 'defaultAgent'];
  if (Object.keys(input).some(key => !allowed.includes(key)) || input.version !== 1) throw new Error('Invalid settings');
  const appearance = input.appearance === undefined ? 'system' : input.appearance;
  if (!CUSTOMIZATION_APPEARANCES.includes(appearance as CustomizationAppearance)) throw new Error('Invalid appearance');
  if (input.showExtensionViews !== undefined && typeof input.showExtensionViews !== 'boolean') throw new Error('Invalid extension views');
  return { version: 1, appearance: appearance as CustomizationAppearance, showExtensionViews: input.showExtensionViews ?? true,
    ...(input.defaultAgent === undefined ? {} : { defaultAgent: defaultAgent(input.defaultAgent) }) };
}
/** Two-space JSON with keys in a fixed order and a trailing newline, so each settings commit is a small, stable diff. */
export function serializeCustomizationSettings(settings: CustomizationSettings): string {
  const value = parseCustomizationSettings(settings);
  const agent = value.defaultAgent === undefined ? undefined : value.defaultAgent.kind === 'native'
    ? { kind: 'native', harness: value.defaultAgent.harness, ...(value.defaultAgent.model === undefined ? {} : { model: value.defaultAgent.model }) }
    : { kind: 'provider', namespace: value.defaultAgent.namespace, installationId: value.defaultAgent.installationId, providerAgentId: value.defaultAgent.providerAgentId };
  const text = JSON.stringify({ version: 1, appearance: value.appearance, showExtensionViews: value.showExtensionViews,
    ...(agent === undefined ? {} : { defaultAgent: agent }) }, null, 2) + '\n';
  if (utf8Bytes(text) > CUSTOMIZATION_SETTINGS_BYTES) throw new Error('Settings too large');
  return text;
}

// Connected customization repository: client and worker operations relayed by the host (wire 17).

export const CUSTOMIZATION_BOUNDS = Object.freeze({ location: 2_048, branch: 200, subdirectory: 1_024, key: 3_200, extensions: 256,
  workerStatus: 1_000_000, results: 32, waitSeconds: 10, tokens: 256, path: 1_024, grants: 64 });
export const CUSTOMIZATION_WORKER_FAILURES = ['worker-timeout', 'toolchain-missing', 'invalid-location', 'clone-failed', 'invalid-package',
  'invalid-settings', 'conflict', 'unknown-extension', 'unchanged', 'unsupported-format', 'identity-missing', 'push-rejected',
  'push-unauthorized', 'git-timeout', 'git-failed', 'not-ready', 'active-work', 'missing-token', 'delivery-failed', 'state-invalid', 'busy'] as const;
export type CustomizationWorkerFailure = typeof CUSTOMIZATION_WORKER_FAILURES[number];
export const CUSTOMIZATION_REFUSALS = ['unsupported', 'busy', 'draining', 'invalid-request', 'not-ready', 'missing-token', 'active-work'] as const;
export type CustomizationRefusal = typeof CUSTOMIZATION_REFUSALS[number];
export const CUSTOMIZATION_BUILD_STATES = ['queued', 'resolving', 'preparing', 'building-desktop', 'building-server', 'ready', 'failed', 'cancelled'] as const;
export type CustomizationBuildState = typeof CUSTOMIZATION_BUILD_STATES[number];
export const CUSTOMIZATION_BUILD_FAILURES = ['toolchain-missing', 'builder-changed', 'resolve-failed', 'sdk-mismatch', 'prepare-failed',
  'desktop-build-failed', 'qualification-failed', 'server-build-failed', 'timeout', 'interrupted'] as const;
export type CustomizationBuildFailure = typeof CUSTOMIZATION_BUILD_FAILURES[number];

export interface CustomizationConnection { readonly location: string; readonly branch: string; readonly subdirectory: string }
export interface CustomizationExtensionReference { readonly key: string; readonly enabled: boolean; readonly namespace: string | null }
/** One build of the connected head. `hostArtifactId` is the builder's host artifact; grant variables are names only. */
export interface CustomizationBuildStatus {
  readonly buildKey: string;
  readonly inputsKey: string;
  readonly commit: string;
  readonly state: CustomizationBuildState;
  readonly failure?: CustomizationBuildFailure;
  readonly startedAt: number;
  readonly finishedAt?: number;
  readonly namespaces: readonly string[];
  readonly ignoredGrants: readonly string[];
  readonly hostArtifactId: string;
  readonly grantVariables: readonly string[];
}
/** What the worker reports. It never holds git or build output, a path other than the connection location, or a token. */
export interface CustomizationWorkerStatus {
  readonly connection: CustomizationConnection | null;
  readonly head: string | null;
  readonly extensions: readonly CustomizationExtensionReference[];
  readonly settings: CustomizationSettings | null;
  readonly build: CustomizationBuildStatus | null;
  /** `AGENTUI_EXTENSION_*` variables set and nonblank in the launcher's environment: names only. */
  readonly presentTokens: readonly string[];
}
export interface CustomizationResult { readonly requestId: string; readonly outcome: 'ok' | CustomizationWorkerFailure }
export interface CustomizationStatus {
  readonly support: 'supported' | 'worker-offline';
  readonly connection: CustomizationConnection | null;
  readonly head: string | null;
  readonly extensions: readonly CustomizationExtensionReference[];
  readonly settings: CustomizationSettings | null;
  readonly build: CustomizationBuildStatus | null;
  readonly running: { readonly buildKey: string | null; readonly omittedGrants: readonly string[]; readonly stale: boolean };
  readonly pending: { readonly requestId: string; readonly op: CustomizationMutationOp } | null;
  readonly results: readonly CustomizationResult[];
  readonly missingTokens: readonly string[];
}
export type CustomizationReply = { readonly kind: 'accepted' } | { readonly kind: 'refused'; readonly cause: CustomizationRefusal };
/**
 * What the worker reports once a build is on the host machine, with its `ok` result for the apply request. Paths are
 * absolute on the host machine; grants hold variable names only and the host validates them.
 */
export interface CustomizationDelivery {
  readonly requestId: string;
  readonly buildKey: string;
  readonly assets: string | null;
  readonly server: { readonly directory: string; readonly artifactId: string } | null;
  readonly grants: readonly unknown[];
}
/** The host's `launch.json` build keys, returned to the worker so it can record which builds this profile uses. */
export interface CustomizationLaunchKeys { readonly current: string | null; readonly next: string | null }

export type CustomizationMutation =
  | { readonly op: 'customization-connect'; readonly requestId: string; readonly location: string; readonly branch: string; readonly subdirectory: string }
  | { readonly op: 'customization-disconnect' | 'customization-sync' | 'customization-rebuild'; readonly requestId: string }
  | { readonly op: 'customization-toggle'; readonly requestId: string; readonly key: string; readonly enabled: boolean; readonly expectedHead: string }
  | { readonly op: 'customization-settings'; readonly requestId: string; readonly settings: CustomizationSettings; readonly expectedHead: string }
  | { readonly op: 'customization-apply'; readonly requestId: string; readonly buildKey: string };
export type CustomizationMutationOp = CustomizationMutation['op'];
export type CustomizationRequest =
  | { readonly op: 'customization-status' }
  | CustomizationMutation
  | { readonly op: 'customization-worker-pull'; readonly workerId: string; readonly waitSeconds: number }
  | { readonly op: 'customization-worker-push'; readonly workerId: string; readonly status: CustomizationWorkerStatus; readonly results: readonly CustomizationResult[];
    readonly delivery?: CustomizationDelivery };
export const CUSTOMIZATION_MUTATION_OPS = ['customization-connect', 'customization-disconnect', 'customization-sync', 'customization-toggle',
  'customization-settings', 'customization-rebuild', 'customization-apply'] as const satisfies readonly CustomizationMutationOp[];
export const CUSTOMIZATION_WORKER_OPS = ['customization-worker-pull', 'customization-worker-push'] as const;
export const CUSTOMIZATION_OPS = ['customization-status', ...CUSTOMIZATION_MUTATION_OPS, ...CUSTOMIZATION_WORKER_OPS] as const;
/** A queued request as the worker receives it: the client mutation without its `customization-` prefix. */
export type CustomizationWorkerRequest = CustomizationMutation extends infer M ? M extends { readonly op: `customization-${infer Op}` }
  ? Omit<M, 'op'> & { readonly op: Op } : never : never;

const bytes = utf8Bytes;
function text(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value) || bytes(value) > max || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error('Invalid customization text');
  return value;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export function customizationRequestId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error('Invalid request ID');
  return value;
}
export function commitHead(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) throw new Error('Invalid commit');
  return value;
}
const digest = (value: unknown): string => { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new Error('Invalid digest'); return value; };
const TOKEN_NAME = /^AGENTUI_EXTENSION_[A-Za-z0-9_]+$/u;
function names(value: unknown, pattern = TOKEN_NAME): readonly string[] {
  if (!Array.isArray(value) || value.length > CUSTOMIZATION_BOUNDS.tokens) throw new Error('Invalid names');
  return value.map(item => { const name = text(item, 256); if (!pattern.test(name)) throw new Error('Invalid name'); return name; });
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error('Invalid value');
  return value as T;
}
function time(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid time');
  return value;
}
const NAMESPACE = /^[a-z][a-z0-9-]{0,31}$/u;
export function parseCustomizationConnection(value: unknown): CustomizationConnection {
  const input = record(value, ['location', 'branch', 'subdirectory']);
  return { location: text(input.location, CUSTOMIZATION_BOUNDS.location), branch: text(input.branch, CUSTOMIZATION_BOUNDS.branch),
    subdirectory: text(input.subdirectory, CUSTOMIZATION_BOUNDS.subdirectory, true) };
}
function extensionReference(value: unknown): CustomizationExtensionReference {
  const input = record(value, ['key', 'enabled', 'namespace']);
  if (typeof input.enabled !== 'boolean') throw new Error('Invalid enabled flag');
  return { key: text(input.key, CUSTOMIZATION_BOUNDS.key), enabled: input.enabled,
    namespace: input.namespace === null ? null : text(input.namespace, 32).match(NAMESPACE)?.[0] ?? (() => { throw new Error('Invalid namespace'); })() };
}
function extensionReferences(value: unknown): readonly CustomizationExtensionReference[] {
  if (!Array.isArray(value) || value.length > CUSTOMIZATION_BOUNDS.extensions) throw new Error('Invalid extensions');
  const list = value.map(extensionReference);
  if (new Set(list.map(item => item.key)).size !== list.length) throw new Error('Duplicate extension key');
  return list;
}
export function parseCustomizationBuildStatus(value: unknown): CustomizationBuildStatus {
  const input = record(value);
  const keys = ['buildKey', 'inputsKey', 'commit', 'state', 'startedAt', 'namespaces', 'ignoredGrants', 'hostArtifactId', 'grantVariables',
    ...(input.failure === undefined ? [] : ['failure']), ...(input.finishedAt === undefined ? [] : ['finishedAt'])];
  record(value, keys);
  const state = oneOf(input.state, CUSTOMIZATION_BUILD_STATES);
  const failure = input.failure === undefined ? undefined : oneOf(input.failure, CUSTOMIZATION_BUILD_FAILURES);
  if ((state === 'failed') !== (failure !== undefined)) throw new Error('Build failure must match its state');
  return { buildKey: digest(input.buildKey), inputsKey: digest(input.inputsKey), commit: commitHead(input.commit), state,
    ...(failure === undefined ? {} : { failure }), startedAt: time(input.startedAt),
    ...(input.finishedAt === undefined ? {} : { finishedAt: time(input.finishedAt) }),
    namespaces: names(input.namespaces, NAMESPACE), ignoredGrants: names(input.ignoredGrants, /^.+$/u),
    hostArtifactId: digest(input.hostArtifactId), grantVariables: names(input.grantVariables) };
}
function result(value: unknown): CustomizationResult {
  const input = record(value, ['requestId', 'outcome']);
  return { requestId: customizationRequestId(input.requestId),
    outcome: input.outcome === 'ok' ? 'ok' : oneOf(input.outcome, CUSTOMIZATION_WORKER_FAILURES) };
}
function results(value: unknown): readonly CustomizationResult[] {
  if (!Array.isArray(value) || value.length > CUSTOMIZATION_BOUNDS.results) throw new Error('Invalid results');
  return value.map(result);
}
export function parseCustomizationWorkerStatus(value: unknown): CustomizationWorkerStatus {
  if (bytes(JSON.stringify(value) ?? '') > CUSTOMIZATION_BOUNDS.workerStatus) throw new Error('Worker status too large');
  const input = record(value, ['connection', 'head', 'extensions', 'settings', 'build', 'presentTokens']);
  return { connection: input.connection === null ? null : parseCustomizationConnection(input.connection),
    head: input.head === null ? null : commitHead(input.head), extensions: extensionReferences(input.extensions),
    settings: input.settings === null ? null : parseCustomizationSettings(input.settings),
    build: input.build === null ? null : parseCustomizationBuildStatus(input.build), presentTokens: names(input.presentTokens) };
}
export function parseCustomizationStatus(value: unknown): CustomizationStatus {
  const input = record(value, ['support', 'connection', 'head', 'extensions', 'settings', 'build', 'running', 'pending', 'results', 'missingTokens']);
  const running = record(input.running, ['buildKey', 'omittedGrants', 'stale']);
  if (typeof running.stale !== 'boolean') throw new Error('Invalid running state');
  const pending = input.pending === null ? null : record(input.pending, ['requestId', 'op']);
  return { support: oneOf(input.support, ['supported', 'worker-offline'] as const),
    connection: input.connection === null ? null : parseCustomizationConnection(input.connection),
    head: input.head === null ? null : commitHead(input.head), extensions: extensionReferences(input.extensions),
    settings: input.settings === null ? null : parseCustomizationSettings(input.settings),
    build: input.build === null ? null : parseCustomizationBuildStatus(input.build),
    running: { buildKey: running.buildKey === null ? null : digest(running.buildKey), omittedGrants: names(running.omittedGrants), stale: running.stale },
    pending: pending === null ? null : { requestId: customizationRequestId(pending.requestId), op: oneOf(pending.op, CUSTOMIZATION_MUTATION_OPS) },
    results: results(input.results), missingTokens: names(input.missingTokens) };
}
export function parseCustomizationReply(value: unknown): CustomizationReply {
  const input = record(value);
  if (input.kind === 'accepted') { record(value, ['kind']); return { kind: 'accepted' }; }
  record(value, ['kind', 'cause']);
  if (input.kind !== 'refused') throw new Error('Invalid customization reply');
  return { kind: 'refused', cause: oneOf(input.cause, CUSTOMIZATION_REFUSALS) };
}
function settingsValue(value: unknown): CustomizationSettings {
  const settings = parseCustomizationSettings(value);
  serializeCustomizationSettings(settings);
  return settings;
}
/** Parses one of the ten customization operations. `input.op` must already be one of `CUSTOMIZATION_OPS`. */
export function parseCustomizationRequest(input: Record<string, unknown>): CustomizationRequest {
  switch (input.op) {
    case 'customization-status': record(input, ['op']); return { op: 'customization-status' };
    case 'customization-connect': {
      record(input, ['op', 'requestId', 'location', 'branch', 'subdirectory']);
      return { op: input.op, requestId: customizationRequestId(input.requestId), ...parseCustomizationConnection({ location: input.location, branch: input.branch, subdirectory: input.subdirectory }) };
    }
    case 'customization-disconnect': case 'customization-sync': case 'customization-rebuild':
      record(input, ['op', 'requestId']); return { op: input.op, requestId: customizationRequestId(input.requestId) };
    case 'customization-toggle': {
      record(input, ['op', 'requestId', 'key', 'enabled', 'expectedHead']);
      if (typeof input.enabled !== 'boolean') throw new Error('Invalid enabled flag');
      return { op: input.op, requestId: customizationRequestId(input.requestId), key: text(input.key, CUSTOMIZATION_BOUNDS.key), enabled: input.enabled, expectedHead: commitHead(input.expectedHead) };
    }
    case 'customization-settings':
      record(input, ['op', 'requestId', 'settings', 'expectedHead']);
      return { op: input.op, requestId: customizationRequestId(input.requestId), settings: settingsValue(input.settings), expectedHead: commitHead(input.expectedHead) };
    case 'customization-apply':
      record(input, ['op', 'requestId', 'buildKey']);
      return { op: input.op, requestId: customizationRequestId(input.requestId), buildKey: digest(input.buildKey) };
    case 'customization-worker-pull': {
      record(input, ['op', 'workerId', 'waitSeconds']);
      const waitSeconds = input.waitSeconds;
      if (typeof waitSeconds !== 'number' || !Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > CUSTOMIZATION_BOUNDS.waitSeconds) throw new Error('Invalid wait');
      return { op: input.op, workerId: customizationRequestId(input.workerId), waitSeconds };
    }
    case 'customization-worker-push':
      record(input, ['op', 'workerId', 'status', 'results', ...(input.delivery === undefined ? [] : ['delivery'])]);
      return { op: input.op, workerId: customizationRequestId(input.workerId), status: parseCustomizationWorkerStatus(input.status), results: results(input.results),
        ...(input.delivery === undefined ? {} : { delivery: parseCustomizationDelivery(input.delivery) }) };
    default: throw new Error('Unknown customization operation');
  }
}
function absolutePath(value: unknown): string {
  const path = text(value, CUSTOMIZATION_BOUNDS.path);
  if (!path.startsWith('/') || path.split('/').includes('..')) throw new Error('Invalid delivered path');
  return path;
}
export function parseCustomizationDelivery(value: unknown): CustomizationDelivery {
  const input = record(value, ['requestId', 'buildKey', 'assets', 'server', 'grants']);
  if (!Array.isArray(input.grants) || input.grants.length > CUSTOMIZATION_BOUNDS.grants) throw new Error('Invalid delivered grants');
  const server = input.server === null ? null : record(input.server, ['directory', 'artifactId']);
  return { requestId: customizationRequestId(input.requestId), buildKey: digest(input.buildKey), assets: input.assets === null ? null : absolutePath(input.assets),
    server: server === null ? null : { directory: absolutePath(server.directory), artifactId: digest(server.artifactId) }, grants: input.grants.map(grant => record(grant)) };
}
export function parseCustomizationLaunchKeys(value: unknown): CustomizationLaunchKeys {
  const input = record(value, ['current', 'next']);
  return { current: input.current === null ? null : digest(input.current), next: input.next === null ? null : digest(input.next) };
}
/** The worker's view of a queued mutation. */
export function customizationWorkerRequest(mutation: CustomizationMutation): CustomizationWorkerRequest {
  const { op, ...rest } = mutation;
  return { ...rest, op: op.slice('customization-'.length) } as CustomizationWorkerRequest;
}
export function parseCustomizationWorkerRequests(value: unknown): readonly CustomizationWorkerRequest[] {
  const input = record(value, ['requests']);
  if (!Array.isArray(input.requests) || input.requests.length > 1) throw new Error('Invalid worker requests');
  return input.requests.map(item => {
    const request = record(item);
    const op = `customization-${String(request.op)}`;
    if (!CUSTOMIZATION_MUTATION_OPS.includes(op as CustomizationMutationOp)) throw new Error('Invalid worker request');
    return customizationWorkerRequest(parseCustomizationRequest({ ...request, op }) as CustomizationMutation);
  });
}
