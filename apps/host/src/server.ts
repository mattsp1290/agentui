import { chmodSync, existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createControlServer } from 'node:net';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRecordedHost, recordedInstallation } from '@agentui/host/recorded';
import { parseServiceRequest, SERVICE_MAX_REQUEST_BYTES } from '@agentui/contracts/service';
import type { ServiceRequest } from '@agentui/contracts/service';
import type { ConversationScope } from '@agentui/contracts';
import { Access } from './access.js';
import type { Principal } from './access.js';
import { ownDirectory } from './ownership.js';
import { ServiceFeed } from './feeds.js';
import { json, readJson } from './framing.js';
import { readArtifact, readInstalledArtifact } from './artifact.js';

export interface BrowserHostOptions {
  readonly directory: string;
  readonly assetsDirectory: string;
  readonly port?: number;
  readonly progressMs?: number;
}
export async function startBrowserHost(options: BrowserHostOptions) {
  const owner = ownDirectory(options.directory);
  let access: Access | undefined;
  let host: ReturnType<typeof openRecordedHost> | undefined;
  const feeds = new Map<string, ServiceFeed>();
  let origin = '';
  try {
    const assets = realpathSync(options.assetsDirectory);
    readArtifact(assets, 'browser-development');
    const artifact = readInstalledArtifact(dirname(fileURLToPath(import.meta.url)));
    access = new Access(join(owner.directory, 'host.sqlite'));
    const activeAccess = access;
    host = openRecordedHost({ path: join(owner.directory, 'host.sqlite'), backendPath: join(owner.directory, 'recorded.jsonl'),
      hostId: access.hostId, ...(options.progressMs === undefined ? {} : { progressMs: options.progressMs }) });
    const activeHost = host;
    const authorizeScope = (principal: Principal, scope: ConversationScope) => {
      if (!activeAccess.authorized(principal, 'browser-development') || scope.hostId !== principal.hostId) throw new Unauthorized();
    };
    const service = async (principal: Principal, request: ServiceRequest): Promise<unknown> => {
      if (!activeAccess.authorized(principal, 'browser-development')) throw new Unauthorized();
      if ('scope' in request) authorizeScope(principal, request.scope);
      switch (request.op) {
        case 'pair': throw new Error('Pairing is handled before authentication');
        case 'metadata': return { hostId: principal.hostId, principalId: principal.id, compatibility: artifact.compatibility };
        case 'catalog': return activeHost.listConversations(principal.hostId, request.after, request.limit);
        case 'create': activeHost.createConversation(request.scope, recordedInstallation); return request.scope;
        case 'submit': {
          authorizeScope(principal, request.command.scope);
          return activeHost.conversation(request.command.scope).submit(request.command);
        }
        case 'receipt': return activeHost.conversation(request.scope).receipt(request.id);
        case 'reconcile': return activeHost.reconcile(request.scope, request.id);
        case 'watch': {
          if (feeds.size >= 100 || [...feeds.values()].filter(feed => feed.principalId === principal.id).length >= 16) throw new Error('Feed limit');
          const feed = new ServiceFeed(principal.id, request.scope);
          feeds.set(feed.id, feed);
          try { feed.attach(activeHost.conversation(request.scope).watch({ after: request.after, projectionVersion: request.projectionVersion }, item => feed.receive(item))); }
          catch (error) { feeds.delete(feed.id); throw error; }
          return { feedId: feed.id };
        }
        case 'pull': case 'close': {
          const feed = feeds.get(request.feedId);
          if (!feed || feed.principalId !== principal.id) throw new Error('Unknown observation');
          authorizeScope(principal, feed.scope);
          if (request.op === 'pull') return feed.pull(request.ack);
          feed.close(); feeds.delete(feed.id); return null;
        }
      }
    };
    const http = createServer((request, response) => { void handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) json(response, 400, { ok: false, error: { kind: 'invalid', message: 'Invalid host request' } });
      else response.destroy();
    }); });
    http.requestTimeout = 20_000;
    http.headersTimeout = 10_000;
    http.keepAliveTimeout = 5_000;
    http.maxConnections = 128;
    const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (request.headers.host !== new URL(origin).host) throw new Error('Host mismatch');
      if (request.url !== '/api/v1') {
        if (request.method !== 'GET' && request.method !== 'HEAD') throw new Error('Unsupported method');
        const pathname = decodeURIComponent(new URL(request.url ?? '/', origin).pathname);
        const file = resolve(assets, `.${pathname === '/' ? '/browser.html' : pathname}`);
        const resolved = realpathSync(file);
        const within = relative(assets, resolved);
        if (within.startsWith('..') || within === '' || within.startsWith('/')) throw new Error('Asset outside installed app');
        const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
        response.writeHead(200, { 'content-type': types[extname(resolved)] ?? 'application/octet-stream', 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" });
        response.end(request.method === 'HEAD' ? undefined : readFileSync(resolved));
        return;
      }
      if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') throw new Error('Origin or content type mismatch');
      const message = parseServiceRequest(await readJson(request, SERVICE_MAX_REQUEST_BYTES));
      if (message.op === 'pair') {
        try {
          const paired = activeAccess.pair(message.code, 'browser-development');
          response.setHeader('set-cookie', `agentui_device=${paired.secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
          json(response, 200, { ok: true, value: null });
        } catch { json(response, 401, { ok: false, error: { kind: 'unauthorized', message: 'Pairing invitation is invalid, expired or rate limited' } }); }
        return;
      }
      const cookies = request.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith('agentui_device=')) ?? [];
      const principal = cookies.length === 1 ? activeAccess.authenticate(cookies[0]!.slice('agentui_device='.length), 'browser-development') : null;
      if (!principal) { json(response, 401, { ok: false, error: { kind: 'unauthorized', message: 'Pair this device with the host' } }); return; }
      try {
        const value = await service(principal, message);
        if (!activeAccess.authorized(principal, 'browser-development')) throw new Unauthorized();
        json(response, 200, { ok: true, value });
      } catch (error) {
        json(response, error instanceof Unauthorized ? 401 : 400, { ok: false, error: {
          kind: error instanceof Unauthorized ? 'unauthorized' : 'invalid',
          message: error instanceof Unauthorized ? 'Device access was revoked or scope is unauthorized' : 'Host operation refused' } });
      }
    };
    await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(options.port ?? 7140, '127.0.0.1', () => { http.off('error', reject); resolve(); }); });
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Invalid host address');
    origin = `http://127.0.0.1:${address.port}`;
    const controlPath = join(owner.directory, 'control.sock');
    if (existsSync(controlPath)) unlinkSync(controlPath);
    const control = createControlServer(socket => {
      socket.setTimeout(5_000, () => socket.destroy());
      let input = '';
      socket.on('data', chunk => {
        input += chunk.toString('utf8');
        if (Buffer.byteLength(input) > 4096) { socket.destroy(); return; }
        if (!input.includes('\n')) return;
        socket.removeAllListeners('data');
        try {
          const request: unknown = JSON.parse(input);
          if (!request || typeof request !== 'object' || !('op' in request)) throw new Error('Invalid control request');
          let result;
          switch (request.op) {
            case 'invite': result = { code: activeAccess.invite('browser-development') }; break;
            case 'devices': {
              const after = 'after' in request ? request.after : '';
              if (typeof after !== 'string' || after.length > 1024) throw new Error('Invalid device cursor');
              result = activeAccess.devices(after); break;
            }
            case 'revoke': {
              if (!('id' in request) || typeof request.id !== 'string') throw new Error('Missing device id');
              activeAccess.revoke(request.id);
              for (const [id, feed] of feeds) if (feed.principalId === request.id) { feed.close(); feeds.delete(id); }
              result = null; break;
            }
            default: throw new Error('Unknown control operation');
          }
          socket.end(`${JSON.stringify({ ok: true, value: result })}\n`);
        } catch { socket.end(`${JSON.stringify({ ok: false, error: 'Control operation refused' })}\n`); }
      });
    });
    try { await new Promise<void>((resolve, reject) => { control.once('error', reject); control.listen(controlPath, () => { control.off('error', reject); chmodSync(controlPath, 0o600); resolve(); }); }); }
    catch (error) { http.closeAllConnections(); http.close(); throw error; }
    const sweep = setInterval(() => {
      for (const [id, feed] of feeds) if (Date.now() - feed.touched > 60_000) { feed.close(); feeds.delete(id); }
    }, 10_000);
    let closed = false;
    return { origin, hostId: activeAccess.hostId,
      async close() {
        if (closed) return;
        closed = true;
        clearInterval(sweep);
        for (const feed of feeds.values()) feed.close();
        feeds.clear();
        await Promise.all([new Promise<void>(done => { http.close(() => done()); http.closeIdleConnections(); }),
          new Promise<void>(done => control.close(() => done()))]);
        activeHost.close(); await activeHost.drained; activeAccess.close(); owner.close();
      },
    };
  } catch (error) { host?.close(); access?.close(); owner.close(); throw error; }
}
class Unauthorized extends Error {}
