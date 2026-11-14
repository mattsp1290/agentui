import { canonicalJson, parseScope } from '@agentui/contracts';
import { utf8Bytes } from '@agentui/contracts/decode';
import type { ConversationScope, Feed, FeedEnd, FeedItem } from '@agentui/contracts';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import { parseServiceRequest, parseServiceResponse, SERVICE_MAX_REQUEST_BYTES, SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';
import type { ServiceConnection, ServiceRequest, ServiceResponse, ServiceValueMap } from '@agentui/contracts/service';

export type { ServiceConnection, ServiceMetadata } from '@agentui/contracts/service';
export class ServiceError extends Error {
  constructor(readonly kind: 'unauthorized' | 'forbidden' | 'invalid' | 'unavailable', message: string) { super(message); }
}
export class ServiceProtocolError extends Error {}
class ServiceRequestRejected extends Error {}
export interface BrowserConnectionOptions {
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly onUnauthorized?: () => void;
}
async function readResponse<K extends keyof ServiceValueMap>(response: Response, request: { readonly op: K }): Promise<ServiceResponse<ServiceValueMap[K]>> {
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
  try { return parseServiceResponse<K>(request, JSON.parse(body)); }
  catch (error) { throw new ServiceProtocolError(error instanceof Error ? error.message : 'Invalid service response'); }
}
export function createBrowserConnection(options: BrowserConnectionOptions = {}): ServiceConnection {
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  let credentialGeneration = 0;
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) throw new Error('Invalid service deadline');
  async function request<K extends keyof ServiceValueMap>(value: ServiceRequest & { readonly op: K }, signal?: AbortSignal,
    timeoutMs = requestTimeoutMs): Promise<ServiceValueMap[K]> {
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
      let body: string;
      try {
        body = canonicalJson(parseServiceRequest(value));
        if (utf8Bytes(body) > SERVICE_MAX_REQUEST_BYTES) throw new Error('Service request exceeds byte limit');
      } catch (error) { throw new ServiceRequestRejected(error instanceof Error ? error.message : 'Invalid service request'); }
      const response = await fetch('/api/v1', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body, signal: controller.signal, keepalive: value.op === 'close' });
      let result: ServiceResponse<ServiceValueMap[K]>;
      try { result = await readResponse<K>(response, value); }
      catch (error) {
        if (response.status !== 401) throw error;
        result = { ok: false, error: { kind: 'unauthorized', message: 'Pair this browser with the host' } };
      }
      const unauthorized = response.status === 401 || (!result.ok && result.error.kind === 'unauthorized');
      if (unauthorized) {
        if (value.op !== 'pair' && requestedGeneration === credentialGeneration && !controller.signal.aborted) options.onUnauthorized?.();
        throw new ServiceError('unauthorized', result.ok ? 'Pair this browser with the host' : result.error.message);
      }
      if (!result.ok) throw new ServiceError(result.error.kind, result.error.message);
      if (!response.ok) throw new ServiceError('unavailable', `Service returned HTTP ${response.status}`);
      return result.value;
    };
    try {
      if (signal?.aborted) abort();
      return await Promise.race([perform(), interrupted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  function watch(scope: ConversationScope, input: { readonly after: number | null; readonly projectionVersion: number },
    receive: (item: FeedItem<TranscriptEvent, Transcript>) => Promise<void>): Feed {
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
          await receive(result.item);
          if (phase !== 'active') return;
          lastPage = result.page;
          identity = nextIdentity;
          if (result.item.kind === 'snapshot') cursor = result.item.snapshot.cursor;
          else cursor = result.item.events.at(-1)?.sequence ?? cursor;
        }
      } catch (error) {
        finish({ kind: error instanceof ServiceProtocolError ? 'resync' : 'failed', cursor,
          reason: error instanceof Error ? error.message : 'Service connection failed' });
      }
    };
    void run();
    return { ended, close: () => finish({ kind: 'closed', cursor, reason: 'Client closed the feed' }) };
  }
  return {
    async pair(code) { await request({ op: 'pair', code }); credentialGeneration++; },
    metadata: () => request({ op: 'metadata' }),
    catalog: (after = null, limit = 100) => request({ op: 'catalog', after, limit }),
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
