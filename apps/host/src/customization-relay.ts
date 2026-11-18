import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CUSTOMIZATION_BOUNDS, customizationWorkerRequest } from '@agentui/contracts/service';
import type { CustomizationMutation, CustomizationReply, CustomizationResult, CustomizationStatus, CustomizationWorkerRequest,
  CustomizationWorkerStatus } from '@agentui/contracts/service';

export const WORKER_OFFLINE_MS = 30_000;
export const MUTATION_TIMEOUT_MS = 180_000;
/** A request handed to a worker that has since gone silent this long is handed to the next worker that pulls. */
export const REDELIVERY_MS = 15_000;

/**
 * Relays customization requests between clients and the launcher's worker. It never interprets a location, runs git or
 * spawns a build: clients queue, the worker pulls and pushes status. State is in memory; a restart loses it and the
 * worker pushes its full status again on its next call.
 *
 * Trust: any caller on the overlay network can queue a request or act as the worker (see
 * docs/customization/connected-repository.md).
 */
export function createCustomizationRelay(options: { readonly dataDirectory?: string; readonly now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  if (options.dataDirectory) mkdirSync(join(options.dataDirectory, 'customization'), { recursive: true, mode: 0o700 });
  let worker: { readonly id: string; readonly at: number } | null = null;
  const lastSeen = new Map<string, number>();
  let status: CustomizationWorkerStatus | null = null;
  let pending: { readonly mutation: CustomizationMutation; readonly acceptedAt: number; deliveredTo: string | null } | null = null;
  let results: CustomizationResult[] = [];
  let closed = false;
  const waiters = new Set<() => void>();

  const online = () => worker !== null && now() - worker.at < WORKER_OFFLINE_MS;
  const record = (result: CustomizationResult) => {
    results = [...results.filter(item => item.requestId !== result.requestId), result].slice(-CUSTOMIZATION_BOUNDS.results);
    if (pending?.mutation.requestId === result.requestId) pending = null;
  };
  const expire = () => {
    if (pending && now() - pending.acceptedAt >= MUTATION_TIMEOUT_MS) record({ requestId: pending.mutation.requestId, outcome: 'worker-timeout' });
  };
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  // A pull whose caller went away (a stopped worker) may have taken the request; once that worker is silent, the request
  // goes to the next worker instead of waiting for the 180-second timeout. A live worker keeps pushing, so it never loses one.
  const take = (workerId: string): CustomizationWorkerRequest[] => {
    if (!pending) return [];
    const holder = pending.deliveredTo;
    if (holder !== null && (holder === workerId || now() - (lastSeen.get(holder) ?? 0) < REDELIVERY_MS)) return [];
    pending.deliveredTo = workerId;
    return [customizationWorkerRequest(pending.mutation)];
  };
  const seen = (workerId: string) => {
    worker = { id: workerId, at: now() };
    lastSeen.set(workerId, now());
    if (lastSeen.size > 16) lastSeen.delete(lastSeen.keys().next().value!);
  };

  return {
    status(): CustomizationStatus {
      expire();
      return { support: online() ? 'supported' : 'worker-offline', connection: status?.connection ?? null, head: status?.head ?? null,
        extensions: status?.extensions ?? [], settings: status?.settings ?? null, build: status?.build ?? null,
        running: { buildKey: null, omittedGrants: [], stale: false },
        pending: pending ? { requestId: pending.mutation.requestId, op: pending.mutation.op } : null, results: [...results],
        missingTokens: [] };
    },
    mutate(mutation: CustomizationMutation): CustomizationReply {
      expire();
      if (!online()) return { kind: 'refused', cause: 'unsupported' };
      if (pending) return { kind: 'refused', cause: 'busy' };
      // Apply needs the restart path; until it exists no build can be applied.
      if (mutation.op === 'customization-apply') return { kind: 'refused', cause: 'not-ready' };
      pending = { mutation, acceptedAt: now(), deliveredTo: null };
      wake();
      return { kind: 'accepted' };
    },
    async pull(workerId: string, waitSeconds: number): Promise<{ readonly requests: readonly CustomizationWorkerRequest[] }> {
      seen(workerId);
      expire();
      let requests = take(workerId);
      if (!requests.length && waitSeconds > 0 && !closed) {
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); waiters.delete(done); resolve(); };
          const timer = setTimeout(done, waitSeconds * 1000);
          waiters.add(done);
        });
        expire();
        requests = take(workerId);
      }
      seen(workerId);
      return { requests };
    },
    push(workerId: string, next: CustomizationWorkerStatus, pushed: readonly CustomizationResult[]): { readonly ok: true } {
      seen(workerId);
      status = next;
      for (const result of pushed) record(result);
      return { ok: true };
    },
    close() { closed = true; wake(); },
  };
}
export type CustomizationRelay = ReturnType<typeof createCustomizationRelay>;
