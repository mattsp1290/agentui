import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { record, identifier, count, hex } from '@agentui/contracts/decode';
import { SelectionRefusal, parseLiveRequest, parseSelectionQuery, parseSelectionCommand, parseOperationSummary, parseSelectionStatus, parseReceiptChunk } from './selection-protocol.js';
import type { SelectionControl, SelectionCommand, LiveRequest, SelectionQuery, OperationSummary, SelectionStatus, ReceiptChunk } from './selection-protocol.js';
import type { Access } from './access.js';
import type { FeedRegistry } from './feed-registry.js';
import { parseInvitationCode } from './native-wire.js';

export type ControlRequest = { readonly op: 'extensions-select'; readonly command: SelectionCommand }
  | { readonly op: 'extensions-apply' | 'extensions-retry'; readonly request: LiveRequest }
  | { readonly op: 'extensions-status'; readonly query: SelectionQuery | null }
  | { readonly op: 'extensions-receipt'; readonly digest: string; readonly offset: number }
  | { readonly op: 'invite' | 'invite-native' } | { readonly op: 'devices'; readonly after: string } | { readonly op: 'revoke'; readonly id: string };
type ControlValue = OperationSummary | SelectionStatus | ReceiptChunk | { readonly code: string } | { readonly hostId: string; readonly code: string } | ReturnType<Access['devices']> | null;
type ControlResponse = { readonly ok: true; readonly value: ControlValue } | { readonly ok: false; readonly error: string };
export function parseControlRequest(value: unknown): ControlRequest {
  const input = record(value);
  switch (input.op) {
    case 'invite': case 'invite-native': record(input, ['op']); return { op: input.op };
    case 'devices': {
      record(input, input.after === undefined ? ['op'] : ['op', 'after']);
      return { op: 'devices', after: input.after === undefined || input.after === '' ? '' : identifier(input.after) };
    }
    case 'extensions-select': record(input, ['op', 'command']); return { op: input.op, command: parseSelectionCommand(input.command) };
    case 'extensions-apply': case 'extensions-retry': {
      record(input, ['op', 'request']);
      const request = parseLiveRequest(input.request);
      if (input.op !== `extensions-${request.kind}`) throw new Error('Invalid selection request');
      return { op: input.op, request };
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
    case 'extensions-apply': case 'extensions-retry': case 'extensions-select': return { ok: true, value: parseOperationSummary(input.value) };
    case 'extensions-status': return { ok: true, value: parseSelectionStatus(input.value) };
    case 'extensions-receipt': return { ok: true, value: parseReceiptChunk(input.value) };
    case 'invite': return { ok: true, value: { code: identifier(record(input.value, ['code']).code) } };
    case 'invite-native': {
      const invitation = record(input.value, ['hostId', 'code']);
      return { ok: true, value: { hostId: identifier(invitation.hostId), code: parseInvitationCode(invitation.code) } };
    }
    case 'revoke': if (input.value !== null) throw new Error('Invalid revocation result'); return { ok: true, value: null };
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
function readLine(socket: Socket, limit: number): Promise<unknown> {
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
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); } catch (error) { reject(error); }
    };
    socket.on('data', data);
    socket.once('error', reject);
    socket.once('end', () => reject(new Error('Incomplete host control message')));
  });
}
export async function requestControl(path: string, request: ControlRequest): Promise<ControlResponse> {
  const line = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(line) > 4096) throw new Error('Host control message too large');
  const socket = createConnection(path);
  const response = readLine(socket, 16_000);
  socket.once('connect', () => socket.write(line));
  try { return parseControlResponse(request, await response); }
  finally { socket.destroy(); }
}
const refuseSelection = (): never => { throw new SelectionRefusal('ownership'); };
export const unavailableSelectionControl: SelectionControl = { select: refuseSelection, apply: refuseSelection, retry: refuseSelection, status: refuseSelection, receipt: refuseSelection };

export async function startControl(path: string, access: Access, feeds: FeedRegistry, isClosing: () => boolean, selection: SelectionControl) {
  if (existsSync(path)) unlinkSync(path);
  const server = createServer(socket => {
    void (async () => {
      try {
        const request = parseControlRequest(await readLine(socket, 4096));
        if (isClosing()) throw new Error('Host is shutting down');
        let value: ControlValue;
        switch (request.op) {
          case 'extensions-select': value = await selection.select(request.command); break;
          case 'extensions-apply': case 'extensions-retry': value = await (request.request.kind === 'apply' ? selection.apply(request.request) : selection.retry(request.request)); break;
          case 'extensions-status': value = selection.status(request.query ?? undefined); break;
          case 'extensions-receipt': value = selection.receipt(request.digest, request.offset); break;
          case 'invite': value = { code: access.invite('browser-development') }; break;
          case 'invite-native': value = { hostId: access.hostId, code: access.invite('native') }; break;
          case 'devices': value = access.devices(request.after); break;
          case 'revoke': access.revoke(request.id); feeds.closePrincipal(request.id); value = null; break;
        }
        socket.end(formatControlResponse({ ok: true, value }));
      } catch (error) { if (!socket.destroyed) socket.end(formatControlResponse({ ok: false, error: error instanceof SelectionRefusal ? error.message : 'Control operation refused' })); }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); chmodSync(path, 0o600); resolve(); });
  });
  return { close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
