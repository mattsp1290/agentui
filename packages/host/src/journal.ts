import type { ConversationScope, Feed, FeedEnd, FeedItem } from '@agentui/contracts';
import type { SqliteStore } from './sqlite-store.js';

export class Journal<E, P> {
  private readonly feeds = new Set<() => void>();
  private readonly waiters = new Set<() => void>();
  private generation = 0;
  private closed = false;
  constructor(private readonly store: SqliteStore<E, P>) {}
  wake(): void {
    this.generation++;
    for (const wake of this.waiters) wake();
  }
  close(): void {
    this.closed = true;
    for (const close of this.feeds) close();
  }
  watch(scope: ConversationScope, request: { after: number | null; projectionVersion: number },
    receive: (item: FeedItem<E, P>) => Promise<void>): Feed {
    let cursor = request.after;
    let stopped = false;
    let cancelWait = () => {};
    let finish!: (end: FeedEnd) => void;
    const ended = new Promise<FeedEnd>(resolve => { finish = resolve; });
    const stop = (kind: FeedEnd['kind'], reason: string) => {
      if (stopped) return;
      stopped = true;
      cancelWait();
      this.feeds.delete(close);
      finish({ kind, reason, cursor });
    };
    const close = () => stop('closed', 'closed');
    const deliver = async (item: FeedItem<E, P>, next: number): Promise<void> => {
      if (stopped) return;
      let timer: ReturnType<typeof setTimeout>;
      const cancelled = new Promise<void>(resolve => {
        cancelWait = resolve;
        timer = setTimeout(() => { stop('resync', 'delivery-timeout'); resolve(); }, this.store.limits.deliveryMs);
      });
      const applied = Promise.resolve().then(() => stopped ? undefined : receive(item)).then(() => {
        if (!stopped) cursor = next;
      });
      try { await Promise.race([applied, cancelled]); }
      finally { clearTimeout(timer!); cancelWait = () => {}; }
    };
    const idle = async (generation: number): Promise<void> => {
      if (stopped || generation !== this.generation) return;
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); this.waiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, this.store.limits.pollMs);
        this.waiters.add(wake);
        cancelWait = wake;
        if (stopped || generation !== this.generation) wake();
      });
      cancelWait = () => {};
    };
    const run = async () => {
      if (stopped) return;
      const plan = this.store.plan(scope, request.after, request.projectionVersion);
      let through: number;
      if (plan.kind === 'snapshot') {
        through = plan.snapshot.cursor;
        await deliver({ kind: 'snapshot', snapshot: plan.snapshot }, through);
      } else if (plan.kind === 'resume') {
        if (cursor === null) { stop('resync', 'resume-without-cursor'); return; }
        through = plan.through;
        await deliver({ kind: 'events', events: [] }, cursor);
      } else { stop(plan.kind, plan.reason); return; }
      while (!stopped) {
        const generation = this.generation;
        const next = this.store.plan(scope, cursor, request.projectionVersion);
        if (next.kind === 'snapshot') {
          through = next.snapshot.cursor;
          await deliver({ kind: 'snapshot', snapshot: next.snapshot }, through);
          continue;
        }
        if (next.kind !== 'resume') { stop(next.kind, next.reason); return; }
        through = next.through;
        if (cursor !== null && cursor < through) {
          const events = this.store.page(scope, cursor, through);
          const last = events.at(-1);
          if (!last || events[0]?.sequence !== cursor + 1) { stop('resync', 'journal-gap'); return; }
          await deliver({ kind: 'events', events }, last.sequence);
          continue;
        }
        through = this.store.head(scope);
        if (cursor !== null && cursor < through) continue;
        await idle(generation);
      }
    };
    if (this.closed || this.feeds.size >= this.store.limits.subscribers) {
      stop('refused', 'subscriber-limit-or-host-closed');
      return { close, ended };
    }
    this.feeds.add(close);
    queueMicrotask(() => { void run().catch(error => stop('failed', error instanceof Error ? error.message : 'feed-failed')); });
    return { close, ended };
  }
}
