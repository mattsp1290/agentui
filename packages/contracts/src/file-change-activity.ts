import { count, identifier, record, utf8Bytes } from './decode.js';
import { canonicalJson } from './durable.js';
import { escapedBytes } from './command-activity.js';

export const FILE_CHANGE_DETAIL_BYTES = 16_000;
export const FILE_CHANGE_PATH_BYTES = 1_000;
export const FILE_CHANGE_LIMIT = 16;
export type FileChangeStatus = 'unknown' | 'running' | 'completed' | 'failed' | 'declined';
export type FileChange = {
  readonly path: string;
  readonly patch: string;
  readonly detailsTruncated: boolean;
  readonly patchTruncated: boolean;
} & ({ readonly operation: 'add' | 'delete' } | { readonly operation: 'update'; readonly movedTo: string | null });
export interface FileChangeActivity {
  readonly kind: 'file-change';
  readonly activityId: string;
  readonly runId: string;
  readonly revision: number;
  readonly status: { readonly kind: FileChangeStatus };
  readonly changes: readonly FileChange[];
  readonly omittedChanges: number;
}
export function fileChangeDetailBytes(detail: Pick<FileChangeActivity, 'changes' | 'omittedChanges'>): number {
  return utf8Bytes(JSON.stringify({ changes: detail.changes, omittedChanges: detail.omittedChanges }));
}
function path(value: unknown): string {
  if (typeof value !== 'string' || escapedBytes(value) > FILE_CHANGE_PATH_BYTES) throw new Error('Invalid file change path');
  return value;
}
function parseChange(value: unknown): FileChange {
  const input = record(value);
  record(value, ['path', 'patch', 'detailsTruncated', 'patchTruncated', 'operation', ...(input.operation === 'update' ? ['movedTo'] : [])]);
  if (typeof input.patch !== 'string' || typeof input.detailsTruncated !== 'boolean' || typeof input.patchTruncated !== 'boolean') {
    throw new Error('Invalid file change details');
  }
  const detail = { path: path(input.path), patch: input.patch, detailsTruncated: input.detailsTruncated, patchTruncated: input.patchTruncated };
  if (input.operation === 'update') return { ...detail, operation: 'update', movedTo: input.movedTo === null ? null : path(input.movedTo) };
  if (input.operation === 'add' || input.operation === 'delete') return { ...detail, operation: input.operation };
  throw new Error('Invalid file change operation');
}
export function parseFileChangeActivity(value: unknown): FileChangeActivity {
  const input = record(value, ['kind', 'activityId', 'runId', 'revision', 'status', 'changes', 'omittedChanges']);
  const status = record(input.status, ['kind']);
  if (input.kind !== 'file-change' || (status.kind !== 'unknown' && status.kind !== 'running' && status.kind !== 'completed' &&
    status.kind !== 'failed' && status.kind !== 'declined')) throw new Error('Invalid file change activity');
  const revision = count(input.revision);
  if (revision < 1 || !Array.isArray(input.changes) || input.changes.length > FILE_CHANGE_LIMIT) throw new Error('Invalid file change collection');
  const detail = { changes: input.changes.map(parseChange), omittedChanges: count(input.omittedChanges) };
  if (fileChangeDetailBytes(detail) > FILE_CHANGE_DETAIL_BYTES) throw new Error('File change details exceed budget');
  return { kind: 'file-change', activityId: identifier(input.activityId), runId: identifier(input.runId), revision,
    status: { kind: status.kind }, ...detail };
}
export function validateFileChangeUpdate(previous: FileChangeActivity, next: FileChangeActivity): void {
  if (previous.status.kind !== 'unknown' && next.status.kind === 'unknown') throw new Error('File change status lost');
  if (previous.status.kind !== 'unknown' && previous.status.kind !== 'running' &&
    canonicalJson({ ...previous, revision: next.revision }) !== canonicalJson(next)) throw new Error('Terminal file change changed');
}
