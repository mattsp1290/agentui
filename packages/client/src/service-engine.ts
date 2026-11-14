import { canonicalJson, FeedMismatchError, parseFeedItem, parseScope } from '@agentui/contracts';
import { utf8Bytes } from '@agentui/contracts/decode';
import type { ConversationPort, ConversationScope, Feed, FeedEnd, FeedItem, Projection } from '@agentui/contracts';
import { ServiceError, parseServiceRequest, parseServiceResponse, SERVICE_MAX_REQUEST_BYTES, SERVICE_CATALOG_PAGE } from '@agentui/contracts/service';
import type { ServiceConnection, ServiceRequest, ServiceValueMap } from '@agentui/contracts/service';

export class ServiceProtocolError extends Error {}
class ServiceRequestRejected extends Error {}
interface ServiceConnectionOptions {
  readonly requestTimeoutMs?: number;
  readonly onUnauthorized?: () => void;
}
type ServiceExecutor = (request: ServiceRequest, context: {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}) => Promise<unknown>;
export function createServiceConnection<E, P>(execute: ServiceExecutor,
  projection: Pick<Projection<E, P>, 'version' | 'decodeState' | 'decodeEvent'>,
  options: ServiceConnectionOptions = {}): Omit<ServiceConnection, 'conversation'> & { conversation(scope: ConversationScope): ConversationPort<E, P> } {
  let credentialGeneration = 0;
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) throw new Error('Invalid service deadline');
  async function request<K extends keyof ServiceValueMap>(value: ServiceRequest & { readonly op: K }, signal?: AbortSignal,
    timeoutMs = requestTimeoutMs): Promise<ServiceValueMap[K]> {
    let normalized: ServiceRequest;
    try {
      normalized = parseServiceRequest(value);
      if (utf8Bytes(canonicalJson(normalized)) > SERVICE_MAX_REQUEST_BYTES) throw new Error('Service request exceeds byte limit');
    } catch (error) { throw new ServiceRequestRejected(error instanceof Error ? error.message : 'Invalid service request'); }
    if (signal?.aborted) throw new ServiceError('unavailable', 'Service request interrupted');
    const controller = new AbortController();
    const requestedGeneration = credentialGeneration;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = (): void => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => { controller.abort(); reject(new ServiceError('unavailable', 'Service request interrupted')); };
      timer = setTimeout(() => { controller.abort(); reject(new ServiceError('unavailable', 'Service request timed out')); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
    });
    const perform = async (): Promise<ServiceValueMap[K]> => {
      const raw = await execute(normalized, { signal: controller.signal, timeoutMs });
      let result;
      try { result = parseServiceResponse<K>(value, raw); }
      catch (error) { throw new ServiceProtocolError(error instanceof Error ? error.message : 'Invalid service response'); }
      if (!result.ok) throw new ServiceError(result.error.kind, result.error.message);
      return result.value;
    };
    try { return await Promise.race([perform(), interrupted]); }
    catch (error) {
      if (error instanceof ServiceError && error.kind === 'unauthorized' && value.op !== 'pair' &&
        requestedGeneration === credentialGeneration && !controller.signal.aborted) options.onUnauthorized?.();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  function watch(scope: ConversationScope, input: { readonly after: number | null; readonly projectionVersion: number },
    receive: (item: FeedItem<E, P>) => Promise<void>): Feed {
    const controller = new AbortController();
    let phase: 'active' | 'ended' = 'active';
    let feedId: string | null = null, lastPage: number | null = null, identity: string | null = null;
    let cursor = input.after;
    let settle: (end: FeedEnd) => void = () => {};
    const ended = new Promise<FeedEnd>(resolve => { settle = resolve; });
    const closeRemote = (): void => {
      if (feedId !== null) void request({ op: 'close', feedId }, undefined, Math.min(2_000, requestTimeoutMs)).catch(() => {});
    };
    const finish = (end: FeedEnd): void => {
      if (phase === 'ended') return;
      phase = 'ended';
      controller.abort();
      settle(end);
      closeRemote();
    };
    const run = async (): Promise<void> => {
      try {
        const opened = await request({ op: 'watch', scope, ...input });
        feedId = opened.feedId;
        if (phase === 'ended') { closeRemote(); return; }
        while (phase === 'active') {
          const result = await request({ op: 'pull', feedId, ack: lastPage }, controller.signal);
          if (phase !== 'active') return;
          if (result.kind === 'ended') { finish(result.end); return; }
          if (result.kind === 'heartbeat') continue;
          const nextIdentity = canonicalJson(result.item);
          if (lastPage !== null && result.page === lastPage) {
            if (identity !== nextIdentity) throw new ServiceProtocolError('Service changed an acknowledged page');
            continue;
          }
          if (result.page !== (lastPage === null ? 1 : lastPage + 1)) throw new ServiceProtocolError('Service page sequence gap');
          let item: FeedItem<E, P>;
          try { item = parseFeedItem(result.item, projection, scope); }
          catch (error) {
            if (error instanceof FeedMismatchError) throw error;
            throw new ServiceProtocolError(error instanceof Error ? error.message : 'Invalid service feed item');
          }
          await receive(item);
          if (phase !== 'active') return;
          lastPage = result.page;
          identity = nextIdentity;
          if (item.kind === 'snapshot') cursor = item.snapshot.cursor;
          else cursor = item.events.at(-1)?.sequence ?? cursor;
        }
      } catch (error) {
        finish({ kind: error instanceof FeedMismatchError ? 'refused' : error instanceof ServiceProtocolError ? 'resync' : 'failed', cursor,
          reason: error instanceof Error ? error.message : 'Service connection failed' });
      }
    };
    void run();
    return { ended, close: () => finish({ kind: 'closed', cursor, reason: 'Client closed the feed' }) };
  }
  return {
    async pair(code) { await request({ op: 'pair', code }); credentialGeneration++; },
    metadata: () => request({ op: 'metadata' }),
    catalog: (after = null, limit = SERVICE_CATALOG_PAGE) => request({ op: 'catalog', after, limit }),
    create: scope => request({ op: 'create', scope }),
    reconcile: (scope, id) => request({ op: 'reconcile', scope, id }),
    conversation(value) {
      const scope = parseScope(value);
      return { scope,
        async submit(command) {
          try { return await request({ op: 'submit', command }); }
          catch (error) {
            if (error instanceof ServiceRequestRejected) return { kind: 'rejected', reason: error.message };
            throw error;
          }
        },
        receipt: id => request({ op: 'receipt', scope, id }),
        watch: (input, receive) => watch(scope, input, receive) };
    },
  };
}
