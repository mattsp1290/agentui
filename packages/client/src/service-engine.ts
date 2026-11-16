import { canonicalJson, FeedMismatchError, parseFeedItem, parseScope } from '@agentui/contracts';
import { utf8Bytes } from '@agentui/contracts/decode';
import type { ConversationScope, Feed, FeedEnd, FeedItem, Projection } from '@agentui/contracts';
import { ServiceError, parseServiceRequest, parseServiceResponse, SERVICE_MAX_REQUEST_BYTES, SERVICE_MAX_RESPONSE_BYTES, SERVICE_CATALOG_PAGE } from '@agentui/contracts/service';
import type { ServiceConnection, ServiceRequest, ServiceResponse, ServiceValueMap } from '@agentui/contracts/service';

export class ServiceProtocolError extends Error {}
class ServiceRequestRejected extends Error {}
export async function readServiceResponseBody(response: Response): Promise<unknown> {
  const announced = response.headers.get('content-length');
  if (announced !== null && Number(announced) > SERVICE_MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new ServiceProtocolError('Service response exceeds byte limit');
  }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel();
    throw new ServiceProtocolError('Expected JSON service response');
  }
  if (!response.body) throw new ServiceProtocolError('Empty service response');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0, body = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > SERVICE_MAX_RESPONSE_BYTES) throw new ServiceProtocolError('Service response exceeds byte limit');
      try { body += decoder.decode(chunk.value, { stream: true }); }
      catch { throw new ServiceProtocolError('Invalid UTF-8 service response'); }
    }
    try { body += decoder.decode(); }
    catch { throw new ServiceProtocolError('Invalid UTF-8 service response'); }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  try { return JSON.parse(body); }
  catch (error) { throw new ServiceProtocolError(error instanceof Error ? error.message : 'Invalid service response'); }
}
export interface ServiceConnectionOptions {
  readonly requestTimeoutMs?: number;
  readonly onUnauthorized?: () => void;
}
export type ServiceExecutor = (body: string, context: {
  readonly op: ServiceRequest['op'];
  readonly signal: AbortSignal;
}) => Promise<Response>;
export function createServiceConnection<E, P>(execute: ServiceExecutor,
  projection: Pick<Projection<E, P>, 'version' | 'decodeState' | 'decodeEvent'>,
  options: ServiceConnectionOptions = {}): ServiceConnection<E, P> {
  let credentialGeneration = 0;
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) throw new Error('Invalid service deadline');
  async function request<K extends keyof ServiceValueMap>(value: ServiceRequest & { readonly op: K }, signal?: AbortSignal,
    timeoutMs = requestTimeoutMs): Promise<ServiceValueMap[K]> {
    let body: string;
    try {
      body = canonicalJson(parseServiceRequest(value));
      if (utf8Bytes(body) > SERVICE_MAX_REQUEST_BYTES) throw new Error('Service request exceeds byte limit');
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
      const response = await execute(body, { op: value.op, signal: controller.signal });
      let result: ServiceResponse<ServiceValueMap[K]>;
      try {
        const raw = await readServiceResponseBody(response);
        try { result = parseServiceResponse<K>(value, raw); }
        catch (error) { throw new ServiceProtocolError(error instanceof Error ? error.message : 'Invalid service response'); }
      } catch (error) {
        if (response.status === 401) throw new ServiceError('unauthorized', 'Pair this device with the host');
        throw error;
      }
      if (response.status === 401) throw new ServiceError('unauthorized', result.ok ? 'Pair this device with the host' : result.error.message);
      if (!result.ok && result.error.kind === 'create-rejected' && response.status !== 409) throw new ServiceProtocolError('Invalid creation refusal status');
      if (!result.ok) throw new ServiceError(result.error.kind, result.error.message);
      if (!response.ok) throw new ServiceError('unavailable', `Service returned HTTP ${response.status}`);
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
          if (result.kind === 'ended') {
            const end = result.end;
            finish(end.kind === 'refused' && end.reason === 'unknown-scope-or-incompatible-projection'
              ? { ...end, reason: 'Unknown conversation or incompatible projection. Update the app and host together.' } : end);
            return;
          }
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
    search: (query, after = null) => request({ op: 'search', query, after }),
    create: (scope, agentId) => request({ op: 'create', scope, agentId }),
    providerObservation: input => request({ op: 'provider-observation', ...input }),
    conversationPermissions: scope => request({ op: 'conversation-permissions', scope }),
    conversationAgent: scope => request({ op: 'conversation-agent', scope }),
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
