import { canonicalJson } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import type { ServiceConnection } from '@agentui/contracts/service';
import { createServiceConnection } from './service-engine.js';

export type { ServiceConnection, ServiceMetadata } from '@agentui/contracts/service';
export { ServiceError } from '@agentui/contracts/service';
export { ServiceProtocolError } from './service-engine.js';
export interface BrowserConnectionOptions {
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly onUnauthorized?: () => void;
}
export function createBrowserConnection(options: BrowserConnectionOptions = {}): ServiceConnection {
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return createServiceConnection((request, { signal }) => fetch('/api/v1', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body: canonicalJson(request), signal, keepalive: request.op === 'close' }),
    transcriptProjection, options);
}
