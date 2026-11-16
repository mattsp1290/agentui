import { identifier, record, utf8Bytes } from './decode.js';
import { canonicalJson } from './durable.js';

export type PermissionScope = 'conversation' | 'agent';
export interface ConversationPermission {
  readonly permissionId: string;
  readonly scope: PermissionScope;
  readonly actionLabel: string;
  readonly detail: string;
}
export type ConversationPermissions =
  | { readonly kind: 'available'; readonly observedAt: string; readonly permissions: readonly ConversationPermission[] }
  | { readonly kind: 'unsupported' | 'unavailable'; readonly reason: string };

export function parsePermissionScope(value: unknown): PermissionScope {
  if (value !== 'conversation' && value !== 'agent') throw new Error('Invalid permission scope');
  return value;
}
export function parseConversationPermissions(value: unknown): ConversationPermissions {
  if (utf8Bytes(canonicalJson(value)) > 256_000) throw new Error('Permission listing exceeds limit');
  const input = record(value);
  if (input.kind === 'unsupported' || input.kind === 'unavailable') {
    record(input, ['kind', 'reason']);
    return { kind: input.kind, reason: identifier(input.reason) };
  }
  record(input, ['kind', 'observedAt', 'permissions']);
  if (input.kind !== 'available' || !Array.isArray(input.permissions) || input.permissions.length > 1000) throw new Error('Invalid permission listing');
  const observedAt = identifier(input.observedAt);
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid permission observation time');
  const ids = new Set<string>();
  const permissions = input.permissions.map(value => {
    const row = record(value, ['permissionId', 'scope', 'actionLabel', 'detail']);
    const permissionId = identifier(row.permissionId);
    if (ids.has(permissionId)) throw new Error('Duplicate permission');
    ids.add(permissionId);
    return { permissionId, scope: parsePermissionScope(row.scope), actionLabel: identifier(row.actionLabel), detail: identifier(row.detail) };
  });
  return { kind: 'available', observedAt, permissions };
}
