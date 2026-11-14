import { randomUUID } from 'node:crypto';
import type { ConversationScope, Feed, FeedEnd, FeedItem } from '@agentui/contracts';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import type { ServicePull } from '@agentui/contracts/service';

type Page = Extract<ServicePull, { kind: 'page' }>;
export class ServiceFeed {
  readonly id = randomUUID();
  private pending: { readonly value: Page; readonly applied: () => void } | null = null;
  private lastAck = 0;
  private serial = 0;
  private polling = false;
  private wake = () => {};
  private end: FeedEnd | null = null;
  private feed: Feed | null = null;
  touched = Date.now();
  constructor(readonly principalId: string, readonly scope: ConversationScope) {}
  attach(feed: Feed): void {
    this.feed = feed;
    void feed.ended.then(end => { this.end = end; this.wake(); });
  }
  async receive(item: FeedItem<TranscriptEvent, Transcript>): Promise<void> {
    if (this.end) return;
    if (this.pending) throw new Error('Concurrent journal delivery');
    await new Promise<void>(resolve => {
      this.pending = { value: { kind: 'page', page: ++this.serial, item }, applied: resolve };
      this.wake();
    });
  }
  async pull(ack: number | null): Promise<ServicePull> {
    if (this.polling) throw new Error('Concurrent feed pull');
    if (ack !== null && ack !== this.lastAck) {
      if (ack !== this.pending?.value.page) throw new Error('Invalid feed acknowledgement');
      const applied = this.pending.applied;
      this.lastAck = ack;
      this.pending = null;
      applied();
    }
    this.polling = true;
    this.touched = Date.now();
    try {
      if (!this.pending && !this.end) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.wake = () => {}; resolve(); };
        const timer = setTimeout(finish, 10_000);
        this.wake = finish;
      });
      if (this.end) return { kind: 'ended', end: this.end };
      return this.pending?.value ?? { kind: 'heartbeat' };
    } finally { this.polling = false; this.touched = Date.now(); }
  }
  close(): void {
    if (this.end) return;
    this.feed?.close();
    this.end = { kind: 'closed', reason: 'Observation closed', cursor: null };
    this.pending?.applied();
    this.pending = null;
    this.wake();
  }
}
