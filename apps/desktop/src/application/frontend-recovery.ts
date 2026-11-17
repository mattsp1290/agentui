import type { ServiceMetadata } from '@agentui/contracts/service';
import type { OwnedViewStorage } from './view-state.js';
import type { FrontendSends } from './frontend-sends.js';
import type { createViewLeasePool, ViewBorrow } from './view-leases.js';

interface RecoveryTarget {
  readonly pool: ReturnType<typeof createViewLeasePool>;
  readonly frontend: FrontendSends;
  readonly lease: ViewBorrow;
  readonly metadata: ServiceMetadata;
}
interface Pass { readonly target: RecoveryTarget; readonly lifetime: AbortController }
function sameTarget(a: RecoveryTarget | null, b: RecoveryTarget | null): boolean {
  return a === b || (a !== null && b !== null && a.pool === b.pool && a.lease === b.lease && a.metadata === b.metadata);
}
function pause(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, 0);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}
async function scan(target: RecoveryTarget, signal: AbortSignal, valid: () => boolean): Promise<boolean> {
  const { pool, frontend, lease, metadata } = target, storage = lease.storage;
  let after: string | null = null, pending = false;
  do {
    const page = await storage.draftScopes(metadata.hostId, after);
    if (!valid()) return false;
    for (const scope of page.scopes) {
      if (!valid()) return false;
      const borrow = await pool.recovery(lease, scope);
      try {
        const journal = borrow.store.frontendJournal;
        for (let index = 0; index < journal.read().length && valid(); index += 32) {
          for (const reference of journal.read().slice(index, index + 32)) {
            if (!valid()) return false;
            await frontend.recover({ viewId: storage.viewId, journal, reference, current: valid, signal, failed: error => pool.failed(storage, error) });
          }
          await pause(signal);
        }
        if (valid()) pending = frontend.needsRecovery(storage.viewId, journal) || pending;
      } finally { borrow.release(); }
    }
    after = page.after;
    if (after !== null && valid()) await pause(signal);
  } while (after !== null && valid());
  return pending;
}
export function createFrontendRecovery() {
  let desired: RecoveryTarget | null = null, running: Pass | null = null, requested = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function start(): Promise<void> {
    if (running || !desired || !requested) return;
    clearTimeout(timer);
    timer = undefined;
    requested = false;
    const target = desired, pass = { target, lifetime: new AbortController() };
    running = pass;
    const valid = () => !pass.lifetime.signal.aborted && sameTarget(desired, target);
    let retained: ViewBorrow | undefined, pending = false;
    try {
      retained = target.pool.retainRecovery(target.lease);
      if (valid()) pending = await scan(target, pass.lifetime.signal, valid);
    } catch (error) {
      if (valid()) target.pool.failed(target.lease.storage, error);
    } finally {
      retained?.release();
      if (running === pass) running = null;
      if (desired) {
        if (pass.lifetime.signal.aborted || !sameTarget(desired, target) || requested) {
          requested = true;
          queueMicrotask(() => { void start(); });
        } else if (pending) {
          requested = true;
          timer = setTimeout(() => { void start(); }, 2_000);
        }
      }
    }
  }
  return {
    retarget(next: RecoveryTarget | null): void {
      if (sameTarget(desired, next)) return;
      desired = next;
      clearTimeout(timer);
      timer = undefined;
      requested = next !== null;
      running?.lifetime.abort();
      queueMicrotask(() => { void start(); });
    },
    wake(source: { readonly pool: RecoveryTarget['pool']; readonly storage: OwnedViewStorage }): void {
      if (desired?.pool !== source.pool || desired.lease.storage !== source.storage) return;
      requested = true;
      clearTimeout(timer);
      timer = undefined;
      queueMicrotask(() => { void start(); });
    },
  };
}
