import { useEffect, useRef, useState } from 'react';
import { checkCompatibility, createConversationStore } from '@agentui/client';
import type { CompatibilityResult, ConversationStore } from '@agentui/client';
import { createBrowserConnection, ServiceError } from '@agentui/client/service';
import type { ConversationScope } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import type { Transcript } from '@agentui/contracts/conversation';
import { BrowserViewStorage } from './browser-storage.js';
import type { SavedView } from './browser-storage.js';

type Metadata = Awaited<ReturnType<ReturnType<typeof createBrowserConnection>['metadata']>>;
type HostState =
  | { readonly kind: 'loading' | 'unpaired' | 'unavailable' }
  | { readonly kind: 'ready'; readonly metadata: Metadata; readonly compatibility: CompatibilityResult };
export interface OpenConversation {
  readonly scope: ConversationScope;
  readonly store: ConversationStore<Transcript>;
}
const initialView: SavedView = { version: 1, route: null, pendingCreation: null };
function message(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed.'; }

export function useApplication() {
  const [host, setHost] = useState<HostState>({ kind: 'loading' });
  const [catalog, setCatalog] = useState<readonly ConversationScope[]>([]);
  const [saved, setSaved] = useState<SavedView>(initialView);
  const [savedViews, setSavedViews] = useState<readonly string[]>([]);
  const [active, setActive] = useState<OpenConversation | null>(null);
  const [error, setError] = useState('');
  const [storageFailure, setStorageFailure] = useState('');
  const [busy, setBusy] = useState(false);
  const storage = useRef<BrowserViewStorage | null>(null);
  const current = useRef<OpenConversation | null>(null);
  const working = useRef(false);
  const alive = useRef(true);
  const [connection] = useState(() => createBrowserConnection({ onUnauthorized: () => {
    current.current?.store.disconnect();
    if (alive.current) { setHost({ kind: 'unpaired' }); setError('Pair this browser to the host. Its previous access may have been revoked.'); }
  } }));

  function failStorage(cause: unknown): void {
    setStorageFailure(message(cause));
    current.current?.store.disconnect();
  }
  function local(): BrowserViewStorage {
    if (!storage.current || storageFailure) throw new Error(storageFailure || 'Local storage is not ready.');
    return storage.current;
  }
  async function save(hostId: string, next: SavedView): Promise<void> {
    try { await local().saveView(hostId, next); setSaved(next); }
    catch (cause) { failStorage(cause); throw cause; }
  }
  async function install(scope: ConversationScope): Promise<void> {
    if (current.current?.scope.hostId === scope.hostId && current.current.scope.conversationId === scope.conversationId) {
      await current.current.store.connect();
      return;
    }
    current.current?.store.disconnect();
    const store = createConversationStore({ scope, port: connection.conversation(scope), projection: transcriptProjection,
      drafts: local().drafts(failStorage), createCommandId: () => crypto.randomUUID() });
    try { await store.ready; } catch (cause) { failStorage(cause); throw cause; }
    if (!alive.current) { store.disconnect(); return; }
    current.current = { scope, store };
    setActive(current.current);
    await store.connect();
  }
  async function readCatalog(hostId: string): Promise<void> {
    const all: ConversationScope[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await connection.catalog(after, 100);
      if (page.some(scope => scope.hostId !== hostId)) throw new Error('Catalog belongs to another host.');
      all.push(...page);
      if (page.length < 100) break;
      const next = page.at(-1)?.conversationId;
      if (!next || next === after) throw new Error('Catalog did not advance.');
      after = next;
    }
    setCatalog(all);
  }
  async function refresh(): Promise<void> {
    const metadata = await connection.metadata();
    const compatibility = checkCompatibility({ supportedWireVersions: [1], supportedExtensionSdkVersions: ['0.0.0'],
      supportedNativeRuntimes: [{ engine: 'agentui-recorded', version: 'recorded-v1', format: 'agentui-recorded-v1' }],
      expectedArtifactId: null }, metadata.compatibility);
    setHost({ kind: 'ready', metadata, compatibility });
    if (compatibility.kind !== 'compatible') { current.current?.store.disconnect(); return; }
    let view: SavedView;
    try { view = await local().readView(metadata.hostId); } catch (cause) { failStorage(cause); throw cause; }
    setSaved(view);
    const viewIds: string[] = [];
    let after: string | null = null;
    do {
      const page = await local().savedViews(metadata.hostId, after);
      viewIds.push(...page.ids);
      after = page.after;
    } while (after !== null);
    setSavedViews(viewIds);
    await readCatalog(metadata.hostId);
    if (view.route) await install(view.route);
  }
  async function run(operation: () => Promise<unknown>): Promise<void> {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try { await operation(); }
    catch (cause) {
      if (cause instanceof ServiceError && cause.kind === 'unauthorized') setHost({ kind: 'unpaired' });
      setError(message(cause));
    } finally { working.current = false; setBusy(false); }
  }
  useEffect(() => {
    alive.current = true;
    void run(async () => {
      try { storage.current = await BrowserViewStorage.open(); }
      catch (cause) { failStorage(cause); return; }
      if (!alive.current) { storage.current.close(); return; }
      try { await refresh(); }
      catch (cause) {
        if (!(cause instanceof ServiceError && cause.kind === 'unauthorized')) setHost({ kind: 'unavailable' });
        throw cause;
      }
    });
    const close = () => { current.current?.store.disconnect(); storage.current?.close(); };
    const resume = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pagehide', close);
    window.addEventListener('pageshow', resume);
    return () => { alive.current = false; close(); window.removeEventListener('pagehide', close); window.removeEventListener('pageshow', resume); };
  }, []);

  function requireHost(): Metadata {
    if (host.kind !== 'ready' || host.compatibility.kind !== 'compatible') throw new Error('A compatible paired host is required.');
    local();
    return host.metadata;
  }
  async function completeCreation(scope: ConversationScope): Promise<void> {
    await connection.create(scope);
    await save(scope.hostId, { version: 1, route: scope, pendingCreation: null });
    await install(scope);
    await readCatalog(scope.hostId);
  }
  return {
    host, catalog, saved, savedViews, active, error, storageFailure, busy,
    enabled: host.kind === 'ready' && host.compatibility.kind === 'compatible' && !storageFailure && !busy,
    pair: (code: string) => run(async () => { local(); await connection.pair(code); await refresh(); }),
    reconnect: () => run(refresh),
    reopenView: (viewId: string) => run(async () => {
      requireHost();
      const next = await BrowserViewStorage.reopen(viewId);
      current.current?.store.disconnect();
      current.current = null;
      setActive(null);
      storage.current?.close();
      storage.current = next;
      await refresh();
    }),
    create: () => run(async () => {
      const metadata = requireHost();
      if (saved.pendingCreation) throw new Error('Recover the pending creation before creating another conversation.');
      const scope = { hostId: metadata.hostId, conversationId: crypto.randomUUID() };
      await save(metadata.hostId, { ...saved, pendingCreation: scope });
      await completeCreation(scope);
    }),
    recoverCreation: () => run(async () => { requireHost(); if (saved.pendingCreation) await completeCreation(saved.pendingCreation); }),
    open: (scope: ConversationScope) => run(async () => {
      const metadata = requireHost();
      if (scope.hostId !== metadata.hostId) throw new Error('Conversation belongs to another host.');
      await save(scope.hostId, { ...saved, route: scope });
      await install(scope);
    }),
    command: (operation: () => Promise<unknown>) => run(async () => {
      requireHost();
      const result = await operation();
      if (result && typeof result === 'object' && 'kind' in result && result.kind === 'rejected' && 'reason' in result) throw new Error(String(result.reason));
    }),
    reconcile: (scope: ConversationScope, id: string) => run(async () => {
      requireHost();
      const target = current.current;
      if (!target || target.scope.hostId !== scope.hostId || target.scope.conversationId !== scope.conversationId) throw new Error('Open the command’s conversation before reconciling.');
      await connection.reconcile(scope, id);
      await target.store.refreshReceipt(id);
    }),
    draftFailure: failStorage,
  };
}
export type Application = ReturnType<typeof useApplication>;
