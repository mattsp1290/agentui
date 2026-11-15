export type ApprovalDetails =
  | { readonly kind: 'command'; readonly command: string | null; readonly cwd: string | null }
  | { readonly kind: 'file'; readonly summary: string };
export function bounded(text: string, limit = 8_000): string {
  let end = 0, bytes = 0;
  for (const character of text) {
    bytes += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes > limit) return `${text.slice(0, end)}\n[Further details omitted]`;
    end += character.length;
  }
  return text;
}

function displayText(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.trim() ? bounded(value, limit) : null;
}

interface FileChangeDisplay {
  readonly path: string;
  readonly kind: 'add' | 'update' | 'delete' | null;
  readonly movedTo: string | null;
  readonly diff: string | null;
}

function fileChange(entry: unknown): FileChangeDisplay | null {
  if (entry === null || typeof entry !== 'object' || !('path' in entry)) return null;
  const path = displayText(entry.path, 2_000);
  if (!path) return null;
  const kind = 'kind' in entry ? entry.kind : null;
  const nativeKind = kind !== null && typeof kind === 'object' && 'type' in kind ? kind.type : null;
  return { path, kind: nativeKind === 'add' || nativeKind === 'update' || nativeKind === 'delete' ? nativeKind : null,
    movedTo: kind !== null && typeof kind === 'object' && 'move_path' in kind ? displayText(kind.move_path, 2_000) : null,
    diff: 'diff' in entry ? displayText(entry.diff, 2_000) : null };
}

function fileSummary(value: unknown): string {
  const missing = 'Codex did not provide file details.';
  if (!Array.isArray(value) || value.length === 0) return missing;
  let paths = '', patches = '';
  for (const entry of value) {
    const change = fileChange(entry);
    const detail = change ? `${change.path} (${change.kind ?? 'changed'})${change.movedTo ? ` → ${change.movedTo}` : ''}${change.kind ? '' : ` ${missing}`}` : missing;
    paths += `${paths ? '\n' : ''}${detail}`;
    if (change?.diff && bounded(patches, 4_000) === patches) {
      patches += `${patches ? '\n\n' : ''}${change.path}\n${change.diff}`;
    }
    if (bounded(paths, 4_000) !== paths) break;
  }
  return patches ? `${bounded(paths, 4_000)}\n\n${bounded(patches, 4_000)}` : bounded(paths, 4_000);
}

function cacheableId(value: unknown): value is string {
  return typeof value === 'string' && displayText(value, 4_000) === value;
}

export function approvalItem(item: Readonly<Record<string, unknown>>): readonly [string, ApprovalDetails] | null {
  if (!cacheableId(item.id)) return null;
  if (item.type === 'commandExecution') {
    const command = displayText(item.command, 8_000);
    const cwd = displayText(item.cwd, 2_000);
    return command || cwd ? [item.id, { kind: 'command', command, cwd }] : null;
  }
  if (item.type === 'fileChange') return [item.id, { kind: 'file', summary: fileSummary(item.changes) }];
  return null;
}

export function rememberApprovalItem(cache: Map<string, ApprovalDetails>, [id, details]: readonly [string, ApprovalDetails]): void {
  cache.delete(id);
  const oldest = cache.size >= 64 ? cache.keys().next().value : undefined;
  if (oldest !== undefined) cache.delete(oldest);
  cache.set(id, details);
}

export function approvalPrompt(kind: 'command' | 'file', params: Readonly<Record<string, unknown>>,
  details: ApprovalDetails | undefined, workspace: string): string {
  const reason = typeof params.reason === 'string' && params.reason ? `\n\n${bounded(params.reason, 2_000)}` : '';
  if (kind === 'command') {
    const stored = details?.kind === 'command' ? details : null;
    const command = displayText(params.command, 8_000) ?? stored?.command ?? null;
    const cwd = displayText(params.cwd, 2_000) ?? stored?.cwd ?? null;
    const directory = cwd ? `Working directory: ${cwd}` : `Workspace: ${workspace}`;
    return `${command ? `Run: ${command}` : 'Allow Codex to run a command?'}\n${directory}${reason}`;
  }
  const scope = typeof params.grantRoot === 'string'
    ? `Write access requested under: ${bounded(params.grantRoot, 2_000)}` : `Workspace: ${workspace}`;
  const files = details?.kind === 'file' ? details.summary : 'Codex did not provide file details.';
  return `Allow Codex to change files?\n${scope}\n\n${files}${reason}`;
}
