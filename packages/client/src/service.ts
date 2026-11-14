import { canonicalJson } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { ServiceError, parseServiceResponse, SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';
import type { ServiceConnection } from '@agentui/contracts/service';
import { createServiceConnection, ServiceProtocolError } from './service-engine.js';

export type { ServiceConnection, ServiceMetadata } from '@agentui/contracts/service';
export { ServiceError } from '@agentui/contracts/service';
export { ServiceProtocolError } from './service-engine.js';
export interface BrowserConnectionOptions {
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly onUnauthorized?: () => void;
}
async function readResponse(response: Response): Promise<unknown> {
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
export function createBrowserConnection(options: BrowserConnectionOptions = {}): ServiceConnection {
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return createServiceConnection(async (request, { signal }) => {
    const response = await fetch('/api/v1', { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: canonicalJson(request), signal, keepalive: request.op === 'close' });
    let raw: unknown;
    try { raw = await readResponse(response); }
    catch (error) {
      if (response.status === 401) throw new ServiceError('unauthorized', 'Pair this browser with the host');
      throw error;
    }
    if (!response.ok) {
      let result;
      try { result = parseServiceResponse(request, raw); }
      catch (error) {
        if (response.status === 401) throw new ServiceError('unauthorized', 'Pair this browser with the host');
        throw new ServiceProtocolError(error instanceof Error ? error.message : 'Invalid service response');
      }
      if (response.status === 401) throw new ServiceError('unauthorized', result.ok ? 'Pair this browser with the host' : result.error.message);
      if (result.ok) throw new ServiceError('unavailable', `Service returned HTTP ${response.status}`);
    }
    return raw;
  }, transcriptProjection, options);
}
