import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { parseServiceRequest, SERVICE_MAX_REQUEST_BYTES, ServiceError } from '@agentui/contracts/service';
import type { Access, Principal } from './access.js';
import type { createApi } from './api.js';
import { FAILURE_STATUS } from './errors.js';
import { json, readJson } from './framing.js';
import { serveAsset } from './static-assets.js';
import { DEVICE_SECRET, NATIVE_PAIR_MAX_REQUEST_BYTES, parseNativePairRequest } from './native-wire.js';
import type { NativeCredential } from './native-wire.js';

type Api = ReturnType<typeof createApi>;
type Reply = { readonly value: unknown; readonly headers: OutgoingHttpHeaders };
type EndpointOptions = {
  readonly access: Access;
  readonly api: Api;
  readonly isClosing: () => boolean;
} & (
  | { readonly credentialClass: 'browser-development'; readonly files: ReadonlyMap<string, Buffer> }
  | { readonly credentialClass: 'native' }
);
type Admission =
  | { readonly kind: 'pair'; readonly code: string }
  | { readonly kind: 'service'; readonly principal: Principal; readonly message: Parameters<Api>[1] };

function browserCookieName(hostId: string): string { return `agentui_device_${hostId}`; }

export function serviceEndpoint(options: EndpointOptions) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (options.credentialClass === 'browser-development') {
        const origin = `http://127.0.0.1:${request.socket.localPort}`;
        if (request.headers.host !== new URL(origin).host) throw new Error('Host mismatch');
        if (request.url !== '/api/v1') { serveAsset(options.files, request, response, origin); return; }
        if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') throw new Error('Origin or content type mismatch');
      } else {
        const headers = request.headersDistinct;
        if (request.method !== 'POST' || headers.host?.length !== 1 ||
          headers.host[0] !== `127.0.0.1:${request.socket.localPort}` ||
          headers['content-type']?.length !== 1 || headers['content-type'][0] !== 'application/json' ||
          headers.origin !== undefined || headers.cookie !== undefined) throw new Error('Invalid native request headers');
      }
      if (options.isClosing()) throw new ServiceError('unavailable', 'Host is shutting down');
      const admission = options.credentialClass === 'browser-development'
        ? await admitBrowser(request, options.access) : await admitNative(request, options.access);
      await writeServiceResult(response, async (): Promise<Reply> => {
        if (admission.kind === 'service') return { value: await options.api(admission.principal, admission.message), headers: {} };
        if (options.isClosing()) throw new ServiceError('unavailable', 'Host is shutting down');
        let paired: ReturnType<Access['pair']>;
        try { paired = options.access.pair(admission.code, options.credentialClass); }
        catch { throw new ServiceError('unauthorized', 'Pairing invitation is invalid or expired'); }
        if (options.credentialClass === 'browser-development') {
          return { value: null, headers: { 'set-cookie': `${browserCookieName(options.access.hostId)}=${paired.secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600` } };
        }
        return { value: { hostId: paired.principal.hostId, principalId: paired.principal.id, secret: paired.secret } satisfies NativeCredential, headers: {} };
      });
    } catch (error) {
      writeServiceFailure(response, error);
    }
  };
}

async function admitBrowser(request: IncomingMessage, access: Access): Promise<Admission> {
  const message = parseServiceRequest(await readJson(request, SERVICE_MAX_REQUEST_BYTES));
  if (message.op === 'pair') return { kind: 'pair', code: message.code };
  const cookieName = browserCookieName(access.hostId);
  const cookies = request.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`)) ?? [];
  const [cookie] = cookies;
  const principal = cookies.length === 1 && cookie !== undefined ? access.authenticate(cookie.slice(cookieName.length + 1), 'browser-development') : null;
  if (!principal) throw new ServiceError('unauthorized', 'Pair this device with the host');
  return { kind: 'service', principal, message };
}

async function admitNative(request: IncomingMessage, access: Access): Promise<Admission> {
  const headers = request.headersDistinct;
  if (request.url === '/native/v1/pair') {
    if (headers.authorization !== undefined) throw new Error('Unexpected authorization');
    const { hostId, code } = parseNativePairRequest(await readJson(request, NATIVE_PAIR_MAX_REQUEST_BYTES));
    if (hostId !== access.hostId) throw new ServiceError('forbidden', 'Pairing host mismatch');
    return { kind: 'pair', code };
  }
  if (request.url !== '/native/v1') throw new Error('Invalid native path');
  const authorization = headers.authorization;
  const [header] = authorization ?? [];
  const secret = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (authorization?.length !== 1 || secret === undefined || !DEVICE_SECRET.test(secret)) throw new ServiceError('unauthorized', 'Pair this device with the host');
  const principal = access.authenticate(secret, 'native');
  if (!principal) throw new ServiceError('unauthorized', 'Pair this device with the host');
  const message = parseServiceRequest(await readJson(request, SERVICE_MAX_REQUEST_BYTES));
  if (message.op === 'pair') throw new Error('Pairing requires the native pairing route');
  return { kind: 'service', principal, message };
}

async function writeServiceResult(response: ServerResponse, run: () => Promise<Reply>): Promise<void> {
  try { const { value, headers } = await run(); json(response, 200, { ok: true, value }, headers); }
  catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('unavailable', 'Host request did not complete');
  }
}

function writeServiceFailure(response: ServerResponse, error: unknown): void {
  if (response.headersSent || response.destroyed) { response.destroy(); return; }
  const kind = error instanceof ServiceError ? error.kind : 'invalid';
  const message = error instanceof ServiceError ? error.message : 'Invalid host request';
  json(response, FAILURE_STATUS[kind], { ok: false, error: { kind, message } });
}
