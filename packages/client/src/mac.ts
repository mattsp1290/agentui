import { invoke } from '@tauri-apps/api/core';
import { record, identifier, count } from '@agentui/contracts/decode';
import { ServiceError } from '@agentui/contracts/service';
import type { ServiceConnection } from '@agentui/contracts/service';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { createServiceConnection } from './service-engine.js';
import type { ServiceConnectionOptions } from './service-engine.js';

export type MacAccess =
  | { readonly kind: 'ready'; readonly observation: string; readonly hostId: string; readonly principalId: string }
  | { readonly kind: 'absent' | 'unreadable'; readonly observation: string };
type AccessCommand = { readonly kind: 'status' } | { readonly kind: 'pair'; readonly observation: string; readonly invitation: unknown }
  | { readonly kind: 'forget'; readonly observation: string };
const recovery = 'Restore Keychain access, then reconnect. Restart AgentUI if access stays unavailable. Pair again after expiry or revocation. Local work is retained.';
function failure(cause: unknown): ServiceError {
  const reason = cause === 'profile-in-use' ? 'Close the other AgentUI instance before reconnecting.'
    : cause === 'pairing-failed' ? 'Pairing failed. Request a fresh native invitation from the host.'
      : cause === 'invalid-input' ? 'Invalid native invitation or request.'
        : cause === 'cancelled' ? 'Pairing removal cancelled.'
          : cause === 'stale' ? 'Native access changed. Reconnect before continuing.'
            : cause === 'network-failed' ? 'The local host request did not complete. Reconnect or inspect command recovery before retrying.' : recovery;
  return new ServiceError('unavailable', reason);
}
export async function macAccess(command: AccessCommand): Promise<MacAccess> {
  let value: unknown;
  try { value = await invoke('native_access', { command }); } catch (cause) { throw failure(cause); }
  const input = record(value);
  const observation = identifier(input.observation);
  if (input.kind === 'ready') {
    record(value, ['kind', 'observation', 'hostId', 'principalId']);
    return { kind: 'ready', observation, hostId: identifier(input.hostId), principalId: identifier(input.principalId) };
  }
  record(value, ['kind', 'observation']);
  if (input.kind !== 'absent' && input.kind !== 'unreadable') throw new Error(recovery);
  return { kind: input.kind, observation };
}
export function createMacConnection(access: MacAccess, options: ServiceConnectionOptions = {}): ServiceConnection {
  const connection = createServiceConnection(async body => {
    if (access.kind !== 'ready') throw new ServiceError('unauthorized', 'Pair this Mac with the local host.');
    let value: unknown;
    try { value = await invoke('native_access', { command: { kind: 'execute', observation: access.observation, request: JSON.parse(body) } }); }
    catch (cause) { throw failure(cause); }
    const reply = record(value, ['status', 'body']), status = count(reply.status);
    if (status < 200 || status > 599 || typeof reply.body !== 'string' || reply.body.length > 4_100_000) throw new Error(recovery);
    return new Response(reply.body, { status, headers: { 'Content-Type': 'application/json' } });
  }, transcriptProjection, options);
  return { ...connection, pair: async () => { throw new Error('Use native pairing controls to enroll this Mac.'); } };
}
