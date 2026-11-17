import { IMAGE_BODY_TIMEOUT_MS, IMAGE_TRANSFER_MAX_BYTES } from '@agentui/contracts/image';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseServiceRequest, SERVICE_MAX_REQUEST_BYTES, ServiceError } from '@agentui/contracts/service';
import type { ServiceFailureKind } from '@agentui/contracts/service';
import type { Access } from './access.js';
import type { createApi } from './api.js';
import { FAILURE_STATUS } from './errors.js';
import { json, readJson } from './framing.js';
import { serveAsset } from './static-assets.js';
import type { HostObservability, RequestObservation } from './observability.js';

type Api = ReturnType<typeof createApi>;
type EndpointOptions = {
  readonly access: Access;
  readonly api: Api;
  readonly isClosing: () => boolean;
  readonly observability: HostObservability;
} & (
  | { readonly credentialClass: 'browser-development'; readonly files: ReadonlyMap<string, Buffer> }
  | { readonly credentialClass: 'native' }
);
type RequestResult = Pick<RequestObservation, 'operation' | 'outcome'>;

const imageIngress = new WeakSet<Access>();

export function serviceEndpoint(options: EndpointOptions) {
  async function imageRequest(request: IncomingMessage, response: ServerResponse): Promise<RequestResult> {
    const principal = options.access.owner(options.credentialClass);
    if (imageIngress.has(options.access)) throw new ServiceError('unavailable', 'Another image transfer is in progress. Try again.');
    imageIngress.add(options.access);
    let operation: RequestResult['operation'] = 'admission';
    try {
      const message = parseServiceRequest(await readJson(request, IMAGE_TRANSFER_MAX_BYTES, IMAGE_BODY_TIMEOUT_MS));
      if (message.op !== 'image-upload' && message.op !== 'image-read') throw new Error('Invalid image operation');
      operation = message.op;
      await writeServiceResult(response, () => options.api(principal, message), IMAGE_TRANSFER_MAX_BYTES);
      return { operation, outcome: 'ok' };
    } catch (error) {
      return { operation, outcome: writeServiceFailure(response, error) };
    } finally { imageIngress.delete(options.access); }
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<RequestResult> {
    if (options.credentialClass === 'browser-development') {
      const origin = browserOrigin(request);
      if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') throw new Error('Origin or content type mismatch');
    } else {
      const headers = request.headersDistinct;
      if (request.method !== 'POST' || headers.host?.length !== 1 ||
        headers.host[0] !== `127.0.0.1:${request.socket.localPort}` ||
        headers['content-type']?.length !== 1 || headers['content-type'][0] !== 'application/json' ||
        headers.origin !== undefined || headers.cookie !== undefined) throw new Error('Invalid native request headers');
    }
    if (options.isClosing()) throw new ServiceError('unavailable', 'Host is shutting down');
    if (request.url === (options.credentialClass === 'native' ? '/native/v1/images' : '/api/v1/images')) return imageRequest(request, response);
    if (options.credentialClass === 'native' && request.url !== '/native/v1') throw new Error('Invalid native path');
    const message = await admit(request);
    const operation = message.op, principal = options.access.owner(options.credentialClass);
    try {
      await writeServiceResult(response, () => options.api(principal, message));
      return { operation, outcome: 'ok' };
    } catch (error) {
      return { operation, outcome: writeServiceFailure(response, error) };
    }
  }
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (options.credentialClass === 'browser-development' && request.url !== '/api/v1' && request.url !== '/api/v1/images') {
      serveBrowserAsset(options.files, request, response);
      return;
    }
    const startTime = performance.timeOrigin + performance.now();
    const result = await handle(request, response).catch((error: unknown): RequestResult => ({ operation: 'admission', outcome: writeServiceFailure(response, error) }));
    options.observability.record({ ...result, credentialClass: options.credentialClass, startTime,
      statusCode: response.headersSent ? response.statusCode : null });
  };
}

function browserOrigin(request: IncomingMessage): string {
  const origin = `http://127.0.0.1:${request.socket.localPort}`;
  if (request.headers.host !== new URL(origin).host) throw new Error('Host mismatch');
  return origin;
}

function serveBrowserAsset(files: ReadonlyMap<string, Buffer>, request: IncomingMessage, response: ServerResponse): void {
  try { serveAsset(files, request, response, browserOrigin(request)); }
  catch (error) { writeServiceFailure(response, error); }
}

async function admit(request: IncomingMessage): Promise<Parameters<Api>[1]> {
  const message = parseServiceRequest(await readJson(request, SERVICE_MAX_REQUEST_BYTES));
  if (message.op === 'image-upload' || message.op === 'image-read') throw new Error('Images require the image route');
  return message;
}

async function writeServiceResult(response: ServerResponse, run: () => Promise<unknown>, limit?: number): Promise<void> {
  try { json(response, 200, { ok: true, value: await run() }, {}, limit); }
  catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('unavailable', 'Host request did not complete');
  }
}

function writeServiceFailure(response: ServerResponse, error: unknown): ServiceFailureKind {
  const kind = error instanceof ServiceError ? error.kind : 'invalid';
  if (response.headersSent || response.destroyed) { response.destroy(); return kind; }
  const message = error instanceof ServiceError ? error.message : 'Invalid host request';
  json(response, FAILURE_STATUS[kind], { ok: false, error: { kind, message } });
  return kind;
}
