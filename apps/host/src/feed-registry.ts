import type { ConversationPort } from '@agentui/contracts';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import type { ServicePull } from '@agentui/contracts/service';
import { HostFailure } from './errors.js';
import { ServiceFeed } from './feeds.js';

export class FeedRegistry {
  private readonly feeds = new Map<string, ServiceFeed>();
  private readonly timer = setInterval(() => this.sweep(), 5000);
  open(principalId: string, port: ConversationPort<TranscriptEvent, Transcript>, request: { readonly after: number | null; readonly projectionVersion: number }): string {
    if (this.feeds.size >= 100 || [...this.feeds.values()].filter(feed => feed.principalId === principalId).length >= 16) {
      throw new HostFailure('unavailable', 'Observation limit reached. Close unused views and reconnect.');
    }
    const feed = new ServiceFeed(principalId, port.scope);
    this.feeds.set(feed.id, feed);
    try { feed.attach(port.watch(request, item => feed.receive(item))); }
    catch (error) { this.drop(feed.id); throw error; }
    return feed.id;
  }
  get(principalId: string, id: string): ServiceFeed {
    const feed = this.feeds.get(id);
    if (!feed || feed.principalId !== principalId) throw new HostFailure('invalid', 'Observation no longer exists. Reconnect to the host.');
    return feed;
  }
  async pull(principalId: string, id: string, ack: number | null): Promise<ServicePull> {
    const result = await this.get(principalId, id).pull(ack);
    if (result.kind === 'ended') this.drop(id);
    return result;
  }
  close(principalId: string, id: string): void {
    this.get(principalId, id);
    this.drop(id);
  }
  private drop(id: string): void {
    this.feeds.get(id)?.close();
    this.feeds.delete(id);
  }
  closePrincipal(principalId: string): void {
    for (const [id, feed] of this.feeds) if (feed.principalId === principalId) this.drop(id);
  }
  sweep(now = Date.now()): void {
    for (const [id, feed] of this.feeds) if (feed.isIdle(now, 25_000)) this.drop(id);
  }
  dispose(): void {
    clearInterval(this.timer);
    for (const id of this.feeds.keys()) this.drop(id);
  }
}
