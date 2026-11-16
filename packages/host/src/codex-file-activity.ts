import { createHash } from 'node:crypto';
import { canonicalJson } from '@agentui/contracts';
import { FILE_CHANGE_DETAIL_BYTES, FILE_CHANGE_LIMIT, FILE_CHANGE_PATH_BYTES, fileChangeDetailBytes, retainText } from '@agentui/contracts/conversation';
import type { FileChange, FileChangeActivity, FileChangeStatus, TranscriptEvent } from '@agentui/contracts/conversation';
import { object, nonempty } from './codec.js';

type Entry = { activity: FileChangeActivity; published: FileChangeActivity | null };
function changes(value: unknown): Pick<FileChangeActivity, 'changes' | 'omittedChanges'> {
  if (!Array.isArray(value)) throw new Error('Invalid Codex file changes');
  const retained: FileChange[] = [];
  let full = false;
  for (const raw of value) {
    const item = object(raw), kind = object(item.kind);
    if (typeof item.path !== 'string' || typeof item.diff !== 'string' ||
      (kind.type !== 'add' && kind.type !== 'delete' && kind.type !== 'update') ||
      (kind.type === 'update' && kind.move_path != null && typeof kind.move_path !== 'string')) throw new Error('Invalid Codex file change');
    if (full || retained.length === FILE_CHANGE_LIMIT) continue;
    const path = retainText(item.path, FILE_CHANGE_PATH_BYTES);
    const destination = kind.type === 'update' && typeof kind.move_path === 'string' ? retainText(kind.move_path, FILE_CHANGE_PATH_BYTES) : null;
    const base = { path: path.text, patch: '', detailsTruncated: path.truncated || (destination?.truncated ?? false), patchTruncated: false };
    const change: FileChange = kind.type === 'update'
      ? { ...base, operation: 'update', movedTo: destination?.text ?? null } : { ...base, operation: kind.type };
    const available = FILE_CHANGE_DETAIL_BYTES - fileChangeDetailBytes({ changes: [...retained, change], omittedChanges: value.length });
    if (available < 0) { full = true; continue; }
    const patch = retainText(item.diff, available);
    retained.push({ ...change, patch: patch.text, patchTruncated: patch.truncated });
  }
  return { changes: retained, omittedChanges: value.length - retained.length };
}
export function createFileActivity(runId: string, publish: (event: TranscriptEvent) => void) {
  const entries = new Map<string, Entry>();
  function observe(method: string, value: unknown): boolean {
    const params = object(value), patchOnly = method === 'item/fileChange/patchUpdated';
    const item = patchOnly ? params : object(params.item);
    if (!patchOnly && item.type !== 'fileChange') return false;
    const nativeId = nonempty(patchOnly ? item.itemId : item.id);
    const activityId = createHash('sha256').update(JSON.stringify([runId, nativeId])).digest('hex');
    const previous = entries.get(activityId);
    let status: FileChangeStatus;
    if (patchOnly) status = previous?.activity.status.kind ?? 'unknown';
    else switch (item.status) {
      case 'inProgress': status = 'running'; break;
      case 'completed': case 'failed': case 'declined': status = item.status; break;
      default: throw new Error('Invalid Codex file change status');
    }
    const terminal = previous && previous.activity.status.kind !== 'unknown' && previous.activity.status.kind !== 'running';
    if (terminal && (patchOnly || status === 'running')) return true;
    const activity: FileChangeActivity = { kind: 'file-change', activityId, runId, revision: previous?.activity.revision ?? 1,
      status: { kind: status }, ...changes(item.changes) };
    if (terminal && canonicalJson(previous.activity) !== canonicalJson(activity)) throw new Error('Contradictory Codex file change');
    entries.set(activityId, { activity, published: previous?.published ?? null });
    return true;
  }
  function flush(): void {
    for (const entry of entries.values()) {
      if (entry.published && canonicalJson(entry.activity) === canonicalJson(entry.published)) continue;
      const activity = { ...entry.activity, revision: (entry.published?.revision ?? 0) + 1 };
      publish({ kind: 'file-change-updated', activity });
      entry.activity = activity; entry.published = activity;
    }
  }
  return { observe, flush };
}
