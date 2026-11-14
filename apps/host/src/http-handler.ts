import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseServiceRequest, SERVICE_MAX_REQUEST_BYTES } from '@agentui/contracts/service';
import type { Access } from './access.js';
import type { createApi } from './api.js';
import { HostFailure, FAILURE_STATUS } from './errors.js';
import { ObservationError } from './feeds.js';
import { json, readJson } from './framing.js';
import { serveAsset } from './static-assets.js';

export function browserHandler(options: { readonly access: Access; readonly api: ReturnType<typeof createApi>;
  readonly files: ReadonlyMap<string, Buffer>; readonly isClosing: () => boolean }) {
  const cookieName = `agentui_device_${options.access.hostId}`;
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const origin = `http://127.0.0.1:${request.socket.localPort}`;
      if (request.headers.host !== new URL(origin).host) throw new Error('Host mismatch');
      if (request.url !== '/api/v1') { serveAsset(options.files, request, response, origin); return; }
      if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') throw new Error('Origin or content type mismatch');
      if (options.isClosing()) throw new HostFailure('unavailable', 'Host is shutting down');
      const message = parseServiceRequest(await readJson(request, SERVICE_MAX_REQUEST_BYTES));
      if (options.isClosing()) throw new HostFailure('unavailable', 'Host is shutting down');
      if (message.op === 'pair') {
        try {
          const paired = options.access.pair(message.code, 'browser-development', Date.now(), request.socket.remoteAddress);
          response.setHeader('set-cookie', `${cookieName}=${paired.secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
          json(response, 200, { ok: true, value: null });
        } catch { throw new HostFailure('unauthorized', 'Pairing invitation is invalid, expired or rate limited'); }
        return;
      }
      const cookies = request.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`)) ?? [];
      const principal = cookies.length === 1 ? options.access.authenticate(cookies[0]!.slice(cookieName.length + 1), 'browser-development') : null;
      if (!principal) throw new HostFailure('unauthorized', 'Pair this device with the host');
      json(response, 200, { ok: true, value: await options.api(principal, message) });
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const kind = error instanceof HostFailure ? error.kind : 'invalid';
      const message = error instanceof HostFailure || error instanceof ObservationError ? error.message : 'Invalid host request';
      json(response, FAILURE_STATUS[kind], { ok: false, error: { kind, message } });
    }
  };
}
