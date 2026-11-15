import { EXTENSION_SDK_VERSION } from '@agentui/contracts/compatibility';
import { nonempty, record } from '@agentui/contracts/decode';
import type { BackendProvider, ProviderModel } from './providers.js';

export { EXTENSION_SDK_VERSION };
export type ExtensionEntryKind = 'server' | 'desktop' | 'ios';
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
export interface ProviderContributions {
  add<M extends ProviderModel, I extends string>(id: string, provider: BackendProvider<M, I>): void;
}
export interface ServerExtensionContext {
  readonly namespace: string;
  readonly providers: ProviderContributions;
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
function text(value: unknown): string {
  const result = nonempty(value);
  if (!result.trim()) throw new Error('Expected nonblank string');
  return result;
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
  return { namespace: text(input.namespace), trust: 'full', sdkVersion: text(input.sdkVersion), entries: [first, ...entries] };
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
  try { entry = record(defaultExport); } catch {
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
  if (typeof record(value).dispose !== 'function') throw new Error('Expected extension disposal');
}
