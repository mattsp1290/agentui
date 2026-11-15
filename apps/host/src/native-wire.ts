import { identifier, record } from '@agentui/contracts/decode';

export const INVITATION_CODE_BYTES = 24;
export const DEVICE_SECRET_BYTES = 32;
export const NATIVE_PAIR_MAX_REQUEST_BYTES = 4096;
const encodedPattern = (bytes: number): RegExp => new RegExp(`^[A-Za-z0-9_-]{${Math.ceil(bytes * 8 / 6)}}$`);
export const INVITATION_CODE = encodedPattern(INVITATION_CODE_BYTES);
export const DEVICE_SECRET = encodedPattern(DEVICE_SECRET_BYTES);

export interface NativePairRequest { readonly version: 1; readonly hostId: string; readonly code: string }
export interface NativeCredential { readonly hostId: string; readonly principalId: string; readonly secret: string }

export function parseInvitationCode(value: unknown): string {
  if (typeof value !== 'string' || !INVITATION_CODE.test(value)) throw new Error('Invalid pairing invitation code');
  return value;
}
export function parseNativePairRequest(value: unknown): NativePairRequest {
  const input = record(value, ['version', 'hostId', 'code']);
  if (input.version !== 1) throw new Error('Invalid native pairing request');
  return { version: 1, hostId: identifier(input.hostId), code: parseInvitationCode(input.code) };
}
export function parseNativeCredential(value: unknown): NativeCredential {
  const input = record(value, ['hostId', 'principalId', 'secret']);
  if (typeof input.secret !== 'string' || !DEVICE_SECRET.test(input.secret)) throw new Error('Invalid native credential');
  return { hostId: identifier(input.hostId), principalId: identifier(input.principalId), secret: input.secret };
}
