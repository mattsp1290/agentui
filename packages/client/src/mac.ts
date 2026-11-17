import { IMAGE_TRANSFER_MAX_BYTES } from '@agentui/contracts/image';
import { utf8Bytes } from '@agentui/contracts/decode';
import { record, identifier, count } from '@agentui/contracts/decode';
import { parseServiceRequest, ServiceError } from '@agentui/contracts/service';
import type { ServiceConnection, ServiceRequest } from '@agentui/contracts/service';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { createServiceConnection, ServiceConnectionLost } from './service-engine.js';
import type { ServiceConnectionOptions } from './service-engine.js';

export type MacAccess = { readonly observation: string };
export type MacNativeInvoke = (command: { readonly kind: 'connect' } | {
  readonly kind: 'execute'; readonly observation: string; readonly request: ServiceRequest;
}) => Promise<unknown>;
const invalidResponse = 'Invalid native connection response. Update AgentUI, then reconnect. Local work is retained.';
function failure(cause: unknown): ServiceError {
  let reason: string;
  switch (cause) {
    case 'profile-in-use': reason = 'Close the other AgentUI instance before reconnecting.'; break;
    case 'invalid-input': reason = 'Invalid native request.'; break;
    case 'stale': return new ServiceConnectionLost('The local host connection changed. Reconnect before continuing.');
    case 'host-changed': return new ServiceConnectionLost('A different AgentUI host is answering on this Mac. Reconnect to switch to it. Local work is retained.');
    case 'network-failed': reason = 'The local host request did not complete. Check that the host is running, then reconnect or inspect command recovery before retrying.'; break;
    case 'forbidden': reason = 'Native access was refused. Open the installed AgentUI app, then reconnect.'; break;
    case 'profile-unavailable': reason = 'The local profile is unavailable. Check that AgentUI can access its local profile, then restart AgentUI. Local work is retained.'; break;
    default: reason = 'Native connection unavailable. Reconnect, or restart AgentUI if the problem continues. Local work is retained.';
  }
  return new ServiceError('unavailable', reason);
}
export async function macConnect(nativeInvoke: MacNativeInvoke): Promise<MacAccess> {
  let value: unknown;
  try { value = await nativeInvoke({ kind: 'connect' }); } catch (cause) { throw failure(cause); }
  try {
    return { observation: identifier(record(value, ['observation']).observation) };
  } catch { throw new Error(invalidResponse); }
}
export function createMacConnection(access: MacAccess, nativeInvoke: MacNativeInvoke, options: ServiceConnectionOptions = {}): ServiceConnection {
  return createServiceConnection(async (body, { op }) => {
    let value: unknown;
    try { value = await nativeInvoke({ kind: 'execute', observation: access.observation, request: parseServiceRequest(JSON.parse(body)) }); }
    catch (cause) { throw failure(cause); }
    const reply = record(value, ['status', 'body']), status = count(reply.status);
    if (status < 200 || status > 599 || typeof reply.body !== 'string' || utf8Bytes(reply.body) > (op === 'image-upload' || op === 'image-read' ? IMAGE_TRANSFER_MAX_BYTES : 4_100_000)) throw new Error(invalidResponse);
    return new Response(reply.body, { status, headers: { 'Content-Type': 'application/json' } });
  }, transcriptProjection, options);
}
