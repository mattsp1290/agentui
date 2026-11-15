import { canonicalJson, parseCommand, parseScope, sameScope } from '@agentui/contracts';
import type { ConversationScope } from '@agentui/contracts';
import type { LocalRecords, OutboxEntry } from './types.js';

export function immutable<T>(value: T, visited = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !visited.has(value)) {
    visited.add(value);
    for (const child of Object.values(value)) immutable(child, visited);
    Object.freeze(value);
  }
  return value;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return value as Record<string, unknown>;
}
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Expected nonnegative safe integer');
  return value;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected string');
  return value;
}
export function copyCanonicalJson<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}
export function restore(value: unknown, scope: ConversationScope): LocalRecords {
  if (value === null) return immutable({ version: 1, scope, draft: '', draftRevision: 0, outbox: [] });
  const input = object(copyCanonicalJson(value));
  if (input.version !== 1) throw new Error('Unsupported local storage version');
  if (!sameScope(parseScope(input.scope), scope)) throw new Error('Local storage scope mismatch');
  if (!Array.isArray(input.outbox)) throw new Error('Invalid outbox');
  const ids = new Set<string>();
  const draftRevision = integer(input.draftRevision);
  const outbox: OutboxEntry[] = input.outbox.map(value => {
    const entry = object(value);
    const command = parseCommand(entry.command);
    if (!sameScope(command.scope, scope)) throw new Error('Outbox scope mismatch');
    if (ids.has(command.clientCommandId)) throw new Error('Duplicate outbox command ID');
    ids.add(command.clientCommandId);
    const revision = entry.draftRevision === null ? null : integer(entry.draftRevision);
    if (revision !== null && (revision > draftRevision || command.body.kind !== 'send')) throw new Error('Invalid captured draft revision');
    return { command, draftRevision: revision };
  });
  return immutable({ version: 1, scope, draft: string(input.draft), draftRevision, outbox });
}
