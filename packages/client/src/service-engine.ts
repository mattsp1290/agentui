import { finishOutputRead } from './output-read.js';
import { canonicalJson, FeedMismatchError, parseFeedItem, parseScope, sameScope } from '@agentui/contracts';
import { utf8Bytes } from '@agentui/contracts/decode';
import type { ConversationScope, Feed, FeedEnd, FeedItem, Projection } from '@agentui/contracts';
import { ServiceError, parseServiceRequest, parseServiceResponse, SERVICE_MAX_REQUEST_BYTES, SERVICE_MAX_RESPONSE_BYTES, SERVICE_CATALOG_PAGE } from '@agentui/contracts/service';
import type { ServiceConnection, ServiceRequest, ServiceResponse, ServiceValueMap } from '@agentui/contracts/service';
import { IMAGE_MAX_BYTES, IMAGE_TRANSFER_MAX_BYTES } from '@agentui/contracts/image';

export class ServiceProtocolError extends Error {}
export class ServiceConnectionLost extends ServiceError {
  constructor(message: string) { super('unavailable', message); }
}
class ServiceRequestRejected extends Error {}
export async function readServiceResponseBody(response: Response, limit = SERVICE_MAX_RESPONSE_BYTES): Promise<unknown> {
  const announced = response.headers.get('content-length');
  if (announced !== null && Number(announced) > limit) {
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
      if (bytes > limit) throw new ServiceProtocolError('Service response exceeds byte limit');
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
  readonly onConnectionLost?: (error: ServiceConnectionLost) => void;
}
export type ServiceExecutor = (body: string, context: {
  readonly op: ServiceRequest['op'];
  readonly signal: AbortSignal;
}) => Promise<Response>;
export function createServiceConnection<E, P>(execute: ServiceExecutor,
  projection: Pick<Projection<E, P>, 'version' | 'decodeState' | 'decodeEvent'>,
  options: ServiceConnectionOptions = {}): ServiceConnection<E, P> {
  const requestTimeoutMs = options.requestTimeoutMs ?? 20_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 60_000) throw new Error('Invalid service deadline');
  async function requestResult<K extends keyof ServiceValueMap, Result>(value: ServiceRequest & { readonly op: K },
    complete: (value: ServiceValueMap[K]) => Result, signal?: AbortSignal, timeoutMs = requestTimeoutMs): Promise<Result> {
    const deadline = performance.now() + timeoutMs;
    const imageOperation = value.op === 'image-upload' || value.op === 'image-read';
    let body: string;
    try {
      body = canonicalJson(parseServiceRequest(value));
      if (utf8Bytes(body) > (imageOperation ? IMAGE_TRANSFER_MAX_BYTES : SERVICE_MAX_REQUEST_BYTES)) throw new Error('Service request exceeds byte limit');
    } catch (error) { throw new ServiceRequestRejected(error instanceof Error ? error.message : 'Invalid service request'); }
    if (signal?.aborted) throw new ServiceError('unavailable', 'Service request interrupted');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort = (): void => {};
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => { controller.abort(); reject(new ServiceError('unavailable', 'Service request interrupted')); };
      timer = setTimeout(() => { controller.abort(); reject(new ServiceError('unavailable', 'Service request timed out')); }, timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
    });
    const perform = async (): Promise<Result> => {
      let response: Response;
      try { response = await execute(body, { op: value.op, signal: controller.signal }); }
      catch (error) {
        if (error instanceof ServiceConnectionLost && !signal?.aborted) options.onConnectionLost?.(error);
        throw error;
      }
      const raw = await readServiceResponseBody(response, imageOperation ? IMAGE_TRANSFER_MAX_BYTES : SERVICE_MAX_RESPONSE_BYTES);
      let result: ServiceResponse<ServiceValueMap[K]>;
      try { result = parseServiceResponse<K>(value, raw); }
      catch (error) { throw new ServiceProtocolError(error instanceof Error ? error.message : 'Invalid service response'); }
      if (!result.ok && result.error.kind === 'create-rejected' && response.status !== 409) throw new ServiceProtocolError('Invalid creation refusal status');
      if (!result.ok) throw new ServiceError(result.error.kind, result.error.message);
      if (!response.ok) throw new ServiceError('unavailable', `Service returned HTTP ${response.status}`);
      let completed: Result;
      try { completed = complete(result.value); }
      catch (error) { throw new ServiceProtocolError(error instanceof Error ? error.message : 'Invalid service completion'); }
      if (controller.signal.aborted || performance.now() >= deadline) throw new ServiceError('unavailable', 'Service request interrupted');
      return completed;
    };
    try { return await Promise.race([perform(), interrupted]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
  function request<K extends keyof ServiceValueMap>(value: ServiceRequest & { readonly op: K }, signal?: AbortSignal,
    timeoutMs = requestTimeoutMs): Promise<ServiceValueMap[K]> {
    return requestResult<K, ServiceValueMap[K]>(value, result => result, signal, timeoutMs);
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
    async conversationOutputs(value) {
      const scope = parseScope(value);
      return requestResult({ op: 'output-list', scope }, result => result.result);
    },
    async readOutput(value, outputId) {
      const scope = parseScope(value);
      return requestResult({ op: 'output-read', scope, outputId }, finishOutputRead);
    },
    async uploadImage({ scope, uploadId, name, bytes }) {
      const result = await request({ op: 'image-upload', scope, uploadId, name, byteLength: bytes.byteLength, base64: encodeImageBytes(bytes) });
      if (!sameScope(result.scope, scope) || result.attachment.name !== name || result.attachment.byteLength !== bytes.byteLength) {
        throw new ServiceProtocolError('Image upload response mismatch');
      }
      return result.attachment;
    },
    async readImage(scope, imageId) {
      const result = await request({ op: 'image-read', scope, imageId });
      if (!sameScope(result.scope, scope) || result.attachment.imageId !== imageId) throw new ServiceProtocolError('Image read response mismatch');
      return { attachment: result.attachment, bytes: Uint8Array.from(atob(result.base64), character => character.charCodeAt(0)) };
    },
    metadata: () => request({ op: 'metadata' }),
    catalog: (after = null, limit = SERVICE_CATALOG_PAGE) => request({ op: 'catalog', after, limit }),
    search: (query, after = null) => request({ op: 'search', query, after }),
    create: (scope, agentId) => request({ op: 'create', scope, agentId }),
    frontendBinding: input => request({ op: 'frontend-binding', ...input }),
    providerObservation: input => request({ op: 'provider-observation', ...input }),
    continuation: input => request({ op: 'continuation', ...input }),
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

function encodeImageBytes(bytes: Uint8Array): string {
  if (!bytes.byteLength || bytes.byteLength > IMAGE_MAX_BYTES) throw new Error('Image must contain at most 4 MiB');
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 12_288) {
    parts.push(btoa(Array.from(bytes.subarray(offset, offset + 12_288), byte => String.fromCharCode(byte)).join('')));
  }
  return parts.join('');
}
