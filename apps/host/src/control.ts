import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { record, identifier, count } from '@agentui/contracts/decode';
import type { Access } from './access.js';
import type { FeedRegistry } from './feed-registry.js';

export type ControlRequest = { readonly op: 'invite' | 'invite-native' } | { readonly op: 'devices'; readonly after: string } | { readonly op: 'revoke'; readonly id: string };
type ControlValue = { readonly code: string } | { readonly hostId: string; readonly code: string } | ReturnType<Access['devices']> | null;
type ControlResponse = { readonly ok: true; readonly value: ControlValue } | { readonly ok: false; readonly error: string };
export function parseControlRequest(value: unknown): ControlRequest {
  const input = record(value);
  switch (input.op) {
    case 'invite': case 'invite-native': record(input, ['op']); return { op: input.op };
    case 'devices': {
      record(input, input.after === undefined ? ['op'] : ['op', 'after']);
      return { op: 'devices', after: input.after === undefined || input.after === '' ? '' : identifier(input.after) };
    }
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
    case 'invite': return { ok: true, value: { code: identifier(record(input.value, ['code']).code) } };
    case 'invite-native': {
      const invitation = record(input.value, ['hostId', 'code']);
      return { ok: true, value: { hostId: identifier(invitation.hostId), code: identifier(invitation.code, 32) } };
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
export function formatControlResponse(response: ControlResponse): string { return `${JSON.stringify(response)}\n`; }
function readLine(socket: Socket, limit: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let input = '';
    socket.setTimeout(5000, () => socket.destroy(new Error('Host control request timed out')));
    const data = (chunk: Buffer) => {
      input += chunk.toString('utf8');
      if (Buffer.byteLength(input) > limit) { socket.destroy(new Error('Host control message too large')); return; }
      if (!input.includes('\n')) return;
      socket.off('data', data);
      try { resolve(JSON.parse(input)); } catch (error) { reject(error); }
    };
    socket.on('data', data);
    socket.once('error', reject);
    socket.once('end', () => reject(new Error('Incomplete host control message')));
  });
}
export async function requestControl(path: string, request: ControlRequest): Promise<ControlResponse> {
  const socket = createConnection(path);
  const response = readLine(socket, 16_000);
  socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
  try { return parseControlResponse(request, await response); }
  finally { socket.destroy(); }
}
export async function startControl(path: string, access: Access, feeds: FeedRegistry, isClosing: () => boolean) {
  if (existsSync(path)) unlinkSync(path);
  const server = createServer(socket => {
    void (async () => {
      try {
        const request = parseControlRequest(await readLine(socket, 4096));
        if (isClosing()) throw new Error('Host is shutting down');
        let value: ControlValue;
        switch (request.op) {
          case 'invite': value = { code: access.invite('browser-development') }; break;
          case 'invite-native': value = { hostId: access.hostId, code: access.invite('native') }; break;
          case 'devices': value = access.devices(request.after); break;
          case 'revoke': access.revoke(request.id); feeds.closePrincipal(request.id); value = null; break;
        }
        socket.end(formatControlResponse({ ok: true, value }));
      } catch { if (!socket.destroyed) socket.end(formatControlResponse({ ok: false, error: 'Control operation refused' })); }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => { server.off('error', reject); chmodSync(path, 0o600); resolve(); });
  });
  return { close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
