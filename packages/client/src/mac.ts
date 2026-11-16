import { IMAGE_TRANSFER_MAX_BYTES } from '@agentui/contracts/image';
import { utf8Bytes } from '@agentui/contracts/decode';
import { record, identifier, count } from '@agentui/contracts/decode';
import { parseServiceRequest, ServiceError } from '@agentui/contracts/service';
import type { ServiceConnection, ServiceRequest } from '@agentui/contracts/service';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { createServiceConnection } from './service-engine.js';
import type { ServiceConnectionOptions } from './service-engine.js';

export type MacAccess =
  | { readonly kind: 'ready'; readonly observation: string; readonly hostId: string; readonly principalId: string }
  | { readonly kind: 'absent' | 'unreadable'; readonly observation: string };
type AccessCommand = { readonly kind: 'status' } | { readonly kind: 'restore' } | { readonly kind: 'pair'; readonly observation: string; readonly invitation: unknown }
  | { readonly kind: 'forget'; readonly observation: string };
export type MacNativeInvoke = (command: AccessCommand | {
  readonly kind: 'execute'; readonly observation: string; readonly request: ServiceRequest;
}) => Promise<unknown>;
const invalidResponse = 'Invalid native connection response. Update AgentUI, then reconnect. Local work is retained.';
function failure(cause: unknown): ServiceError {
  let reason: string;
  switch (cause) {
    case 'profile-in-use': reason = 'Close the other AgentUI instance before reconnecting.'; break;
    case 'pairing-failed': reason = 'Pairing failed. Request a fresh native invitation from the host.'; break;
    case 'invalid-input': reason = 'Invalid native invitation or request.'; break;
    case 'cancelled': reason = 'Pairing removal cancelled.'; break;
    case 'stale': reason = 'Native access changed. Reconnect before continuing.'; break;
    case 'network-failed': reason = 'The local host request did not complete. Reconnect or inspect command recovery before retrying.'; break;
    case 'forbidden': reason = 'Native access was refused. Open the installed AgentUI app, then reconnect.'; break;
    case 'profile-unavailable': reason = 'The local profile is unavailable. Check that AgentUI can access its local profile, then restart AgentUI. Local work is retained.'; break;
    case 'keychain-locked':
    case 'keychain-denied':
    case 'keychain-unavailable':
      reason = 'Restore Keychain access, then reconnect. Restart AgentUI if access stays unavailable. Pair again after expiry or revocation. Local work is retained.'; break;
    default: reason = 'Native connection unavailable. Reconnect, or restart AgentUI if the problem continues. Local work is retained.';
  }
  return new ServiceError('unavailable', reason);
}
export async function macAccess(command: AccessCommand, nativeInvoke: MacNativeInvoke): Promise<MacAccess> {
  let value: unknown;
  try { value = await nativeInvoke(command); } catch (cause) { throw failure(cause); }
  const input = record(value);
  const observation = identifier(input.observation);
  if (input.kind === 'ready') {
    record(value, ['kind', 'observation', 'hostId', 'principalId']);
    return { kind: 'ready', observation, hostId: identifier(input.hostId), principalId: identifier(input.principalId) };
  }
  record(value, ['kind', 'observation']);
  if (input.kind !== 'absent' && input.kind !== 'unreadable') throw new Error(invalidResponse);
  return { kind: input.kind, observation };
}
export function createMacConnection(access: MacAccess, nativeInvoke: MacNativeInvoke, options: ServiceConnectionOptions = {}): ServiceConnection {
  const connection = createServiceConnection(async (body, { op }) => {
    if (access.kind !== 'ready') throw new ServiceError('unauthorized', 'Pair this Mac with the local host.');
    let value: unknown;
    try { value = await nativeInvoke({ kind: 'execute', observation: access.observation, request: parseServiceRequest(JSON.parse(body)) }); }
    catch (cause) { throw failure(cause); }
    const reply = record(value, ['status', 'body']), status = count(reply.status);
    if (status < 200 || status > 599 || typeof reply.body !== 'string' || utf8Bytes(reply.body) > (op === 'image-upload' || op === 'image-read' ? IMAGE_TRANSFER_MAX_BYTES : 4_100_000)) throw new Error(invalidResponse);
    return new Response(reply.body, { status, headers: { 'Content-Type': 'application/json' } });
  }, transcriptProjection, options);
  return { ...connection, pair: async () => { throw new Error('Use native pairing controls to enroll this Mac.'); } };
}
