import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const requestId = z.string().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const reference = z.strictObject({ repository: z.string().min(1).max(4096),
  commit: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/u), subdirectory: z.string().min(1).max(4096).optional() });
export const operation = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('request'), id: requestId, reference, expectedSelectionRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }),
  z.strictObject({ kind: z.literal('status'), id: requestId }),
  z.strictObject({ kind: z.literal('promote'), id: requestId }),
]);
export const toolInput = z.strictObject({ operation });
type Operation = z.infer<typeof operation>;
const envelope = z.strictObject({ ok: z.literal(true), value: z.record(z.string(), z.json()) });
const identity = z.object({ job: z.object({ request: z.object({ id: requestId }) }) });
export type Outcome = { kind: 'receipt'; requestId: string; receipt: z.infer<typeof envelope>['value'] }
  | { kind: 'adapter-error'; requestId: string; reason: string };
export const failure = (id: string, reason: string): Outcome => ({ kind: 'adapter-error', requestId: id, reason });
export function canonicalOutput(bytes: Buffer, id: string): Outcome {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const result = envelope.parse(parsed);
  if (identity.parse(result.value).job.request.id !== id) throw new Error('Original request ID mismatch');
  return { kind: 'receipt', requestId: id, receipt: result.value };
}
export interface Startup {
  readonly executable: string;
  readonly installedEntry: string;
  readonly hostDirectory: string;
  readonly invocationDirectory: string;
  readonly waitMs: number;
}
const stdoutLimit = 16 * 1024 * 1024 + 21;
const stderrLimit = 64 * 1024;
const graceMs = 200, drainMs = 1000;
function missing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
function groupAbsent(pid: number): boolean {
  try { process.kill(-pid, 0); return false; }
  catch (error) { return error instanceof Error && 'code' in error && error.code === 'ESRCH'; }
}
function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch {}
}
function destroyPipes(child: ChildProcessWithoutNullStreams): void {
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
}
export class RefreshSession {
  private readonly abort = new AbortController();
  private readonly active = new Set<Promise<Outcome>>();
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private closing = false;
  private uncertain = false;
  constructor(private readonly startup: Startup) {}
  invoke(input: Operation, signal: AbortSignal): Promise<Outcome> {
    if (this.closing) return Promise.resolve(failure(input.id, 'closed'));
    if (this.active.size >= 3) return Promise.resolve(failure(input.id, 'busy'));
    const task = this.run(input, AbortSignal.any([signal, this.abort.signal]));
    this.active.add(task);
    void task.finally(() => this.active.delete(task)).catch(() => {});
    return task;
  }
  close(): Promise<boolean> {
    this.closing = true;
    this.abort.abort();
    return this.drain();
  }
  destroy(): void { for (const child of this.children) destroyPipes(child); }
  private async drain(): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(this.active).then(() => true),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), drainMs + graceMs + 200); }),
    ]);
    clearTimeout(timer);
    this.destroy();
    return drained && !this.uncertain && this.children.size === 0;
  }
  private async run(input: Operation, signal: AbortSignal): Promise<Outcome> {
    let directory: string | undefined, source: string | undefined;
    let cleanupAllowed = true;
    let result = failure(input.id, 'io');
    try {
      signal.throwIfAborted();
      if (input.kind === 'request') {
        directory = await mkdtemp(join(tmpdir(), 'agentui-mcp-refresh-'));
        signal.throwIfAborted();
        source = join(directory, 'source.json');
        await writeFile(source, JSON.stringify(input.reference), { flag: 'wx', mode: 0o600 });
        signal.throwIfAborted();
      }
      const args = ['--import', fileURLToPath(new URL('./cli-lifetime.js', import.meta.url)), this.startup.installedEntry,
        `extensions-refresh-${input.kind}`, '--data-dir', this.startup.hostDirectory, '--request', input.id];
      if (input.kind === 'request' && source) args.push('--source', source, '--expected-revision', String(input.expectedSelectionRevision));
      const child = spawn(this.startup.executable, args, { cwd: this.startup.invocationDirectory, detached: true,
        stdio: ['pipe', 'pipe', 'pipe'], env: { LANG: 'C', AGENTUI_REFRESH_WAIT_MS: String(this.startup.waitMs),
          ...(source ? { AGENTUI_REFRESH_SOURCE: source } : {}) } });
      cleanupAllowed = false;
      this.children.add(child);
      const collected = await this.collect(child, signal);
      cleanupAllowed = collected.closed;
      if (collected.absent) this.children.delete(child);
      else this.uncertain = true;
      if (collected.reason) result = failure(input.id, collected.reason);
      else {
        try { result = canonicalOutput(collected.bytes, input.id); }
        catch { result = failure(input.id, 'invalid-output'); }
      }
    } catch { result = failure(input.id, 'io'); }
    finally {
      if (directory && cleanupAllowed) {
        try {
          if (source) await unlink(source).catch(error => { if (!missing(error)) throw error; });
          await rmdir(directory).catch(error => { if (!missing(error)) throw error; });
        } catch { this.uncertain = true; result = failure(input.id, 'cleanup-unconfirmed'); }
      }
    }
    if (this.uncertain) return failure(input.id, 'cleanup-unconfirmed');
    return signal.aborted ? failure(input.id, 'cancelled') : result;
  }
  private collect(child: ChildProcessWithoutNullStreams, signal: AbortSignal): Promise<{ bytes: Buffer; reason: string; closed: boolean; absent: boolean }> {
    return new Promise(resolve => {
      const chunks: Buffer[] = [];
      let stdoutBytes = 0, stderrBytes = 0, reason = '', closed = false, settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined, finalTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(waitTimer); clearTimeout(killTimer); clearTimeout(finalTimer);
        signal.removeEventListener('abort', cancelled);
        const absent = child.pid === undefined || groupAbsent(child.pid);
        if (!closed || !absent) reason = 'cleanup-unconfirmed';
        destroyPipes(child);
        resolve({ bytes: Buffer.concat(chunks), reason, closed, absent });
      };
      const stop = (why: string) => {
        if (!reason) reason = why;
        if (finalTimer) return;
        signalGroup(child, 'SIGTERM');
        killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), graceMs);
        finalTimer = setTimeout(finish, drainMs);
      };
      const cancelled = () => stop('cancelled');
      const waitTimer = setTimeout(() => stop('timeout'), this.startup.waitMs);
      signal.addEventListener('abort', cancelled, { once: true });
      child.on('error', () => stop('spawn'));
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on('error', () => stop('io'));
      child.stdout.on('data', (bytes: Buffer) => {
        stdoutBytes += bytes.length;
        if (stdoutBytes > stdoutLimit) stop('output-limit');
        else chunks.push(bytes);
      });
      child.stderr.on('data', (bytes: Buffer) => { stderrBytes += bytes.length; if (stderrBytes > stderrLimit) stop('output-limit'); });
      child.on('exit', code => {
        if (code !== 0 && !reason) reason = 'cli-exit';
        if (!finalTimer) finalTimer = setTimeout(() => { finalTimer = undefined; stop(reason || 'inherited-pipes'); }, graceMs);
      });
      child.on('close', () => {
        closed = true;
        if (child.pid === undefined || groupAbsent(child.pid)) finish();
        else { clearTimeout(finalTimer); finalTimer = undefined; stop(reason || 'remaining-group'); }
      });
      if (signal.aborted) cancelled();
    });
  }
}
