import type { IncomingMessage, ServerResponse } from 'node:http';
import { identifier, record } from '@agentui/contracts/decode';
import { parseServiceRequest, SERVICE_MAX_REQUEST_BYTES } from '@agentui/contracts/service';
import type { Access } from './access.js';
import type { createApi } from './api.js';
import { ServiceError } from '@agentui/contracts/service';
import { FAILURE_STATUS } from './errors.js';
import { json, readJson } from './framing.js';

export function nativeHandler(options: { readonly access: Access; readonly api: ReturnType<typeof createApi>;
  readonly isClosing: () => boolean }) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const headers = request.headersDistinct;
      if (request.method !== 'POST' || headers.host?.length !== 1 ||
        headers.host[0] !== `127.0.0.1:${request.socket.localPort}` ||
        headers['content-type']?.length !== 1 || headers['content-type'][0] !== 'application/json' ||
        headers.origin !== undefined || headers.cookie !== undefined) throw new Error('Invalid native request headers');
      if (options.isClosing()) throw new ServiceError('unavailable', 'Host is shutting down');
      if (request.url === '/native/v1/pair') {
        if (headers.authorization !== undefined) throw new Error('Unexpected authorization');
        const input = record(await readJson(request, 4096), ['version', 'hostId', 'code']);
        const hostId = identifier(input.hostId), code = identifier(input.code, 32);
        if (input.version !== 1 || !/^[A-Za-z0-9_-]{32}$/.test(code)) throw new Error('Invalid native pairing request');
        if (hostId !== options.access.hostId) throw new ServiceError('forbidden', 'Pairing host mismatch');
        if (options.isClosing()) throw new ServiceError('unavailable', 'Host is shutting down');
        try {
          const { principal, secret } = options.access.pair(code, 'native');
          json(response, 200, { ok: true, value: { hostId: principal.hostId, principalId: principal.id, secret } });
        } catch { throw new ServiceError('unauthorized', 'Pairing invitation is invalid or expired'); }
        return;
      }
      if (request.url !== '/native/v1') throw new Error('Invalid native path');
      const authorization = headers.authorization;
      if (authorization?.length !== 1 || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization[0]!)) {
        throw new ServiceError('unauthorized', 'Pair this device with the host');
      }
      const principal = options.access.authenticate(authorization[0]!.slice(7), 'native');
      if (!principal) throw new ServiceError('unauthorized', 'Pair this device with the host');
      const message = parseServiceRequest(await readJson(request, SERVICE_MAX_REQUEST_BYTES));
      if (message.op === 'pair') throw new Error('Pairing requires the native pairing route');
      try { json(response, 200, { ok: true, value: await options.api(principal, message) }); }
      catch (error) {
        if (error instanceof ServiceError) throw error;
        throw new ServiceError('unavailable', 'Host request did not complete');
      }
    } catch (error) {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      const kind = error instanceof ServiceError ? error.kind : 'invalid';
      const message = error instanceof ServiceError ? error.message : 'Invalid host request';
      json(response, FAILURE_STATUS[kind], { ok: false, error: { kind, message } });
    }
  };
}
