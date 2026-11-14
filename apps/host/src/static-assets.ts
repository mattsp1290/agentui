import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';

const TYPES: Readonly<Record<string, string>> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function serveAsset(files: ReadonlyMap<string, Buffer>, request: IncomingMessage, response: ServerResponse, origin: string): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') throw new Error('Unsupported method');
  const pathname = decodeURIComponent(new URL(request.url ?? '/', origin).pathname);
  const name = pathname === '/' ? 'browser.html' : pathname.slice(1);
  const bytes = files.get(name);
  if (!bytes) { response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); return; }
  response.writeHead(200, { 'content-type': TYPES[extname(name)] ?? 'application/octet-stream', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': CSP });
  response.end(request.method === 'HEAD' ? undefined : bytes);
}
