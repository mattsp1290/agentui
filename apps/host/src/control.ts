import { createHash } from 'node:crypto';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { record, identifier, count, hex } from '@agentui/contracts/decode';
import { SelectionRefusal, parseLiveRequest, parseSelectionQuery, parseSelectionCommand, parseOperationSummary, parseSelectionStatus, parseReceiptChunk, chunkReceipt, RECEIPT_LIMIT, operationId } from './selection-protocol.js';
import type { SelectionControl, SelectionCommand, LiveRequest, SelectionQuery, OperationSummary, SelectionStatus, ReceiptChunk } from './selection-protocol.js';
import { parseRefreshReceipt, parseRefreshRequest, RefreshRefusal } from './refresh-jobs.js';
import type { RefreshController, RefreshRequest, RefreshReceipt } from './refresh-jobs.js';
import type { Access } from './access.js';
import type { FeedRegistry } from './feed-registry.js';
import { parseInvitationCode } from './native-wire.js';
import { isProviderUnavailableCause, providerUnavailableReasons } from '@agentui/host';
import type { ProviderStatus, ProviderUnavailableCause } from '@agentui/host';

const providerRefreshLimit = 100;
type ProviderRefreshStatus = { readonly contributionId: string; readonly namespace: string } &
  ({ readonly kind: 'available' } | { readonly kind: 'unavailable'; readonly cause: ProviderUnavailableCause });
type ProviderRefreshEntry = Exclude<ProviderRefreshStatus, { kind: 'unavailable' }> | (Extract<ProviderRefreshStatus, { kind: 'unavailable' }> & { readonly reason: string });
function refreshStatus(provider: ProviderStatus): ProviderRefreshStatus {
  const common = { contributionId: provider.contributionId, namespace: provider.instance.namespace };
  return provider.kind === 'available' ? { ...common, kind: 'available' } : { ...common, kind: 'unavailable', cause: provider.cause };
}
function parseRefreshEntry(value: unknown): ProviderRefreshEntry {
  const input = record(value), common = { contributionId: identifier(input.contributionId), namespace: identifier(input.namespace) };
  if (input.kind === 'available') { record(input, ['contributionId', 'namespace', 'kind']); return { ...common, kind: 'available' }; }
  record(input, ['contributionId', 'namespace', 'kind', 'cause']);
  if (input.kind !== 'unavailable' || !isProviderUnavailableCause(input.cause)) throw new Error('Invalid provider status');
  return { ...common, kind: 'unavailable', cause: input.cause, reason: providerUnavailableReasons[input.cause] };
}

export type ControlRequest = { readonly op: 'extensions-select'; readonly command: SelectionCommand }
  | { readonly op: 'extensions-live'; readonly request: LiveRequest }
  | { readonly op: 'extensions-status'; readonly query: SelectionQuery | null }
  | { readonly op: 'extensions-receipt'; readonly digest: string; readonly offset: number }
  | { readonly op: 'extensions-refresh-request'; readonly request: RefreshRequest }
  | { readonly op: 'extensions-refresh-status' | 'extensions-refresh-promote'; readonly id: string }
  | { readonly op: 'invite' | 'invite-native' | 'providers-refresh' } | { readonly op: 'devices'; readonly after: string } | { readonly op: 'revoke'; readonly id: string };
type ControlValue = readonly ProviderRefreshStatus[] | readonly ProviderRefreshEntry[] | OperationSummary | SelectionStatus | ReceiptChunk | RefreshReceipt | { readonly code: string } | { readonly hostId: string; readonly code: string } | ReturnType<Access['devices']> | null;
type ControlResponse = { readonly ok: true; readonly value: ControlValue } | { readonly ok: false; readonly error: string };
export function parseControlRequest(value: unknown): ControlRequest {
  const input = record(value);
  switch (input.op) {
    case 'invite': case 'invite-native': case 'providers-refresh': record(input, ['op']); return { op: input.op };
    case 'devices': {
      record(input, input.after === undefined ? ['op'] : ['op', 'after']);
      return { op: 'devices', after: input.after === undefined || input.after === '' ? '' : identifier(input.after) };
    }
    case 'extensions-refresh-request': record(input, ['op', 'request']); return { op: input.op, request: parseRefreshRequest(input.request) };
    case 'extensions-refresh-status': case 'extensions-refresh-promote': record(input, ['op', 'id']); return { op: input.op, id: operationId(input.id) };
    case 'extensions-select': record(input, ['op', 'command']); return { op: input.op, command: parseSelectionCommand(input.command) };
    case 'extensions-live': {
      record(input, ['op', 'request']);
      return { op: input.op, request: parseLiveRequest(input.request) };
    }
    case 'extensions-status': record(input, ['op', 'query']); return { op: input.op, query: input.query === null ? null : parseSelectionQuery(input.query) };
    case 'extensions-receipt': record(input, ['op', 'digest', 'offset']); return { op: input.op, digest: hex(input.digest, 64), offset: count(input.offset) };
    case 'revoke': record(input, ['op', 'id']); return { op: 'revoke', id: identifier(input.id) };
    default: throw new Error('Unknown control operation');
  }
}
function parseControlResponse(request: ControlRequest, value: unknown): ControlResponse {
  const input = record(value);
  if (input.ok === false) { record(input, ['ok', 'error']); return { ok: false, error: identifier(input.error) }; }
  record(input, ['ok', 'value']);
  if (input.ok !== true) throw new Error('Invalid control response');
  switch (request.op) {
    case 'extensions-refresh-request': case 'extensions-refresh-status': case 'extensions-refresh-promote': return { ok: true, value: parseRefreshReceipt(input.value) };
    case 'extensions-live': case 'extensions-select': return { ok: true, value: parseOperationSummary(input.value) };
    case 'extensions-status': return { ok: true, value: parseSelectionStatus(input.value) };
    case 'extensions-receipt': return { ok: true, value: parseReceiptChunk(input.value) };
    case 'invite': return { ok: true, value: { code: identifier(record(input.value, ['code']).code) } };
    case 'invite-native': {
      const invitation = record(input.value, ['hostId', 'code']);
      return { ok: true, value: { hostId: identifier(invitation.hostId), code: parseInvitationCode(invitation.code) } };
    }
    case 'revoke': if (input.value !== null) throw new Error('Invalid revocation result'); return { ok: true, value: null };
    case 'providers-refresh':
      if (!Array.isArray(input.value) || input.value.length > providerRefreshLimit) throw new Error('Invalid provider status');
      return { ok: true, value: input.value.map(parseRefreshEntry) };
    case 'devices': {
      if (!Array.isArray(input.value) || input.value.length > 100) throw new Error('Invalid device list');
      return { ok: true, value: input.value.map(value => {
        const device = record(value, ['id', 'revoked', 'expires', 'active']);
        if (typeof device.revoked !== 'boolean' || typeof device.active !== 'boolean') throw new Error('Invalid device status');
        return { id: identifier(device.id), revoked: device.revoked, expires: count(device.expires), active: device.active };
      }) };
    }
  }
}
export function formatControlResponse(response: ControlResponse): string {
  const line = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(line) > 16_000) throw new Error('Host control message too large');
  return line;
}
function readLine(socket: Socket, limit: number, requestFrame = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.setTimeout(5000, () => socket.destroy(new Error('Host control request timed out')));
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      chunks.push(chunk);
      if (bytes > limit) { socket.destroy(new Error('Host control message too large')); return; }
      if (!chunk.includes(10)) return;
      socket.off('data', data);
      socket.setTimeout(0);
      try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (requestFrame && bytes > requestLimit(value)) { socket.destroy(new Error('Host control message too large')); return; }
        resolve(value);
      } catch (error) {
        if (requestFrame && bytes > 4096) socket.destroy(new Error('Host control message too large'));
        else reject(error);
      }
    };
    socket.on('data', data);
    socket.once('error', reject);
    socket.once('end', () => reject(new Error('Incomplete host control message')));
  });
}
function isRefresh(request: ControlRequest): boolean {
  return request.op === 'extensions-refresh-request' || request.op === 'extensions-refresh-status' || request.op === 'extensions-refresh-promote';
}
function requestLimit(value: unknown): number {
  const { op } = record(value);
  return op === 'extensions-refresh-request' || op === 'extensions-refresh-status' || op === 'extensions-refresh-promote' ? 8192 : 4096;
}
async function readRefreshReceipt(socket: Socket): Promise<unknown> {
  socket.setTimeout(5000, () => socket.destroy(new Error('Host control request timed out')));
  let pending = Buffer.alloc(0), transfer: { digest: string; total: number; offset: number } | undefined;
  let refusal: { ok: false; error: string } | undefined;
  const chunks: Buffer[] = [];
  for await (const incoming of socket) {
    socket.setTimeout(5000);
    if (!Buffer.isBuffer(incoming)) throw new Error('Invalid host control bytes');
    let start = 0;
    while (start < incoming.length) {
      const newline = incoming.indexOf(10, start), end = newline < 0 ? incoming.length : newline + 1;
      if (pending.length + end - start > 16_000) throw new Error('Host control message too large');
      pending = Buffer.concat([pending, incoming.subarray(start, end)]); start = end;
      if (newline < 0) break;
      if (refusal || (transfer && transfer.offset === transfer.total)) throw new Error('Trailing refresh receipt frame');
      const value = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(pending)));
      pending = Buffer.alloc(0);
      if (value.ok === false && !transfer) {
        record(value, ['ok', 'error']); refusal = { ok: false, error: identifier(value.error) }; continue;
      }
      record(value, ['ok', 'value']);
      if (value.ok !== true) throw new Error('Invalid refresh receipt frame');
      const chunk = parseReceiptChunk(value.value);
      transfer ??= { digest: chunk.digest, total: chunk.total, offset: 0 };
      if (chunk.offset !== transfer.offset || chunk.digest !== transfer.digest || chunk.total !== transfer.total) throw new Error('Refresh receipt changed');
      chunks.push(Buffer.from(chunk.base64, 'base64')); transfer.offset = chunk.next;
    }
  }
  if (pending.length) throw new Error('Incomplete host control message');
  if (refusal) return refusal;
  if (!transfer || transfer.offset !== transfer.total) throw new Error('Incomplete refresh receipt');
  const bytes = Buffer.concat(chunks, transfer.total);
  if (createHash('sha256').update(bytes).digest('hex') !== transfer.digest) throw new Error('Refresh receipt digest mismatch');
  return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
}
async function sendRefreshReceipt(socket: Socket, receipt: RefreshReceipt): Promise<void> {
  if (socket.destroyed) return;
  const bytes = Buffer.from(JSON.stringify(receipt));
  if (bytes.length > RECEIPT_LIMIT) throw new SelectionRefusal('receipt-too-large');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const expire = () => socket.destroy(new Error('Host control transfer timed out'));
  let deadline = setTimeout(expire, 5000);
  socket.once('close', () => clearTimeout(deadline));
  for (let offset = 0; offset < bytes.length;) {
    if (socket.destroyed) return;
    const chunk = chunkReceipt(bytes, digest, offset);
    await new Promise<void>((resolve, reject) => socket.write(formatControlResponse({ ok: true, value: chunk }), error => error ? reject(error) : resolve()));
    offset = chunk.next;
    clearTimeout(deadline); deadline = setTimeout(expire, 5000);
  }
  socket.end();
}

export async function requestControl(path: string, request: ControlRequest): Promise<ControlResponse> {
  const line = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(line) > requestLimit(request)) throw new Error('Host control message too large');
  const socket = createConnection(path);
  const response = isRefresh(request) ? readRefreshReceipt(socket) : readLine(socket, 16_000);
  socket.once('connect', () => {
    if (request.op === 'extensions-live' || request.op === 'extensions-select' || request.op === 'providers-refresh' || request.op === 'extensions-refresh-request' || request.op === 'extensions-refresh-promote') socket.setTimeout(0);
    socket.write(line);
  });
  try { return parseControlResponse(request, await response); }
  finally { socket.destroy(); }
}
const refuseSelection = (): never => { throw new SelectionRefusal('ownership'); };
export const unavailableSelectionControl: SelectionControl = { select: refuseSelection, live: refuseSelection, status: refuseSelection, receipt: refuseSelection };

export async function startControl(path: string, access: Access, feeds: FeedRegistry, isClosing: () => boolean, selection: SelectionControl,
  refreshProviders: () => Promise<readonly ProviderStatus[]>, refresh?: Pick<RefreshController, 'request' | 'inspect' | 'promote'>) {
  if (existsSync(path)) unlinkSync(path);
  const server = createServer(socket => {
    void (async () => {
      try {
        const request = parseControlRequest(await readLine(socket, 8192, true));
        if (isClosing()) throw new Error('Host is shutting down');
        let value: ControlValue;
        switch (request.op) {
          case 'extensions-refresh-request': case 'extensions-refresh-status': case 'extensions-refresh-promote': {
            if (!refresh) throw new RefreshRefusal('unavailable');
            const receipt = await (request.op === 'extensions-refresh-request' ? refresh.request(request.request)
              : request.op === 'extensions-refresh-status' ? refresh.inspect(request.id) : refresh.promote(request.id));
            await sendRefreshReceipt(socket, receipt);
            return;
          }
          case 'extensions-select': value = await selection.select(request.command); break;
          case 'extensions-live': value = await selection.live(request.request); break;
          case 'extensions-status': value = selection.status(request.query ?? undefined); break;
          case 'extensions-receipt': value = selection.receipt(request.digest, request.offset); break;
          case 'invite': value = { code: access.invite('browser-development') }; break;
          case 'invite-native': value = { hostId: access.hostId, code: access.invite('native') }; break;
          case 'devices': value = access.devices(request.after); break;
          case 'revoke': access.revoke(request.id); feeds.closePrincipal(request.id); value = null; break;
          case 'providers-refresh': {
            const statuses = await refreshProviders();
            if (statuses.length > providerRefreshLimit) throw new Error('Too many providers');
            value = statuses.map(refreshStatus);
            break;
          }
        }
        socket.end(formatControlResponse({ ok: true, value }));
      } catch (error) { if (!socket.destroyed) socket.end(formatControlResponse({ ok: false, error: (error instanceof RefreshRefusal || error instanceof SelectionRefusal && error.reason !== 'invalid-artifact') ? error.message : 'Control operation refused' })); }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); chmodSync(path, 0o600); resolve(); });
  });
  return { close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
