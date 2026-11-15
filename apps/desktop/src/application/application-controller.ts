import { checkCompatibility, createConversationStore } from '@agentui/client';
import type { CompatibilityIssue, ConversationStore } from '@agentui/client';
import { ServiceError, SERVICE_CATALOG_PAGE } from '@agentui/contracts/service';
import { sameScope } from '@agentui/contracts';
import { SOLO_CLIENT_COMPATIBILITY } from '@agentui/contracts/compatibility';
import type { ConversationScope, SubmitResult } from '@agentui/contracts';
import { conversationPreview, transcriptProjection } from '@agentui/contracts/conversation';
import type { Transcript } from '@agentui/contracts/conversation';
import type { AgentDescriptor, ConversationCatalogEntry, ConversationSearchPage, ServiceConnection, ServiceMetadata } from '@agentui/contracts/service';
import type { ConversationCommands } from '@agentui/sdk/react';
import type { OwnedViewStorage, SavedView, ViewStorageFactory } from './view-state.js';
import { agentPresentation } from './agent-presentation.js';
import { conversationResponding } from './responding.js';

export interface Page<T> { readonly items: readonly T[]; readonly after: string | null }
type HostState =
  | { readonly kind: 'loading' | 'unpaired' | 'unavailable' }
  | { readonly kind: 'ready'; readonly metadata: ServiceMetadata }
  | { readonly kind: 'incompatible'; readonly metadata: ServiceMetadata; readonly issues: readonly CompatibilityIssue[] };
export interface OpenConversation {
  readonly agent: AgentDescriptor;
  readonly viewId: string;
  readonly scope: ConversationScope;
  readonly store: ConversationStore<Transcript>;
}
export interface ApplicationSnapshot {
  readonly host: HostState;
  readonly catalog: Page<ConversationCatalogEntry>;
  readonly saved: SavedView;
  readonly savedViews: Page<string>;
  readonly savedViewNotice: string;
  readonly active: OpenConversation | null;
  readonly error: string;
  readonly storageFailure: string;
  readonly busy: boolean;
}
export interface ConversationActions {
  readonly commands: ConversationCommands;
  submit(operation: () => Promise<SubmitResult>): Promise<void>;
  reconcile(id: string): Promise<void>;
}
export interface ApplicationController {
  getSnapshot(): ApplicationSnapshot;
  subscribe(listener: () => void): () => void;
  start(): Promise<void>;
  dispose(): Promise<void>;
  pair(code: string): Promise<void>;
  reconnect(): Promise<void>;
  reopenView(viewId: string): Promise<void>;
  moreConversations(): Promise<void>;
  search(query: string, after: string | null, signal: AbortSignal): Promise<ConversationSearchPage>;
  moreSavedViews(): Promise<void>;
  create(agentId?: string): Promise<void>;
  recoverCreation(agentId?: string): Promise<void>;
  open(scope: ConversationScope): Promise<void>;
  conversationActions(target: OpenConversation): ConversationActions;
}
interface LoadedView { readonly storage: OwnedViewStorage; readonly saved: SavedView; readonly hostId: string }
type OwnedView = { readonly storage: OwnedViewStorage; readonly saved: null } | LoadedView;
type ApplicationFailure =
  | { readonly kind: 'access-revoked' }
  | { readonly kind: 'operation-failed'; readonly error: string };
interface Session { view: OwnedView | null; readonly connection: ServiceConnection }
const EMPTY_SAVED_VIEW: SavedView = { version: 2, route: null, pendingCreation: null };
const DETACHED_VIEW = {
  active: null, catalog: { items: [], after: null }, savedViews: { items: [], after: null }, savedViewNotice: '',
} satisfies Pick<ApplicationSnapshot, 'active' | 'catalog' | 'savedViews' | 'savedViewNotice'>;
function compatibleAgent(agent: AgentDescriptor): AgentDescriptor {
  if ('kind' in agent) return agent;
  return SOLO_CLIENT_COMPATIBILITY.supportedNativeRuntimes.some(runtime => runtime.engine === agent.runtime.engine &&
    runtime.version === agent.runtime.version && runtime.format === agent.runtime.format) ? agent
    : { ...agent, availability: { kind: 'unavailable', reason: 'This agent runtime is unsupported by this app.' } };
}
function initialSnapshot(): ApplicationSnapshot {
  return { ...DETACHED_VIEW, host: { kind: 'loading' }, saved: EMPTY_SAVED_VIEW, error: '', storageFailure: '', busy: false };
}
function message(error: unknown): string { return error instanceof Error ? error.message : 'The operation failed.'; }
function classifyFailure(cause: unknown): ApplicationFailure {
  return cause instanceof ServiceError && cause.kind === 'unauthorized'
    ? { kind: 'access-revoked' } : { kind: 'operation-failed', error: message(cause) };
}
export function applicationEnabled(state: ApplicationSnapshot): boolean {
  return state.host.kind === 'ready' && !state.storageFailure && !state.busy;
}

export function createApplicationController(deps: {
  readonly createConnection: (options: { readonly onUnauthorized: () => void }) => ServiceConnection;
  readonly ownedViewStorage: ViewStorageFactory;
  readonly createId: () => string;
}): ApplicationController {
  let state = initialSnapshot();
  let session: Session | null = null;
  let disposal: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  let unsubscribeActive: (() => void) | null = null;
  function publish(update: Partial<Omit<ApplicationSnapshot, 'saved'>>): void {
    state = Object.freeze({ ...state, ...update, saved: session?.view?.saved ?? EMPTY_SAVED_VIEW });
    for (const listener of listeners) listener();
  }
  function disconnectActive(): void {
    unsubscribeActive?.();
    unsubscribeActive = null;
    state.active?.store.disconnect();
  }
  function fail(owner: Session, failure: ApplicationFailure, phase: 'handshake' | 'operation' = 'operation'): void {
    if (session !== owner) return;
    if (failure.kind === 'access-revoked') {
      state.active?.store.disconnect();
      publish({ host: { kind: 'unpaired' }, error: 'Pair this browser to the host. Its previous access may have been revoked.' });
    } else {
      if (phase === 'handshake') publish({ host: { kind: 'unavailable' }, error: failure.error });
      else publish({ error: failure.error });
    }
  }
  async function current<T>(owner: Session, operation: Promise<T>): Promise<T> {
    const result = await operation;
    if (session !== owner) throw new Error('This application has closed.');
    return result;
  }
  function failStorage(owner: Session, storage: OwnedViewStorage | null, cause: unknown): void {
    if (session !== owner || (owner.view?.storage ?? null) !== storage) return;
    publish({ storageFailure: message(cause) });
    state.active?.store.disconnect();
  }
  function local(owner: Session): OwnedViewStorage {
    if (session !== owner || !owner.view || state.storageFailure) throw new Error(state.storageFailure || 'Local storage is not ready.');
    return owner.view.storage;
  }
  function requireHost(owner: Session): ServiceMetadata {
    local(owner);
    if (state.host.kind !== 'ready') throw new Error('A compatible paired host is required.');
    return state.host.metadata;
  }
  function requireSaved(owner: Session): LoadedView {
    const host = requireHost(owner);
    const view = owner.view;
    if (!view || view.saved === null || view.hostId !== host.hostId) throw new Error('This view is still loading.');
    return view;
  }
  async function acquire(owner: Session, viewId: string | null): Promise<OwnedViewStorage> {
    let storage: OwnedViewStorage | null = null;
    const failed = (cause: unknown) => failStorage(owner, storage, cause);
    storage = await (viewId === null ? deps.ownedViewStorage.open(failed) : deps.ownedViewStorage.reopen(viewId, failed));
    if (session !== owner) { await storage.close(); throw new Error('This application has closed.'); }
    return storage;
  }
  async function save(owner: Session, next: SavedView): Promise<void> {
    const view = requireSaved(owner);
    try {
      await current(owner, view.storage.saveView(view.hostId, next));
      if (owner.view?.storage !== view.storage) throw new Error('The saved view changed.');
      owner.view = { ...view, saved: next };
      publish({});
    } catch (cause) { failStorage(owner, view.storage, cause); throw cause; }
  }
  async function install(owner: Session, scope: ConversationScope): Promise<void> {
    const storage = local(owner);
    const found = await current(owner, owner.connection.conversationAgent(scope));
    if (!found) throw new Error('Conversation does not exist.');
    const agent = compatibleAgent(found);
    if (state.active && sameScope(state.active.scope, scope)) {
      publish({ active: { ...state.active, agent } });
      await current(owner, state.active.store.connect()); return;
    }
    disconnectActive();
    const failed = (cause: unknown) => failStorage(owner, storage, cause);
    const store = createConversationStore({ scope, port: owner.connection.conversation(scope), projection: transcriptProjection,
      drafts: storage.drafts(failed), createCommandId: deps.createId });
    try { await current(owner, store.ready); local(owner); }
    catch (cause) { store.disconnect(); failed(cause); throw cause; }
    publish({ active: { scope, store, agent, viewId: storage.viewId } });
    unsubscribeActive = store.subscribe(() => {
      if (session !== owner || state.active?.store !== store) return;
      const snapshot = store.getSnapshot();
      if (snapshot.connection.kind !== 'connected') return;
      const preview = conversationPreview(snapshot.document.domain);
      const existing = state.catalog.items.find(entry => sameScope(entry.scope, scope));
      if (existing && existing.preview !== preview) publish({ catalog: { ...state.catalog,
        items: state.catalog.items.map(entry => entry === existing ? { scope: entry.scope, preview } : entry) } });
    });
    await current(owner, store.connect());
  }
  async function readCatalog(owner: Session, hostId: string, after: string | null = null): Promise<void> {
    const items = await current(owner, owner.connection.catalog(after, SERVICE_CATALOG_PAGE));
    if (items.some(entry => entry.scope.hostId !== hostId)) throw new Error('Catalog belongs to another host.');
    const next = items.length === SERVICE_CATALOG_PAGE ? items.at(-1)?.scope.conversationId ?? null : null;
    if (next !== null && next === after) throw new Error('Catalog did not advance.');
    const loaded = new Map((after === null ? [] : state.catalog.items).map(entry => [JSON.stringify([entry.scope.hostId, entry.scope.conversationId]), entry]));
    for (const entry of items) loaded.set(JSON.stringify([entry.scope.hostId, entry.scope.conversationId]), entry);
    publish({ catalog: { items: [...loaded.values()], after: next } });
  }
  async function readSavedViews(owner: Session, hostId: string, after: string | null = null): Promise<void> {
    try {
      const page = await current(owner, local(owner).savedViews(hostId, after));
      publish({ savedViews: { items: after === null ? page.ids : [...state.savedViews.items, ...page.ids], after: page.after },
        savedViewNotice: page.unreadable ? `${page.unreadable} saved views on this page could not be opened. Their records were left untouched.` : '' });
    } catch {
      if (session === owner) publish({ savedViewNotice: 'Saved views could not be listed. This view and its records remain available.' });
    }
  }
  async function refresh(owner: Session): Promise<void> {
    const storage = local(owner);
    publish({ host: { kind: 'loading' } });
    try {
      const received = await current(owner, owner.connection.metadata());
      const metadata = { ...received, agents: received.agents.map(compatibleAgent) };
      const previous = owner.view;
      if (previous && previous.saved !== null && previous.hostId !== metadata.hostId) {
        disconnectActive();
        owner.view = { storage, saved: null };
        publish(DETACHED_VIEW);
      }
      const compatibility = checkCompatibility(SOLO_CLIENT_COMPATIBILITY, metadata.compatibility);
      const issues = compatibility.kind === 'incompatible' ? compatibility.issues.filter(issue => issue.dimension !== 'native-runtime') : [];
      if (issues.length) {
        state.active?.store.disconnect();
        publish({ host: { kind: 'incompatible', metadata, issues } });
        return;
      }
      const saved = await current(owner, storage.readView(metadata.hostId)).catch(cause => {
        failStorage(owner, storage, cause);
        throw cause;
      });
      owner.view = { storage, saved, hostId: metadata.hostId };
      publish({ host: { kind: 'ready', metadata } });
      const { hostId } = metadata;
      const results = await Promise.allSettled([readCatalog(owner, hostId), readSavedViews(owner, hostId),
        saved.route ? install(owner, saved.route) : Promise.resolve()]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') fail(owner, classifyFailure(failed.reason));
    } catch (cause) { fail(owner, classifyFailure(cause), 'handshake'); }
  }
  async function run(operation: (owner: Session) => Promise<void>): Promise<void> {
    const owner = session;
    if (!owner || state.busy) return;
    publish({ busy: true, error: '' });
    try { await operation(owner); }
    catch (cause) { fail(owner, classifyFailure(cause)); } finally { if (session === owner) publish({ busy: false }); }
  }
  async function submitCommand(owner: Session | null, target: OpenConversation, operation: () => Promise<SubmitResult>): Promise<SubmitResult> {
    if (!owner || session !== owner) throw new Error('This application has closed.');
    if (state.busy) throw new Error('Another operation is in progress.');
    publish({ busy: true, error: '' });
    try {
      requireTarget(owner, target);
      if (target.agent.availability.kind !== 'ready') throw new Error(target.agent.availability.reason);
      const result = await current(owner, operation());
      if (result.kind === 'rejected') publish({ error: result.reason });
      else if (result.receipt.state.kind === 'rejected') publish({ error: result.receipt.state.reason });
      return result;
    } catch (cause) {
      fail(owner, classifyFailure(cause));
      throw cause;
    } finally { if (session === owner) publish({ busy: false }); }
  }
  async function completeCreation(owner: Session, scope: ConversationScope, agentId: string): Promise<void> {
    const view = requireSaved(owner), host = requireHost(owner);
    const matches = () => session === owner && state.host.kind === 'ready' && state.host.metadata.principalId === host.principalId && state.host.metadata.hostId === host.hostId && owner.view?.storage === view.storage && owner.view.saved !== null && owner.view.hostId === scope.hostId &&
      owner.view.saved?.pendingCreation?.agentId === agentId && sameScope(owner.view.saved.pendingCreation.scope, scope);
    try { await current(owner, owner.connection.create(scope, agentId)); }
    catch (error) {
      if (error instanceof ServiceError && error.kind === 'create-rejected' && matches()) {
        await save(owner, { ...requireSaved(owner).saved, pendingCreation: null });
      }
      throw error;
    }
    if (!matches()) throw new Error('The creation view changed. Recover it in its original view.');
    await save(owner, { version: 2, route: scope, pendingCreation: null });
    publish({ catalog: { ...state.catalog, items: [{ scope, preview: null }, ...state.catalog.items.filter(item => !sameScope(item.scope, scope))] } });
    await install(owner, scope);
  }
  function requireTarget(owner: Session, target: OpenConversation): void {
    requireHost(owner);
    if (state.active !== target) throw new Error('Open the command’s conversation before continuing.');
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (session) return Promise.resolve();
      const closing = disposal;
      const next: Session = { view: null, connection: deps.createConnection({ onUnauthorized: () => {
        fail(next, { kind: 'access-revoked' });
      } }) };
      session = next;
      publish(initialSnapshot());
      return run(async owner => {
        try {
          if (closing) await current(owner, closing);
          owner.view = { storage: await acquire(owner, null), saved: null };
        }
        catch (cause) { failStorage(owner, null, cause); if (session === owner) publish({ host: { kind: 'unavailable' } }); return; }
        await refresh(owner);
      });
    },
    dispose() {
      if (!session && disposal) return disposal;
      const owner = session;
      session = null;
      disconnectActive();
      return disposal = Promise.all([disposal, owner?.view?.storage.close()]).then(() => {});
    },
    pair: code => run(async owner => {
      local(owner);
      try { await current(owner, owner.connection.pair(code)); }
      catch (cause) { fail(owner, { kind: 'operation-failed', error: message(cause) }); return; }
      await refresh(owner);
    }),
    reconnect: () => run(refresh),
    reopenView: viewId => run(async owner => {
      requireHost(owner);
      const next = owner.view?.storage.viewId === viewId ? null : await acquire(owner, viewId);
      disconnectActive();
      const closing = disposal = Promise.all([disposal, owner.view?.storage.close()]).then(() => {});
      owner.view = next ? { storage: next, saved: null } : null;
      publish({ ...DETACHED_VIEW, host: { kind: 'loading' } });
      try {
        await current(owner, Promise.resolve(closing));
        owner.view = { storage: next ?? await acquire(owner, viewId), saved: null };
      }
      catch (cause) { await next?.close(); failStorage(owner, null, cause); if (session === owner) publish({ host: { kind: 'unavailable' } }); return; }
      await refresh(owner);
    }),
    moreConversations: () => run(async owner => {
      const host = requireHost(owner);
      if (state.catalog.after !== null) await readCatalog(owner, host.hostId, state.catalog.after);
    }),
    async search(query, after, signal) {
      const owner = session;
      if (!owner) throw new Error('This application has closed.');
      const { hostId, principalId } = requireHost(owner);
      try {
        const page = await current(owner, owner.connection.search(query, after));
        const host = requireHost(owner);
        if (signal.aborted || host.hostId !== hostId || host.principalId !== principalId) throw new Error('Search connection changed.');
        if (page.items.some(entry => entry.scope.hostId !== hostId)) throw new Error('Search belongs to another host.');
        if (page.after !== null && page.after === after) throw new Error('Search did not advance.');
        return page;
      } catch (cause) {
        if (!signal.aborted && cause instanceof ServiceError && cause.kind === 'unauthorized') fail(owner, { kind: 'access-revoked' });
        throw cause;
      }
    },
    moreSavedViews: () => run(async owner => {
      const host = requireHost(owner);
      if (state.savedViews.after !== null) await readSavedViews(owner, host.hostId, state.savedViews.after);
    }),
    create: (agentId) => run(async owner => {
      const host = requireHost(owner);
      const { saved } = requireSaved(owner);
      if (saved.pendingCreation) throw new Error('Recover the pending creation before creating another conversation.');
      const scope = { hostId: host.hostId, conversationId: deps.createId() };
      const selected = agentId ?? host.defaultAgentId;
      const agent = host.agents.find(agent => agent.id === selected);
      if (!agent || agent.availability.kind !== 'ready') throw new Error('Choose an available agent.');
      await save(owner, { ...saved, pendingCreation: { scope, agentId: selected } });
      requireHost(owner);
      await completeCreation(owner, scope, selected);
    }),
    recoverCreation: (selected) => run(async owner => {
      const view = requireSaved(owner), { saved } = view;
      const pending = saved.pendingCreation;
      if (!pending) return;
      const existing = await current(owner, owner.connection.conversationAgent(pending.scope));
      if (requireSaved(owner) !== view) throw new Error('The creation view changed.');
      const agentId = existing?.id ?? selected ?? pending.agentId;
      if (agentId === null) throw new Error('This older pending creation has no saved agent. Choose an agent explicitly to continue.');
      if (!existing && selected !== undefined) {
        const host = await current(owner, owner.connection.metadata());
        if (requireSaved(owner) !== view) throw new Error('The creation view changed.');
        const agent = host.agents.find(agent => agent.id === selected);
        if (!agent || agent.availability.kind !== 'ready') throw new Error('Choose an available agent.');
      }
      if (agentId !== pending.agentId) {
        await save(owner, { ...saved, pendingCreation: { scope: pending.scope, agentId } });
      }
      await completeCreation(owner, pending.scope, agentId);
    }),
    open: scope => run(async owner => {
      const host = requireHost(owner);
      if (scope.hostId !== host.hostId) throw new Error('Conversation belongs to another host.');
      await save(owner, { ...requireSaved(owner).saved, route: scope });
      await install(owner, scope);
    }),
    conversationActions(target) {
      const owner = session;
      const invoke = (kind: 'send' | 'approve' | 'cancel', operation: () => Promise<SubmitResult>) => submitCommand(owner, target, () => {
        const view = target.store.getSnapshot();
        if (view.connection.kind !== 'connected') throw new Error('Connect the conversation before continuing.');
        if (!target.agent.commands.includes(kind)) throw new Error('This agent does not support that command.');
        if (kind === 'send' && conversationResponding(agentPresentation('runtime' in target.agent ? target.agent.runtime : target.agent).agent, view.document.domain)) {
          throw new Error('Wait for the current response before sending.');
        }
        return operation();
      });
      return {
        commands: {
          send: text => invoke('send', () => {
            if (typeof text !== 'string') throw new Error('An explicit message is required.');
            return target.store.send(text);
          }),
          approve: (pendingId, choiceId) => invoke('approve', () => target.store.approve(pendingId, choiceId)),
          cancel: runId => invoke('cancel', () => target.store.cancel(runId)),
        },
        async submit(operation) {
          try { await submitCommand(owner, target, operation); } catch {}
        },
        reconcile: id => run(async owner => {
          requireTarget(owner, target);
          await current(owner, owner.connection.reconcile(target.scope, id));
          await current(owner, target.store.refreshReceipt(id));
        }),
      };
    },
  };
}
