import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { canonicalJson } from '@agentui/contracts';
import { SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';

export async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new Error('Request exceeds byte limit');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > limit) throw new Error('Request exceeds byte limit');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  return parsed;
}
export function json(response: ServerResponse, status: number, value: unknown, headers: OutgoingHttpHeaders = {}): void {
  const body = canonicalJson(value);
  if (Buffer.byteLength(body) > SERVICE_MAX_RESPONSE_BYTES) throw new Error('Response exceeds byte limit');
  if (response.destroyed) return;
  response.writeHead(status, { ...headers, 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}
