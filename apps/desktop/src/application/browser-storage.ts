import { parseScope } from '@agentui/contracts';
import { identifier, record } from '@agentui/contracts/decode';
import type { DraftStoragePort } from '@agentui/client';

import type { OwnedViewStorage, SavedView, ViewStorageFactory } from './view-state.js';

function decodeView(value: unknown, hostId: string): SavedView {
  if (value === undefined) return { version: 2, route: null, pendingCreation: null };
  let input: Record<string, unknown>;
  try {
    input = record(value, ['version', 'route', 'pendingCreation']);
    if (input.version !== 1 && input.version !== 2) throw new Error('Unsupported version');
  } catch { throw new Error('Unsupported saved view. Local records were preserved.'); }
  const route = input.route === null ? null : parseScope(input.route);
  const pending = input.pendingCreation === null ? null : input.version === 1
    ? { scope: input.pendingCreation, agentId: null } : record(input.pendingCreation, ['scope', 'agentId']);
  const pendingCreation = pending === null ? null : { scope: parseScope(pending.scope),
    agentId: pending.agentId === null ? null : identifier(pending.agentId) };
  if ([route, pendingCreation?.scope].some(scope => scope && scope.hostId !== hostId)) throw new Error('Saved view belongs to another host.');
  return { version: 2, route, pendingCreation };
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open('agentui-browser-views', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('Local storage is blocked by another app version.')); };
  });
}

async function claim(viewId: string, waitForPreviousDocument = false): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = waitForPreviousDocument ? setTimeout(() => controller.abort(), 1500) : undefined;
    void navigator.locks.request(`agentui-view:${viewId}`, waitForPreviousDocument ? { signal: controller.signal } : { ifAvailable: true }, lock => {
      clearTimeout(timer);
      if (!lock) { resolve(null); return; }
      return new Promise<void>(release => resolve(release));
    }).catch(error => { clearTimeout(timer); if (controller.signal.aborted) resolve(null); else reject(error); });
  });
}

// IndexedDB arrays sort after strings, so this sentinel bounds all view identifiers.
const AFTER_ALL_STRINGS: IDBValidKey = [];
function viewKeyRange(after: string | null): IDBKeyRange {
  let lower: IDBValidKey = ['view'];
  if (after !== null) {
    const cursor: unknown = JSON.parse(after);
    if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'string' || typeof cursor[1] !== 'string') throw new Error('Invalid saved view cursor');
    lower = ['view', cursor[0], cursor[1]];
  }
  return IDBKeyRange.bound(lower, ['view', AFTER_ALL_STRINGS], after !== null, true);
}

export class BrowserViewStorage implements OwnedViewStorage {
  private closing: Promise<void> | null = null;
  private readonly transactions = new Set<Promise<void>>();
  private constructor(readonly viewId: string, private readonly db: IDBDatabase, private readonly unlock: () => void, onFailure: (error: unknown) => void) {
    db.onversionchange = () => {
      void this.close();
      onFailure(new Error('Local storage changed in another app version. Reload this view before continuing.'));
    };
  }

  static async open(onFailure: (error: unknown) => void): Promise<BrowserViewStorage> {
    if (!globalThis.indexedDB || !navigator.locks) throw new Error('This browser cannot safely save an exclusive view. IndexedDB and Web Locks are required.');
    const inherited = sessionStorage.getItem('agentui.viewId');
    let viewId = inherited ?? crypto.randomUUID();
    let release = await claim(viewId, inherited !== null);
    if (!release) {
      viewId = crypto.randomUUID();
      release = await claim(viewId);
    }
    if (!release) throw new Error('Could not acquire an exclusive view. Reload the app.');
    try {
      sessionStorage.setItem('agentui.viewId', viewId);
      return new BrowserViewStorage(viewId, await openDatabase(), release, onFailure);
    } catch (error) { release(); throw error; }
  }

  static async reopen(viewId: string, onFailure: (error: unknown) => void): Promise<BrowserViewStorage> {
    if (!globalThis.indexedDB || !navigator.locks) throw new Error('This browser cannot safely save an exclusive view. IndexedDB and Web Locks are required.');
    const release = await claim(viewId);
    if (!release) throw new Error('This saved view is already open in another tab.');
    let db: IDBDatabase | undefined;
    try {
      db = await openDatabase();
      sessionStorage.setItem('agentui.viewId', viewId);
      return new BrowserViewStorage(viewId, db, release, onFailure);
    } catch (error) { db?.close(); release(); throw error; }
  }

  async savedViews(hostId: string, after: string | null = null): ReturnType<OwnedViewStorage['savedViews']> {
    return new Promise((resolve, reject) => {
      const range = viewKeyRange(after);
      const transaction = this.begin('readonly');
      const request = transaction.objectStore('records').openCursor(range);
      const ids: string[] = [];
      let unreadable = 0;
      let scanned = 0;
      let next: string | null = null;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = cursor.key;
        if (!Array.isArray(key) || key.length !== 3 || typeof key[1] !== 'string' || typeof key[2] !== 'string') {
          transaction.abort(); reject(new Error('Unsupported saved view key. Local records were preserved.')); return;
        }
        if (key[2] === hostId && key[1] !== this.viewId) {
          try { decodeView(cursor.value, hostId); ids.push(key[1]); } catch { unreadable++; }
        }
        scanned++;
        if (scanned === 100) { next = JSON.stringify([key[1], key[2]]); return; }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve({ ids, unreadable, after: next });
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not list saved views.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Saved view listing was interrupted.'));
    });
  }

  private begin(mode: IDBTransactionMode): IDBTransaction {
    if (this.closing) throw new Error('This view no longer owns local storage. Reload the app.');
    const transaction = this.db.transaction('records', mode);
    const settled = new Promise<void>(resolve => {
      transaction.addEventListener('complete', () => resolve(), { once: true });
      transaction.addEventListener('abort', () => resolve(), { once: true });
    });
    this.transactions.add(settled);
    void settled.then(() => this.transactions.delete(settled));
    return transaction;
  }

  private transaction(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const transaction = this.begin(mode);
      const request = operation(transaction.objectStore('records'));
      transaction.oncomplete = () => { const value: unknown = request.result; resolve(value); };
      transaction.onerror = () => reject(transaction.error ?? new Error('Local storage transaction failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Local storage transaction was interrupted.'));
    });
  }

  async readView(hostId: string): Promise<SavedView> {
    return decodeView(await this.transaction('readonly', store => store.get(['view', this.viewId, hostId])), hostId);
  }

  async saveView(hostId: string, state: SavedView): Promise<void> {
    const checked = decodeView(state, hostId);
    await this.transaction('readwrite', store => store.put(checked, ['view', this.viewId, hostId]));
  }

  drafts(onFailure: (error: unknown) => void): DraftStoragePort {
    const protect = async <T>(operation: () => Promise<T>): Promise<T> => {
      try { return await operation(); } catch (error) { onFailure(error); throw error; }
    };
    return {
      load: scope => protect(async () => (await this.transaction('readonly', store =>
        store.get(['draft', this.viewId, scope.hostId, scope.conversationId]))) ?? null),
      save: records => protect(async () => {
        await this.transaction('readwrite', store => store.put(records,
          ['draft', this.viewId, records.scope.hostId, records.scope.conversationId]));
      }),
    };
  }

  close(): Promise<void> {
    return this.closing ??= Promise.all(this.transactions).then(() => {
      this.db.close();
      this.unlock();
    });
  }
}

BrowserViewStorage satisfies ViewStorageFactory;
