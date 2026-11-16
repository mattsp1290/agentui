import type { ServiceMetadata } from '@agentui/contracts/service';
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
async function scan(target: RecoveryTarget, signal: AbortSignal, valid: () => boolean): Promise<void> {
  const { pool, frontend, lease, metadata } = target, storage = lease.storage;
  let after: string | null = null;
  do {
    const page = await storage.draftScopes(metadata.hostId, after);
    if (!valid()) return;
    for (const scope of page.scopes) {
      if (!valid()) return;
      const borrow = await pool.recovery(lease, scope);
      try {
        const journal = borrow.store.frontendJournal;
        for (let index = 0; index < journal.read().length && valid(); index += 32) {
          for (const reference of journal.read().slice(index, index + 32)) {
            if (!valid()) return;
            await frontend.recover({ viewId: storage.viewId, journal, reference, current: valid, signal, failed: error => pool.failed(storage, error) });
          }
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      } finally { borrow.release(); }
    }
    after = page.after;
    if (after !== null && valid()) await new Promise(resolve => setTimeout(resolve, 0));
  } while (after !== null && valid());
}
export function createFrontendRecovery() {
  let desired: RecoveryTarget | null = null, running: Pass | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  function start(): void {
    if (running || !desired) return;
    const target = desired, retained = target.pool.retainRecovery(target.lease);
    const pass = { target, lifetime: new AbortController() };
    running = pass;
    const valid = () => !pass.lifetime.signal.aborted && sameTarget(desired, target);
    void scan(target, pass.lifetime.signal, valid).catch(error => {
      if (valid()) target.pool.failed(target.lease.storage, error);
    }).finally(() => {
      retained.release();
      if (running !== pass) return;
      running = null;
      if (!desired) return;
      if (pass.lifetime.signal.aborted || !sameTarget(desired, target)) start();
      else timer = setTimeout(start, 2_000);
    });
  }
  return {
    retarget(next: RecoveryTarget | null): void {
      if (sameTarget(desired, next)) return;
      desired = next;
      clearTimeout(timer);
      timer = undefined;
      if (running) { running.lifetime.abort(); return; }
      start();
    },
  };
}
