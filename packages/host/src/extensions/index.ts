import { createProviderRegistry } from '../providers.js';
import type { ProviderStatus, ProviderConversationOperations, ProviderCreationOperations, ProviderExtension } from '../providers.js';

export { loadServerArtifact } from './server-artifact.js';
export { loadServerExtension } from './loader.js';
export type { InstalledServerEntry, LoadedServerEntry } from './loader.js';

export type ServerExtensionFailure =
  | { readonly kind: 'failed'; readonly failure: 'load' | 'authorization' | 'activation'; readonly recovery: 'replace' }
  | { readonly kind: 'failed'; readonly failure: 'cleanup'; readonly recovery: 'restart' };
export type ServerExtensionPreparation =
  | { readonly kind: 'ready'; readonly extensions: readonly ProviderExtension[] }
  | ServerExtensionFailure;
export interface ServerExtensionSource {
  prepare(): Promise<ServerExtensionPreparation>;
}
export type ServerExtensionStatus =
  | { readonly kind: 'empty' | 'closing' | 'closed' }
  | { readonly kind: 'active'; readonly generation: number; readonly pending: number }
  | { readonly kind: 'changing'; readonly generation: number | null }
  | ServerExtensionFailure;
export type ServerExtensionReplacement =
  | { readonly kind: 'replaced'; readonly generation: number | null }
  | { readonly kind: 'deferred'; readonly reason: 'active-work' | 'changing' }
  | { readonly kind: 'unavailable' }
  | ServerExtensionFailure;
interface Generation {
  readonly id: number;
  readonly registry: ReturnType<typeof createProviderRegistry>;
}
interface Changing {
  readonly kind: 'changing';
  generation: Generation | null;
  readonly settled: Promise<ServerExtensionReplacement>;
}
type State =
  | { readonly kind: 'empty' | 'closing' | 'closed' }
  | { readonly kind: 'active'; readonly generation: Generation }
  | Changing
  | ServerExtensionFailure;
const cleanupFailure: ServerExtensionFailure = { kind: 'failed', failure: 'cleanup', recovery: 'restart' };

export function createServerExtensions() {
  const inactive = createProviderRegistry([]);
  let state: State = { kind: 'empty' };
  let nextGeneration = 0;
  let closing: Promise<void> | undefined;
  function fail(change: Changing, failure: ServerExtensionFailure): ServerExtensionFailure {
    if (state === change) state = { ...failure };
    return { ...failure };
  }
  async function retire(change: Changing): Promise<ServerExtensionFailure | null> {
    try {
      await change.generation?.registry.close();
      change.generation = null;
      return null;
    } catch { return cleanupFailure; }
  }
  async function replaceGeneration(change: Changing, source: ServerExtensionSource): Promise<ServerExtensionReplacement> {
    const retired = await retire(change);
    if (retired) return fail(change, retired);
    if (state !== change) return { kind: 'unavailable' };
    let prepared: ServerExtensionPreparation;
    try { prepared = await source.prepare(); }
    catch { return fail(change, { kind: 'failed', failure: 'load', recovery: 'replace' }); }
    if (prepared.kind === 'failed') return fail(change, prepared);
    if (!prepared.extensions.length) {
      if (state !== change) return { kind: 'unavailable' };
      state = { kind: 'empty' };
      return { kind: 'replaced', generation: null };
    }
    const generation: Generation = { id: ++nextGeneration, registry: createProviderRegistry(prepared.extensions) };
    change.generation = generation;
    try {
      if (state === change) await generation.registry.activate();
      if (state === change) await generation.registry.discover();
      if (state === change) {
        state = { kind: 'active', generation };
        return { kind: 'replaced', generation: generation.id };
      }
    } catch {
      const cleanup = await retire(change);
      if (!cleanup && state !== change) return { kind: 'unavailable' };
      return fail(change, cleanup ?? { kind: 'failed', failure: 'activation', recovery: 'replace' });
    }
    const cleanup = await retire(change);
    return cleanup ? fail(change, cleanup) : { kind: 'unavailable' };
  }
  function replace(source: ServerExtensionSource): Promise<ServerExtensionReplacement> {
    if (state.kind === 'failed' && state.recovery === 'restart') return Promise.resolve({ ...state });
    if (state.kind === 'closing' || state.kind === 'closed' || closing) return Promise.resolve({ kind: 'unavailable' });
    if (state.kind === 'changing') return Promise.resolve({ kind: 'deferred', reason: 'changing' });
    if (state.kind === 'active') {
      const activity = state.generation.registry.activity();
      if (activity.phase === 'closing') return Promise.resolve({ kind: 'deferred', reason: 'changing' });
      if (activity.pending) return Promise.resolve({ kind: 'deferred', reason: 'active-work' });
    }
    const change: Changing = { kind: 'changing', generation: state.kind === 'active' ? state.generation : null,
      settled: Promise.resolve().then(() => replaceGeneration(change, source)) };
    state = change;
    return change.settled.then(result => ({ ...result }));
  }
  function discover(): Promise<readonly ProviderStatus[]> {
    if (state.kind === 'empty') return Promise.resolve([]);
    if (state.kind !== 'active') return Promise.reject(new Error('Provider discovery unavailable'));
    return state.generation.registry.discover();
  }
  function catalog(): readonly ProviderStatus[] {
    return current().catalog();
  }
  const statusOf: ReturnType<typeof createProviderRegistry>['statusOf'] = selected => current().statusOf(selected);
  function current() { return state.kind === 'active' ? state.generation.registry : inactive; }
  const capture: ProviderCreationOperations['capture'] = (...args) => current().capture(...args);
  const execute: ProviderCreationOperations['execute'] = (...args) => current().execute(...args);
  const assertFrontendInput: ProviderConversationOperations['assertFrontendInput'] = target => {
    const registry = current();
    registry.assertFrontendInput(target);
    if (current() !== registry) throw new Error('Original AG-UI provider unavailable');
  };
  const captureCommand: ProviderConversationOperations['captureCommand'] = (...args) => current().captureCommand(...args);
  const executeCommand: ProviderConversationOperations['executeCommand'] = (...args) => current().executeCommand(...args);
  const conversationOutputs: ProviderConversationOperations['conversationOutputs'] = (...args) => current().conversationOutputs(...args);
  const readOutput: ProviderConversationOperations['readOutput'] = (...args) => current().readOutput(...args);
  const readPermissions: ProviderConversationOperations['readPermissions'] = (...args) => current().readPermissions(...args);
  const observe: ProviderConversationOperations['observe'] = (...args) => current().observe(...args);
  const closure: NonNullable<ProviderConversationOperations['closure']> = (...args) => current().closure(...args);
  const continuation: NonNullable<ProviderConversationOperations['continuation']> = (...args) => current().continuation(...args);
  function close(): Promise<void> {
    if (closing) return closing;
    const previous = state;
    state = { kind: 'closing' };
    // Cleanup can reenter close(), so publish first. The microtask reads retirement after initialization.
    closing = Promise.resolve().then(async () => {
      if (previous.kind === 'changing') {
        const result = await previous.settled;
        if (result.kind === 'failed' && result.recovery === 'restart') throw new Error('Provider cleanup failed');
      }
      if ((await retirement).some(result => result.status === 'rejected')) throw new Error('Provider cleanup failed');
      if (previous.kind === 'failed' && previous.recovery === 'restart') throw new Error('Provider cleanup failed');
      state = { kind: 'closed' };
    }).catch(() => {
      state = cleanupFailure;
      throw new Error('Provider cleanup failed');
    });
    const retirement = Promise.allSettled(previous.kind === 'active' || previous.kind === 'changing'
      ? [previous.generation?.registry.close()] : []);
    return closing;
  }
  function status(): ServerExtensionStatus {
    switch (state.kind) {
      case 'active': {
        const activity = state.generation.registry.activity();
        return activity.phase === 'closing' ? { kind: 'changing', generation: state.generation.id }
          : { kind: 'active', generation: state.generation.id, pending: activity.pending };
      }
      case 'changing': return { kind: 'changing', generation: state.generation?.id ?? null };
      default: return { ...state };
    }
  }
  return { replace, discover, catalog, statusOf, capture, execute, captureCommand, executeCommand, assertFrontendInput, conversationOutputs, readOutput, readPermissions, observe, closure, continuation, status, close };
}
