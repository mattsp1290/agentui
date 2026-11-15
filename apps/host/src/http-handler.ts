import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseServiceRequest, SERVICE_MAX_REQUEST_BYTES, ServiceError } from '@agentui/contracts/service';
import type { Access } from './access.js';
import type { createApi } from './api.js';
import { json, readJson } from './framing.js';
import { writeServiceResult, writeServiceFailure } from './service-endpoint.js';
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
      if (options.isClosing()) throw new ServiceError('unavailable', 'Host is shutting down');
      const message = parseServiceRequest(await readJson(request, SERVICE_MAX_REQUEST_BYTES));
      if (message.op === 'pair') {
        if (options.isClosing()) throw new ServiceError('unavailable', 'Host is shutting down');
        try {
          const paired = options.access.pair(message.code, 'browser-development');
          response.setHeader('set-cookie', `${cookieName}=${paired.secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
          json(response, 200, { ok: true, value: null });
        } catch { throw new ServiceError('unauthorized', 'Pairing invitation is invalid or expired'); }
        return;
      }
      const cookies = request.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`)) ?? [];
      const principal = cookies.length === 1 ? options.access.authenticate(cookies[0]!.slice(cookieName.length + 1), 'browser-development') : null;
      if (!principal) throw new ServiceError('unauthorized', 'Pair this device with the host');
      await writeServiceResult(response, () => options.api(principal, message));
    } catch (error) {
      writeServiceFailure(response, error);
    }
  };
}
