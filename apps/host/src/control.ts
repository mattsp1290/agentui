import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { record, identifier, count, hex } from '@agentui/contracts/decode';
import { SelectionRefusal, parseLiveRequest, parseSelectionQuery, parseSelectionCommand, parseOperationSummary, parseSelectionStatus, parseReceiptChunk } from './selection-protocol.js';
import type { SelectionControl, SelectionCommand, LiveRequest, SelectionQuery, OperationSummary, SelectionStatus, ReceiptChunk } from './selection-protocol.js';
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
  | { readonly op: 'providers-refresh' };
type ControlValue = readonly ProviderRefreshStatus[] | readonly ProviderRefreshEntry[] | OperationSummary | SelectionStatus | ReceiptChunk;
type ControlResponse = { readonly ok: true; readonly value: ControlValue } | { readonly ok: false; readonly error: string };
export function parseControlRequest(value: unknown): ControlRequest {
  const input = record(value);
  switch (input.op) {
    case 'providers-refresh': record(input, ['op']); return { op: input.op };
    case 'extensions-select': record(input, ['op', 'command']); return { op: input.op, command: parseSelectionCommand(input.command) };
    case 'extensions-live': {
      record(input, ['op', 'request']);
      return { op: input.op, request: parseLiveRequest(input.request) };
    }
    case 'extensions-status': record(input, ['op', 'query']); return { op: input.op, query: input.query === null ? null : parseSelectionQuery(input.query) };
    case 'extensions-receipt': record(input, ['op', 'digest', 'offset']); return { op: input.op, digest: hex(input.digest, 64), offset: count(input.offset) };
    default: throw new Error('Unknown control operation');
  }
}
function parseControlResponse(request: ControlRequest, value: unknown): ControlResponse {
  const input = record(value);
  if (input.ok === false) { record(input, ['ok', 'error']); return { ok: false, error: identifier(input.error) }; }
  record(input, ['ok', 'value']);
  if (input.ok !== true) throw new Error('Invalid control response');
  switch (request.op) {
    case 'extensions-live': case 'extensions-select': return { ok: true, value: parseOperationSummary(input.value) };
    case 'extensions-status': return { ok: true, value: parseSelectionStatus(input.value) };
    case 'extensions-receipt': return { ok: true, value: parseReceiptChunk(input.value) };
    case 'providers-refresh':
      if (!Array.isArray(input.value) || input.value.length > providerRefreshLimit) throw new Error('Invalid provider status');
      return { ok: true, value: input.value.map(parseRefreshEntry) };
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
      socket.setTimeout(0);
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
  socket.once('connect', () => {
    if (request.op === 'extensions-live' || request.op === 'extensions-select' || request.op === 'providers-refresh') socket.setTimeout(0);
    socket.write(line);
  });
  try { return parseControlResponse(request, await response); }
  finally { socket.destroy(); }
}
const refuseSelection = (): never => { throw new SelectionRefusal('ownership'); };
export const unavailableSelectionControl: SelectionControl = { select: refuseSelection, live: refuseSelection, status: refuseSelection, receipt: refuseSelection };

export async function startControl(path: string, isClosing: () => boolean, selection: SelectionControl,
  refreshProviders: () => Promise<readonly ProviderStatus[]>) {
  if (existsSync(path)) unlinkSync(path);
  const server = createServer(socket => {
    void (async () => {
      try {
        const request = parseControlRequest(await readLine(socket, 4096));
        if (isClosing()) throw new Error('Host is shutting down');
        let value: ControlValue;
        switch (request.op) {
          case 'extensions-select': value = await selection.select(request.command); break;
          case 'extensions-live': value = await selection.live(request.request); break;
          case 'extensions-status': value = selection.status(request.query ?? undefined); break;
          case 'extensions-receipt': value = selection.receipt(request.digest, request.offset); break;
          case 'providers-refresh': {
            const statuses = await refreshProviders();
            if (statuses.length > providerRefreshLimit) throw new Error('Too many providers');
            value = statuses.map(refreshStatus);
            break;
          }
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
