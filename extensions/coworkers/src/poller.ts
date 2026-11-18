/** Timers the scheduler uses. Tests supply a fake clock. */
export interface PollerClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const realClock: PollerClock = { setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
export const ACTIVE_DELAY_MS = 1_000;
export const IDLE_DELAYS_MS = [5_000, 15_000, 60_000, 300_000] as const;
export const MAX_DELAY_MS = 300_000;
export const MAX_IN_FLIGHT = 4;
/** What one poll found: a non-terminal request (active), none (idle), or a failed read. */
export type PollResult = 'active' | 'idle' | 'failed';
export interface PollHandle {
  /** Poll at once and treat the conversation as active, as after a submit. */
  wake(): void;
  stop(): void;
}

/**
 * One scheduler per installation. Active conversations poll every second; idle ones back off 5, 15, 60, then 300 seconds;
 * a failed poll doubles that conversation's delay up to 300 seconds and tries again. At most four HTTP requests are in
 * flight per installation; due polls queue behind that limit.
 */
export function createPoller(options: { readonly clock?: PollerClock; readonly maxInFlight?: number } = {}) {
  const clock = options.clock ?? realClock, maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT;
  let inFlight = 0;
  const waiting: (() => void)[] = [];
  let stats = { maxInFlight: 0, requests: 0 };
  async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (inFlight >= maxInFlight) await new Promise<void>(resolve => waiting.push(resolve));
    inFlight++;
    stats = { maxInFlight: Math.max(stats.maxInFlight, inFlight), requests: stats.requests + 1 };
    try { return await task(); }
    finally { inFlight--; waiting.shift()?.(); }
  }
  function schedule(poll: () => Promise<PollResult>): PollHandle {
    let stopped = false, running = false, timer: unknown = null, idleStep = 0, delay = 0, woken = false;
    const arm = (ms: number) => {
      if (stopped) return;
      if (timer !== null) clock.clearTimeout(timer);
      timer = clock.setTimeout(() => { timer = null; void run(); }, ms);
    };
    async function run(): Promise<void> {
      if (stopped || running) return;
      running = true; woken = false;
      let result: PollResult;
      try { result = await poll(); } catch { result = 'failed'; }
      running = false;
      if (stopped) return;
      if (woken) { idleStep = 0; delay = ACTIVE_DELAY_MS; arm(0); return; }
      if (result === 'active') { idleStep = 0; delay = ACTIVE_DELAY_MS; }
      else if (result === 'idle') { delay = IDLE_DELAYS_MS[Math.min(idleStep, IDLE_DELAYS_MS.length - 1)]!; idleStep++; }
      else delay = Math.min(MAX_DELAY_MS, Math.max(ACTIVE_DELAY_MS, delay * 2));
      arm(delay);
    }
    arm(0);
    return {
      wake() { if (stopped) return; woken = true; idleStep = 0; if (!running) arm(0); },
      stop() { stopped = true; if (timer !== null) clock.clearTimeout(timer); timer = null; },
    };
  }
  return { limit, schedule, stats: () => stats };
}
export type Poller = ReturnType<typeof createPoller>;
