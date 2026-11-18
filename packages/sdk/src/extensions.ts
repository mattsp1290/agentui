import type { AguiObservations } from './agui-observations.js';
import type { RunAgentInput } from '@agentui/protocol';
import { EXTENSION_SDK_VERSION } from '@agentui/contracts/compatibility';
import { nonempty, record } from '@agentui/contracts/decode';
import type { Json } from '@agentui/contracts';
import type { BackendProvider, CredentialHandle, ProviderInstance, ProviderModel } from './providers.js';
import type { ProviderPresentation, ServerProviderCredentials } from './provider-presentation.js';

export { EXTENSION_SDK_VERSION };
export type ExtensionEntryKind = 'server' | 'desktop' | 'ios';
export type FrontendPlatform = Exclude<ExtensionEntryKind, 'server'>;
export interface ExtensionEntry {
  readonly kind: ExtensionEntryKind;
  readonly module: string;
}

/** Installed code runs with its server or client process privileges. There is no sandbox. */
export interface ExtensionManifest {
  readonly namespace: string;
  readonly trust: 'full';
  readonly sdkVersion: string;
  readonly entries: readonly [ExtensionEntry, ...ExtensionEntry[]];
}

export interface ExtensionLifetime {
  dispose(): void | Promise<void>;
}
export type AguiModel = ProviderModel & { readonly request: RunAgentInput };
export interface ProviderContributions {
  /** The backend sends this exact AG-UI input and confirms its preallocated runId. */
  addAgui<M extends AguiModel, I extends string>(id: string, provider: BackendProvider<M, I>, presentation: ProviderPresentation<M, I>, observations?: AguiObservations<M, I>): void;
  add<M extends ProviderModel, I extends string>(id: string, provider: BackendProvider<M, I>, presentation: ProviderPresentation<M, I>): void;
}
/** One configured installation of this namespace. It holds no secret. `id` is the grant id from the host configuration. */
export interface ServerExtensionInstallation {
  readonly id: string;
  readonly instance: ProviderInstance<string>;
  readonly service: string;
  readonly expectedAuthority: 'agentui-host' | 'remote-provider';
}
export const EXTENSION_OPERATION_PATTERN = /^[a-z][a-z0-9.-]{0,63}$/u;
export const EXTENSION_REFUSAL_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
/** The runtime `AbortSignal`, read from the consumer's global types so the SDK root needs no DOM or Node types. */
export type ExtensionAbortSignal = typeof globalThis extends { readonly AbortSignal: { readonly prototype: infer Signal } }
  ? Signal : { readonly aborted: boolean };
export interface ExtensionOperationCall {
  /** The installation the client named. */
  readonly installation: ServerExtensionInstallation;
  /** Issued by the host for that installation; `null` for an unauthenticated installation. */
  readonly credential: CredentialHandle<string> | null;
  /** A bounded copy of the client input. */
  readonly input: Json;
  /** Aborted at the host deadline. Pass it to every request the operation makes. */
  readonly signal: ExtensionAbortSignal;
}
export type ExtensionOperationResult =
  | { readonly kind: 'ok'; readonly output: Json; readonly agentsChanged?: true }
  | { readonly kind: 'refused'; readonly code: string };
export interface ExtensionOperation {
  run(call: ExtensionOperationCall): Promise<ExtensionOperationResult>;
}
export interface OperationContributions {
  /** `id` matches `EXTENSION_OPERATION_PATTERN`. Duplicate ids and registration after activation throw. */
  add(id: string, operation: ExtensionOperation): void;
}
export interface ServerExtensionContext {
  readonly namespace: string;
  /** The configured installations of this namespace. A provider contribution id must equal the grant id it serves. */
  readonly installations: readonly ServerExtensionInstallation[];
  readonly providers: ProviderContributions;
  readonly operations: OperationContributions;
  readonly credentials: ServerProviderCredentials;
}
export interface ServerExtensionEntry {
  readonly kind: 'server';
  readonly sdkVersion: typeof EXTENSION_SDK_VERSION;
  activate(context: ServerExtensionContext): ExtensionLifetime | Promise<ExtensionLifetime>;
}

export type ExtensionCompatibility =
  | { readonly kind: 'compatible' }
  | { readonly kind: 'incompatible'; readonly code: 'sdk-version' | 'entry-kind' | 'entry-export'; readonly reason: string };

function entryKind(value: unknown): ExtensionEntryKind {
  if (value !== 'server' && value !== 'desktop' && value !== 'ios') throw new Error('Invalid extension entry kind');
  return value;
}
export function frontendPlatform(value: unknown): FrontendPlatform {
  const kind = entryKind(value);
  if (kind === 'server') throw new Error('Invalid frontend platform');
  return kind;
}
function text(value: unknown): string {
  const result = nonempty(value);
  if (!result.trim()) throw new Error('Expected nonblank string');
  return result;
}
export function extensionNamespace(value: unknown): string {
  const namespace = nonempty(value);
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(namespace)) throw new Error('Invalid extension namespace');
  return namespace;
}
function parseEntry(value: unknown): ExtensionEntry {
  const input = record(value, ['kind', 'module']);
  const module = text(input.module);
  if (!module.startsWith('./') || /[\\:%?#\s]/u.test(module) ||
    module.slice(2).split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('Expected contained relative extension module path');
  }
  return { kind: entryKind(input.kind), module };
}

export function parseExtensionManifest(value: unknown): ExtensionManifest {
  const input = record(value, ['namespace', 'trust', 'sdkVersion', 'entries']);
  if (input.trust !== 'full') throw new Error('Extensions require full trust');
  if (!Array.isArray(input.entries) || input.entries.length === 0) throw new Error('Expected extension entries');
  const entries = input.entries.map(parseEntry);
  const first = entries.shift();
  if (!first) throw new Error('Expected extension entries');
  const kinds = [first, ...entries].map(entry => entry.kind);
  if (new Set(kinds).size !== kinds.length) throw new Error('Duplicate extension entry kind');
  return { namespace: extensionNamespace(input.namespace), trust: 'full', sdkVersion: text(input.sdkVersion), entries: [first, ...entries] };
}

/** Checks an already imported export. Importing full-trust code can itself execute code. */
export function checkExtensionEntrypoint(manifest: ExtensionManifest, expected: ExtensionEntryKind,
  defaultExport: unknown): ExtensionCompatibility {
  if (manifest.sdkVersion !== EXTENSION_SDK_VERSION) {
    return { kind: 'incompatible', code: 'sdk-version', reason: 'Unsupported manifest SDK version' };
  }
  if (!manifest.entries.some(entry => entry.kind === expected)) {
    return { kind: 'incompatible', code: 'entry-kind', reason: 'Target is not declared in manifest' };
  }
  let entry: Record<string, unknown>;
  try { entry = behaviour(defaultExport); } catch {
    return { kind: 'incompatible', code: 'entry-export', reason: 'Expected entry object' };
  }
  if (entry.kind !== expected) return { kind: 'incompatible', code: 'entry-kind', reason: 'Loaded entry has wrong kind' };
  if (entry.sdkVersion !== EXTENSION_SDK_VERSION) {
    return { kind: 'incompatible', code: 'sdk-version', reason: 'Unsupported loaded entry SDK version' };
  }
  if (typeof entry.activate !== 'function') {
    return { kind: 'incompatible', code: 'entry-export', reason: 'Expected callable activation' };
  }
  return { kind: 'compatible' };
}

export function validateExtensionLifetime(value: unknown): asserts value is ExtensionLifetime {
  if (typeof behaviour(value).dispose !== 'function') throw new Error('Expected extension disposal');
}

/** In-process values may use prototypes, accessors, or callable objects. */
export function behaviour(value: unknown): Record<string, unknown> {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null || Array.isArray(value)) {
    throw new Error('Expected behaviour object');
  }
  return value as Record<string, unknown>;
}
