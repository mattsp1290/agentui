import { createProviderRegistry } from '../providers.js';
import type { DiscoveredProvider, ProviderCreationOperations, ProviderExtension } from '../providers.js';

export { loadServerExtension } from './loader.js';
export type { InstalledServerEntry, LoadedServerEntry } from './loader.js';

export type ServerExtensionFailure =
  | { readonly kind: 'failed'; readonly failure: 'load' | 'authorization' | 'activation' | 'discovery'; readonly recovery: 'replace' }
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
  pending: number;
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
    const generation: Generation = { id: ++nextGeneration, registry: createProviderRegistry(prepared.extensions), pending: 0 };
    change.generation = generation;
    let failure: 'activation' | 'discovery' = 'activation';
    try {
      if (state === change) await generation.registry.activate();
      if (state === change) {
        failure = 'discovery';
        await generation.registry.discover();
      }
      if (state === change) {
        state = { kind: 'active', generation };
        return { kind: 'replaced', generation: generation.id };
      }
    } catch {
      const cleanup = await retire(change);
      if (!cleanup && state !== change) return { kind: 'unavailable' };
      return fail(change, cleanup ?? { kind: 'failed', failure, recovery: 'replace' });
    }
    const cleanup = await retire(change);
    return cleanup ? fail(change, cleanup) : { kind: 'unavailable' };
  }
  function replace(source: ServerExtensionSource): Promise<ServerExtensionReplacement> {
    if (state.kind === 'failed' && state.recovery === 'restart') return Promise.resolve({ ...state });
    if (state.kind === 'closing' || state.kind === 'closed' || closing) return Promise.resolve({ kind: 'unavailable' });
    if (state.kind === 'changing') return Promise.resolve({ kind: 'deferred', reason: 'changing' });
    if (state.kind === 'active' && state.generation.pending) return Promise.resolve({ kind: 'deferred', reason: 'active-work' });
    const change: Changing = { kind: 'changing', generation: state.kind === 'active' ? state.generation : null,
      settled: Promise.resolve().then(() => replaceGeneration(change, source)) };
    state = change;
    return change.settled.then(result => ({ ...result }));
  }
  function discover(): Promise<readonly DiscoveredProvider[]> {
    if (state.kind === 'empty') return Promise.resolve([]);
    if (state.kind !== 'active') return Promise.reject(new Error('Provider discovery unavailable'));
    const generation = state.generation;
    generation.pending++;
    return generation.registry.discover().catch(() => {
      if (state.kind === 'active' && state.generation === generation) {
        const change: Changing = { kind: 'changing', generation, settled: Promise.resolve().then(async () => {
          const cleanup = await retire(change);
          return fail(change, cleanup ?? { kind: 'failed', failure: 'discovery', recovery: 'replace' });
        }) };
        state = change;
      }
      throw new Error('Provider discovery failed');
    }).finally(() => { generation.pending--; });
  }
  function catalog(): readonly DiscoveredProvider[] {
    return state.kind === 'active' ? state.generation.registry.catalog() : [];
  }
  function capture(...args: Parameters<ProviderCreationOperations['capture']>): ReturnType<ProviderCreationOperations['capture']> {
    if (state.kind !== 'active') throw new Error('Provider unavailable');
    return state.generation.registry.capture(...args);
  }
  async function execute(...args: Parameters<ProviderCreationOperations['execute']>): ReturnType<ProviderCreationOperations['execute']> {
    if (state.kind !== 'active') return { kind: args[1] ? 'not-dispatched' : 'uncertain', source: args[1] ? 'create' : 'lookup', evidence: null };
    const generation = state.generation;
    generation.pending++;
    try { return await generation.registry.execute(...args); }
    finally { generation.pending--; }
  }
  function close(): Promise<void> {
    if (closing) return closing;
    const previous = state;
    state = { kind: 'closing' };
    const retirement = Promise.allSettled(previous.kind === 'active' || previous.kind === 'changing'
      ? [previous.generation?.registry.close()] : []);
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
    return closing;
  }
  function status(): ServerExtensionStatus {
    switch (state.kind) {
      case 'active': return { kind: 'active', generation: state.generation.id, pending: state.generation.pending };
      case 'changing': return { kind: 'changing', generation: state.generation?.id ?? null };
      default: return { ...state };
    }
  }
  return { replace, discover, catalog, capture, execute, status, close };
}
