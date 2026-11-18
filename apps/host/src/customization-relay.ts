import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { parseInstallationGrant } from '@agentui/host/customization';
import { CUSTOMIZATION_BOUNDS, customizationWorkerRequest } from '@agentui/contracts/service';
import type { CustomizationDelivery, CustomizationLaunchKeys, CustomizationMutation, CustomizationReply, CustomizationResult, CustomizationStatus,
  CustomizationWorkerRequest, CustomizationWorkerStatus } from '@agentui/contracts/service';

export const WORKER_OFFLINE_MS = 30_000;
export const MUTATION_TIMEOUT_MS = 180_000;
/** A request handed to a worker that has since gone silent this long is handed to the next worker that pulls. */
export const REDELIVERY_MS = 15_000;
/** How long an accepted apply holds the draining gate while the worker delivers the build. */
export const DELIVERY_DEADLINE_MS = 10 * 60_000;
/** The exit code that asks the session wrapper to start the host again with the next launch target. */
export const RESTART_EXIT_CODE = 75;

/** One build the session wrapper can start the host with. Paths are absolute on this machine; grants hold variable names only. */
export interface LaunchTarget {
  readonly buildKey: string;
  readonly inputsKey: string;
  readonly hostArtifactId: string;
  readonly assets: string | null;
  readonly server: { readonly directory: string; readonly artifactId: string } | null;
  readonly grants: readonly unknown[];
}
/** `<data-dir>/customization/launch.json`. The host is its only writer. */
export interface LaunchFile { readonly current: LaunchTarget | null; readonly next: LaunchTarget | null }
/** `<data-dir>/customization/launch-result.json`. The session wrapper is its only writer, once per host start, after the ready line. */
interface LaunchResult {
  readonly hostPid: number;
  readonly started: string | null;
  readonly outcome: 'ok' | 'start-failed' | 'stale' | 'defaults';
  readonly failed: readonly string[];
  readonly omittedGrants: readonly string[];
}

const DIGEST = /^[0-9a-f]{64}$/u;
const TOKEN = /^AGENTUI_EXTENSION_[A-Za-z0-9_]+$/u;
const digest = (value: unknown): string => { if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error('Invalid digest'); return value; };
function absolute(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > CUSTOMIZATION_BOUNDS.path) throw new Error('Invalid path');
  return value;
}
function parseTarget(value: unknown): LaunchTarget | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object') throw new Error('Invalid launch target');
  const input = value as Record<string, unknown>;
  const server = input.server === null ? null : input.server as Record<string, unknown> | undefined;
  if (server === undefined || (server !== null && typeof server !== 'object') || !Array.isArray(input.grants)) throw new Error('Invalid launch target');
  return { buildKey: digest(input.buildKey), inputsKey: digest(input.inputsKey), hostArtifactId: digest(input.hostArtifactId),
    assets: input.assets === null ? null : absolute(input.assets),
    server: server === null ? null : { directory: absolute(server.directory), artifactId: digest(server.artifactId) },
    grants: input.grants.map(grant => parseInstallationGrant(grant)) };
}
function readJson(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
}
function writeAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

export interface CustomizationRelayOptions {
  /** The host data directory; launch files live in its `customization/` directory. */
  readonly dataDirectory?: string;
  readonly now?: () => number;
  /** The running host build. An apply needs a build made by this exact host build. */
  readonly hostArtifactId?: string;
  /** True while any turn, provider operation or host call runs. An apply waits for none of them: it is refused. */
  readonly activeWork?: () => boolean;
  /** Token variables this host consumed at startup: a restart keeps them, so an apply does not need the worker to report them. */
  readonly consumedTokens?: readonly string[];
  /** Called once a delivered build is recorded in `launch.json`: the host closes and exits with `RESTART_EXIT_CODE`. */
  readonly restart?: () => void;
  readonly deliveryDeadlineMs?: number;
  /** The process whose start the wrapper recorded; defaults to this process. */
  readonly pid?: number;
}

/**
 * Relays customization requests between clients and the launcher's worker. It never interprets a location, runs git or
 * spawns a build: clients queue, the worker pulls and pushes status. Queue and status are in memory; a restart loses them
 * and the worker pushes its full status again on its next call. The relay is the only writer of `launch.json`.
 *
 * Trust: any caller on the overlay network can queue a request or act as the worker (see
 * docs/customization/connected-repository.md).
 */
export function createCustomizationRelay(options: CustomizationRelayOptions = {}) {
  const now = options.now ?? Date.now;
  const deliveryDeadlineMs = options.deliveryDeadlineMs ?? DELIVERY_DEADLINE_MS;
  const pid = options.pid ?? process.pid;
  const directory = options.dataDirectory ? join(options.dataDirectory, 'customization') : null;
  if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  let worker: { readonly id: string; readonly at: number } | null = null;
  const lastSeen = new Map<string, number>();
  let status: CustomizationWorkerStatus | null = null;
  let pending: { readonly mutation: CustomizationMutation; readonly acceptedAt: number; deliveredTo: string | null } | null = null;
  let results: CustomizationResult[] = [];
  let closed = false;
  // The draining gate: set while an accepted apply waits for delivery, and kept once a restart is under way.
  let draining: { readonly requestId: string; readonly restarting: boolean } | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const waiters = new Set<() => void>();

  const readLaunch = (): LaunchFile => {
    if (!directory) return { current: null, next: null };
    const value = readJson(join(directory, 'launch.json')) as { version?: unknown; current?: unknown; next?: unknown } | undefined;
    try {
      if (value?.version !== 1) throw new Error('Invalid launch file');
      return { current: parseTarget(value.current), next: parseTarget(value.next) };
    } catch { return { current: null, next: null }; }
  };
  const writeLaunch = (launch: LaunchFile) => { if (directory) writeAtomic(join(directory, 'launch.json'), { version: 1, ...launch }); };
  /** This start's result, or null until the wrapper has written it (or when no wrapper started this host). */
  const readResult = (): LaunchResult | null => {
    if (!directory) return null;
    const value = readJson(join(directory, 'launch-result.json')) as Record<string, unknown> | undefined;
    if (!value || value.version !== 1 || value.hostPid !== pid) return null;
    const keys = (list: unknown) => Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string' && DIGEST.test(key)) : [];
    const outcome = ['ok', 'start-failed', 'stale', 'defaults'].includes(value.outcome as string) ? value.outcome as LaunchResult['outcome'] : 'defaults';
    return { hostPid: pid, started: typeof value.started === 'string' && DIGEST.test(value.started) ? value.started : null, outcome, failed: keys(value.failed),
      omittedGrants: Array.isArray(value.omittedGrants) ? value.omittedGrants.filter((name): name is string => typeof name === 'string' && TOKEN.test(name)) : [] };
  };
  /** Reads both files and, once per host start, promotes a started `next` and clears targets that failed to start. */
  const launchState = (): { readonly launch: LaunchFile; readonly result: LaunchResult | null } => {
    const result = readResult();
    let launch = readLaunch();
    if (result && !settled) {
      settled = true;
      const failed = new Set(result.failed);
      let promoted = launch;
      if (result.started !== null && launch.next?.buildKey === result.started) promoted = { current: launch.next, next: null };
      if (promoted.next && failed.has(promoted.next.buildKey)) promoted = { ...promoted, next: null };
      if (promoted.current && failed.has(promoted.current.buildKey)) promoted = { ...promoted, current: null };
      if (promoted !== launch) { writeLaunch(promoted); launch = promoted; }
    }
    return { launch, result };
  };

  const online = () => worker !== null && now() - worker.at < WORKER_OFFLINE_MS;
  const missingTokens = (): string[] => {
    const build = status?.build;
    if (!build || build.state !== 'ready') return [];
    const present = new Set([...status?.presentTokens ?? [], ...options.consumedTokens ?? []]);
    return build.grantVariables.filter(name => !present.has(name));
  };
  const record = (result: CustomizationResult) => {
    results = [...results.filter(item => item.requestId !== result.requestId), result].slice(-CUSTOMIZATION_BOUNDS.results);
    if (pending?.mutation.requestId === result.requestId) pending = null;
  };
  const releaseGate = (outcome: CustomizationResult['outcome']) => {
    if (!draining || draining.restarting) return;
    clearTimeout(deadline);
    record({ requestId: draining.requestId, outcome });
    draining = null;
  };
  const expire = () => {
    if (draining && !draining.restarting && (!online() || (pending && now() - pending.acceptedAt >= deliveryDeadlineMs))) releaseGate('delivery-failed');
    if (pending && pending.mutation.op !== 'customization-apply' && now() - pending.acceptedAt >= MUTATION_TIMEOUT_MS) record({ requestId: pending.mutation.requestId, outcome: 'worker-timeout' });
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
  /** Records a delivered build as `next` and asks for the restart. Anything that does not match the apply fails delivery. */
  const delivered = (mutation: Extract<CustomizationMutation, { op: 'customization-apply' }>, delivery: CustomizationDelivery | undefined): boolean => {
    const build = status?.build;
    if (!delivery || delivery.requestId !== mutation.requestId || delivery.buildKey !== mutation.buildKey || !build || build.buildKey !== mutation.buildKey ||
      !options.hostArtifactId || !directory) return false;
    let target: LaunchTarget;
    try {
      target = parseTarget({ buildKey: delivery.buildKey, inputsKey: build.inputsKey, hostArtifactId: options.hostArtifactId, assets: delivery.assets,
        server: delivery.server, grants: delivery.grants })!;
    } catch { return false; }
    writeLaunch({ current: launchState().launch.current, next: target });
    return true;
  };

  const launchKeys = (): CustomizationLaunchKeys => {
    const { launch } = launchState();
    return { current: launch.current?.buildKey ?? null, next: launch.next?.buildKey ?? null };
  };

  return {
    status(): CustomizationStatus {
      expire();
      const { result } = launchState();
      return { support: online() ? 'supported' : 'worker-offline', connection: status?.connection ?? null, head: status?.head ?? null,
        extensions: status?.extensions ?? [], settings: status?.settings ?? null, build: status?.build ?? null,
        running: { buildKey: result?.started ?? null, omittedGrants: result?.omittedGrants ?? [], stale: result?.outcome === 'stale' },
        pending: pending ? { requestId: pending.mutation.requestId, op: pending.mutation.op } : null, results: [...results],
        missingTokens: missingTokens() };
    },
    /** True while an apply holds the draining gate: new turns, provider operations and mutations are refused. */
    draining: () => { expire(); return draining !== null; },
    launchKeys,
    mutate(mutation: CustomizationMutation): CustomizationReply {
      expire();
      if (!online()) return { kind: 'refused', cause: 'unsupported' };
      if (draining) return { kind: 'refused', cause: 'draining' };
      if (pending) return { kind: 'refused', cause: 'busy' };
      if (mutation.op === 'customization-apply') {
        const build = status?.build;
        if (!build || build.state !== 'ready' || build.buildKey !== mutation.buildKey || !options.hostArtifactId || build.hostArtifactId !== options.hostArtifactId || !directory) {
          return { kind: 'refused', cause: 'not-ready' };
        }
        // Only a host that a session wrapper started (it wrote this start's result) is started again after exit 75.
        if (!readResult()) return { kind: 'refused', cause: 'unsupported' };
        if (missingTokens().length) return { kind: 'refused', cause: 'missing-token' };
        // The gate goes up before the check, so no work is admitted between the check and the restart.
        draining = { requestId: mutation.requestId, restarting: false };
        let active = true;
        try { active = options.activeWork?.() ?? false; } catch { active = true; }
        if (active) { draining = null; return { kind: 'refused', cause: 'active-work' }; }
        deadline = setTimeout(() => { expire(); releaseGate('delivery-failed'); }, deliveryDeadlineMs);
        deadline.unref?.();
      }
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
    push(workerId: string, next: CustomizationWorkerStatus, pushed: readonly CustomizationResult[], delivery?: CustomizationDelivery): { readonly ok: true; readonly launch: CustomizationLaunchKeys } {
      seen(workerId);
      status = next;
      for (const result of pushed) {
        const apply = pending?.mutation.op === 'customization-apply' && pending.mutation.requestId === result.requestId ? pending.mutation : null;
        if (!apply || !draining || draining.requestId !== apply.requestId) {
          // A delivery that arrives after its gate was released changes nothing: its apply already ended as delivery-failed.
          if (delivery?.requestId !== result.requestId) record(result);
          continue;
        }
        if (result.outcome === 'ok' && delivered(apply, delivery)) {
          clearTimeout(deadline);
          record(result);
          draining = { requestId: apply.requestId, restarting: true };
          // Let this reply and pending status reads go out before the host closes.
          const timer = setTimeout(() => options.restart?.(), 250);
          timer.unref?.();
        } else releaseGate(result.outcome === 'ok' ? 'delivery-failed' : result.outcome);
      }
      return { ok: true, launch: launchKeys() };
    },
    close() { closed = true; clearTimeout(deadline); wake(); },
  };
}
export type CustomizationRelay = ReturnType<typeof createCustomizationRelay>;
