import { parseFeedItem } from '@agentui/contracts';
import type { ConversationScope } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { parseServiceRequest, parseServiceResponse, SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';
import type { ServiceRequest, ServiceValueMap } from '@agentui/contracts/service';
import { boundedJson, ReadError } from './host.js';

type ReadRequest =
  | { readonly op: 'metadata' }
  | { readonly op: 'catalog'; readonly after: string | null; readonly limit: number }
  | { readonly op: 'conversation-agent'; readonly scope: ConversationScope }
  | { readonly op: 'receipt'; readonly scope: ConversationScope; readonly id: string }
  | { readonly op: 'watch'; readonly scope: ConversationScope; readonly after: null; readonly projectionVersion: number }
  | { readonly op: 'pull'; readonly feedId: string; readonly ack: null }
  | { readonly op: 'close'; readonly feedId: string };

async function requestHost<R extends ReadRequest>(origin: string, request: R, signal: AbortSignal): Promise<ServiceValueMap[R['op']]> {
  const wire = request satisfies ServiceRequest;
  parseServiceRequest(wire);
  const response = await fetch(`${origin}/native/v1`, {
    method: 'POST', redirect: 'error', credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(wire), signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ReadError('Host unavailable');
  }
  const result = parseServiceResponse<R['op']>(request, await boundedJson(response, SERVICE_MAX_RESPONSE_BYTES));
  if (!result.ok) throw new ReadError('Host refused read');
  return result.value;
}

export class Reader {
  private inspections = 0;
  private constructor(private readonly origin: string, private readonly hostId: string) {}
  /** Reads host metadata once and pins its host identity for the life of this reader. */
  static async connect(origin: string, signal: AbortSignal): Promise<Reader> {
    const request = { op: 'metadata' } as const;
    parseServiceRequest(request);
    const metadata = await requestHost(origin, request, signal);
    return new Reader(origin, metadata.hostId);
  }
  private request<R extends ReadRequest>(request: R, signal: AbortSignal): Promise<ServiceValueMap[R['op']]> {
    return requestHost(this.origin, request, signal);
  }
  private async verify(signal: AbortSignal) {
    const metadata = await this.request({ op: 'metadata' }, signal);
    if (metadata.hostId !== this.hostId) throw new ReadError('Host identity changed. Restart the MCP server to reconnect.');
    return metadata;
  }
  async agents(signal: AbortSignal) {
    const metadata = await this.verify(signal);
    return { agents: metadata.agents, defaultAgentId: metadata.defaultAgentId };
  }
  async conversations(after: string | null, limit: number, signal: AbortSignal) {
    await this.verify(signal);
    const items = await this.request({ op: 'catalog', after, limit }, signal);
    if (items.some(item => item.scope.hostId !== this.hostId)) throw new ReadError('Host scope mismatch');
    return { items, after: items.length === limit ? items.at(-1)?.scope.conversationId ?? null : null };
  }
  async receipt(conversationId: string, clientCommandId: string, signal: AbortSignal) {
    await this.verify(signal);
    const scope = { hostId: this.hostId, conversationId };
    const receipt = await this.request({ op: 'receipt', scope, id: clientCommandId }, signal);
    if (receipt && (receipt.scope.hostId !== scope.hostId || receipt.scope.conversationId !== conversationId || receipt.clientCommandId !== clientCommandId)) {
      throw new ReadError('Host receipt mismatch');
    }
    return { scope, clientCommandId, receipt };
  }
  async inspect(conversationId: string, signal: AbortSignal) {
    if (this.inspections >= 4) throw new ReadError('Inspection limit reached');
    this.inspections++;
    let feedId: string | undefined;
    try {
      await this.verify(signal);
      const scope = { hostId: this.hostId, conversationId };
      const agent = await this.request({ op: 'conversation-agent', scope }, signal);
      const feed = await this.request({ op: 'watch', scope, after: null, projectionVersion: transcriptProjection.version }, signal);
      feedId = feed.feedId;
      for (;;) {
        const page = await this.request({ op: 'pull', feedId, ack: null }, signal);
        if (page.kind === 'heartbeat') continue;
        if (page.kind !== 'page') throw new ReadError('Snapshot unavailable');
        const item = parseFeedItem(page.item, transcriptProjection, scope);
        if (item.kind !== 'snapshot') throw new ReadError('Expected snapshot');
        const { cursor, document } = item.snapshot;
        return { scope, cursor, agent, currentRun: document.domain.currentRun, receipts: document.receipts,
          decisions: document.decisions, activities: (document.domain.activities ?? []).map(activity => {
            if (activity.kind === 'file-change') return { ...activity, changes: activity.changes.map(({ patch: _patch, ...change }) => change) };
            const { output: _output, ...command } = activity;
            return command;
          }),
          receiptCoverage: 'unresolved-and-retained-terminal' };
      }
    } finally {
      if (feedId !== undefined) {
        try { await this.request({ op: 'close', feedId }, AbortSignal.timeout(1000)); }
        catch { process.stderr.write('AgentUI inspection cleanup failed\n'); }
      }
      this.inspections--;
    }
  }
}
