import { canonicalJson, parseCommand, parseScope, sameScope } from '@agentui/contracts';
import type { ConversationScope } from '@agentui/contracts';
import { exact, identifier, record } from '@agentui/contracts/decode';
import { IMAGE_MAX_BYTES, parseImageAttachment, parseImageName, parseUploadId } from '@agentui/contracts/image';
import type { FrontendRecoveryReference, ComposerImageRecord, LocalRecords, OutboxEntry } from './types.js';

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
function savedEntries(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getOwnPropertySymbols(value).length) throw new Error('Invalid saved entries');
  const entries: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const property = Object.getOwnPropertyDescriptor(value, String(index));
    if (!property || !('value' in property)) throw new Error('Invalid saved entry');
    entries.push(property.value);
  }
  return entries;
}
function composerImage(value: unknown): ComposerImageRecord | null {
  if (value === null) return null;
  const input = record(value, ['selectionId', 'uploadId', 'name', 'byteLength', 'attachment']);
  const name = parseImageName(input.name), byteLength = integer(input.byteLength);
  if (!byteLength || byteLength > IMAGE_MAX_BYTES) throw new Error('Invalid saved image size');
  const attachment = input.attachment === null ? null : parseImageAttachment(input.attachment);
  if (attachment && (attachment.name !== name || attachment.byteLength !== byteLength)) throw new Error('Saved image attachment mismatch');
  return { selectionId: identifier(input.selectionId), uploadId: parseUploadId(input.uploadId), name, byteLength, attachment };
}
export function restore(value: unknown, scope: ConversationScope): LocalRecords {
  if (value === null) return immutable({ version: 3, scope, draft: '', draftRevision: 0, outbox: [], image: null, frontendSends: [] });
  const input = record(value);
  if (input.version !== 1 && input.version !== 2 && input.version !== 3) throw new Error('Unsupported local storage version');
  if (input.version === 2 && (Object.hasOwn(input, 'frontendSends') || !Object.hasOwn(input, 'image'))) throw new Error('Unsupported private local storage format');
  exact(input, ['version', 'scope', 'draft', 'draftRevision', 'outbox', ...(input.version >= 2 ? ['image'] : []), ...(input.version === 3 ? ['frontendSends'] : [])]);
  if (!sameScope(parseScope(input.scope), scope)) throw new Error('Local storage scope mismatch');
  const ids = new Set<string>();
  const draftRevision = integer(input.draftRevision);
  const outbox: OutboxEntry[] = savedEntries(input.outbox).map(value => {
    const entry = record(value, ['command', 'draftRevision']);
    const command = parseCommand(copyCanonicalJson(entry.command));
    if (input.version !== 3 && (command.version !== 1 || (input.version === 1 && 'imageId' in command.body))) throw new Error('Unsupported saved command version for this local format');
    if (!sameScope(command.scope, scope)) throw new Error('Outbox scope mismatch');
    if (ids.has(command.clientCommandId)) throw new Error('Duplicate outbox command ID');
    ids.add(command.clientCommandId);
    const revision = entry.draftRevision === null ? null : integer(entry.draftRevision);
    if (revision !== null && (revision > draftRevision || command.body.kind !== 'send')) throw new Error('Invalid captured draft revision');
    return { command, draftRevision: revision };
  });
  const history = new Set<string>();
  const frontendSends: FrontendRecoveryReference[] = (input.version === 3 ? savedEntries(input.frontendSends) : []).map(value => {
    const entry = record(value, ['command', 'ownerId', 'state']), command = parseCommand(copyCanonicalJson(entry.command)), ownerId = string(copyCanonicalJson(entry.ownerId));
    if (command.version !== 2 || !sameScope(command.scope, scope) || !ownerId || history.has(command.clientCommandId)) throw new Error('Invalid frontend recovery identity');
    if (entry.state !== 'retained' && entry.state !== 'unavailable-pending' && entry.state !== 'unavailable-confirmed') throw new Error('Invalid frontend recovery state');
    const queued = outbox.find(item => item.command.clientCommandId === command.clientCommandId);
    if (queued && canonicalJson(queued.command) !== canonicalJson(command)) throw new Error('Frontend recovery command mismatch');
    history.add(command.clientCommandId);
    return { command, ownerId, state: entry.state };
  });
  if (outbox.some(entry => entry.command.version === 2 && !history.has(entry.command.clientCommandId))) throw new Error('Offered command has no recovery owner');
  const image = input.version === 1 ? null : composerImage(copyCanonicalJson(input.image));
  return immutable({ version: 3, scope, draft: string(copyCanonicalJson(input.draft)), draftRevision, outbox, image, frontendSends });
}
