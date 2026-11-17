import { transcriptProjection } from '@agentui/contracts/conversation';
import type { ServiceConnection } from '@agentui/contracts/service';
import { createServiceConnection } from './service-engine.js';

export type { ServiceConnection, ServiceMetadata } from '@agentui/contracts/service';
export { ServiceError } from '@agentui/contracts/service';
export { ServiceConnectionLost, ServiceProtocolError } from './service-engine.js';
export interface BrowserConnectionOptions {
  readonly requestTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}
export function createBrowserConnection(options: BrowserConnectionOptions = {}): ServiceConnection {
  const fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  return createServiceConnection((body, { op, signal }) => fetch(op === 'image-upload' || op === 'image-read' ? '/api/v1/images' : '/api/v1', { method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' }, body, signal, keepalive: op === 'close' }),
    transcriptProjection, options);
}
