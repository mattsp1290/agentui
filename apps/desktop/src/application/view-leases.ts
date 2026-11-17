import type { ConversationStore } from '@agentui/client';
import type { ConversationScope } from '@agentui/contracts';
import type { Transcript } from '@agentui/contracts/conversation';
import type { OwnedViewStorage } from './view-state.js';

type Store = ConversationStore<Transcript>;
export interface ViewBorrow { readonly storage: OwnedViewStorage; release(): void }
export interface CaptureBorrow { failed(error: unknown): void; release(): void }
export interface CaptureStore { borrow(): CaptureBorrow }
export interface StoreBorrow extends ViewBorrow, CaptureBorrow { readonly store: Store }
interface Slot { readonly store: Store; agentId: string | null; borrows: number; closing: Promise<void> | null }
interface Lease { readonly storage: OwnedViewStorage; readonly stores: Map<string, Slot>; borrows: number; failureInterest: number; closing: Promise<void> | null }
export function createViewLeasePool(deps: {
  createStore(storage: OwnedViewStorage, scope: ConversationScope, agentId: () => string | null, capture: CaptureStore): Store;
  failed(storage: OwnedViewStorage | null, error: unknown): void;
}) {
  const leases = new Map<string, Lease>(), closes = new Set<Promise<void>>();
  let disposal: Promise<void> | null = null;
  function failed(lease: Lease, error: unknown): void {
    if (leases.get(lease.storage.viewId) === lease && lease.failureInterest > 0) deps.failed(lease.storage, error);
  }
  function track(task: Promise<void>): Promise<void> {
    closes.add(task);
    void task.then(() => closes.delete(task), () => {});
    return task;
  }
  function closeView(lease: Lease): void {
    if (lease.closing || lease.stores.size || (!disposal && lease.borrows)) return;
    lease.closing = track(Promise.resolve().then(() => lease.storage.close()).then(() => {
      if (leases.get(lease.storage.viewId) === lease) leases.delete(lease.storage.viewId);
    }).catch(error => { deps.failed(null, error); throw error; }));
  }
  function closeStore(lease: Lease, key: string, slot: Slot): void {
    if (slot.closing) return;
    let drain: Promise<void>;
    slot.closing = track(Promise.resolve().then(() => drain).finally(() => {
      if (lease.stores.get(key) === slot) lease.stores.delete(key);
      closeView(lease);
    }));
    try { drain = slot.store.dispose(); } catch (error) { drain = Promise.reject(error); }
  }
  function viewBorrow(lease: Lease, interested: boolean): ViewBorrow {
    if (disposal || lease.closing) throw new Error('The original view lease is unavailable.');
    lease.borrows++; lease.failureInterest += Number(interested);
    let released = false;
    return { storage: lease.storage, release() {
      if (released) return;
      released = true; lease.borrows--; lease.failureInterest -= Number(interested); closeView(lease);
    } };
  }
  function storeBorrow(lease: Lease, key: string, slot: Slot, interested: boolean): StoreBorrow {
    if (disposal || lease.closing || slot.closing) throw new Error('The original store is closing.');
    slot.borrows++; lease.failureInterest += Number(interested);
    let released = false;
    return { store: slot.store, storage: lease.storage, failed: error => failed(lease, error), release() {
      if (released) return;
      released = true; slot.borrows--; lease.failureInterest -= Number(interested);
      if (!slot.borrows) closeStore(lease, key, slot);
    } };
  }
  async function acquire(view: ViewBorrow, scope: ConversationScope, purpose: { readonly kind: 'active'; readonly agentId: string } | { readonly kind: 'recovery' }): Promise<StoreBorrow> {
    const lease = leases.get(view.storage.viewId);
    if (!lease || lease.storage !== view.storage) throw new Error('The original view lease is unavailable.');
    const interested = purpose.kind === 'active';
    const agentId = purpose.kind === 'active' ? purpose.agentId : null;
    const pending = viewBorrow(lease, interested), key = JSON.stringify([scope.hostId, scope.conversationId]);
    try {
      let slot = lease.stores.get(key);
      while (slot?.closing) { await slot.closing; slot = lease.stores.get(key); }
      if (disposal || lease.closing) throw new Error('The original view lease is unavailable.');
      if (!slot) {
        const cell: Slot = { agentId, borrows: 0, closing: null,
          store: deps.createStore(lease.storage, scope, () => cell.agentId, { borrow: () => storeBorrow(lease, key, cell, true) }) };
        slot = cell; lease.stores.set(key, slot);
      }
      if (agentId !== null) slot.agentId = agentId;
      const borrow = storeBorrow(lease, key, slot, interested);
      try { await slot.store.ready; return borrow; }
      catch (error) { if (interested) borrow.failed(error); borrow.release(); throw error; }
    } finally { pending.release(); }
  }
  return {
    adopt(storage: OwnedViewStorage): ViewBorrow {
      const lease: Lease = { storage, stores: new Map(), borrows: 0, failureInterest: 0, closing: null };
      leases.set(storage.viewId, lease);
      if (disposal) { closeView(lease); throw new Error('This application has closed.'); }
      return viewBorrow(lease, true);
    },
    reserve(viewId: string): ViewBorrow | null {
      const lease = leases.get(viewId);
      return lease ? viewBorrow(lease, true) : null;
    },
    retainRecovery: (view: ViewBorrow): ViewBorrow => {
      const lease = leases.get(view.storage.viewId);
      if (!lease || lease.storage !== view.storage) throw new Error('The original view lease is unavailable.');
      return viewBorrow(lease, false);
    },
    active: (view: ViewBorrow, scope: ConversationScope, agentId: string) => acquire(view, scope, { kind: 'active', agentId }),
    recovery: (view: ViewBorrow, scope: ConversationScope) => acquire(view, scope, { kind: 'recovery' }),
    failed(storage: OwnedViewStorage, error: unknown): void {
      const lease = leases.get(storage.viewId);
      if (lease?.storage === storage) failed(lease, error);
    },
    owns: (storage: OwnedViewStorage) => leases.get(storage.viewId)?.storage === storage,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      disposal = Promise.resolve().then(async () => {
        let failure: PromiseRejectedResult | undefined;
        while (closes.size) {
          const tasks = [...closes];
          const results = await Promise.allSettled(tasks);
          failure ??= results.find(result => result.status === 'rejected');
          for (const task of tasks) closes.delete(task);
        }
        if (failure) throw failure.reason;
      });
      for (const lease of leases.values()) {
        for (const [key, slot] of lease.stores) closeStore(lease, key, slot);
        closeView(lease);
      }
      return disposal;
    },
  };
}
