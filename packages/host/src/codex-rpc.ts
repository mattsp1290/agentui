import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export interface CodexRpcOptions {
  executable?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  cwd: string;
  onNotification: (method: string, params: unknown) => void;
  onRequest: (id: string | number, method: string, params: unknown) => void;
  onClose: (error: Error) => void;
}

interface Deferred<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

type Message =
  | { kind: 'notification'; method: string; params: unknown }
  | { kind: 'request'; id: string | number; method: string; params: unknown }
  | { kind: 'result'; id: string | number; result: unknown }
  | { kind: 'error'; id: string | number; message: string; code: number };

function isId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

function parseMessage(line: string): Message {
  const value: unknown = JSON.parse(line);
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
    ('jsonrpc' in value && value.jsonrpc !== '2.0')) throw new Error('Invalid Codex message');
  if ('method' in value) {
    if (typeof value.method !== 'string') throw new Error('Invalid Codex method');
    const params = 'params' in value ? value.params : undefined;
    if (!('id' in value)) return { kind: 'notification', method: value.method, params };
    if (!isId(value.id)) throw new Error('Invalid Codex request id');
    return { kind: 'request', id: value.id, method: value.method, params };
  }
  if (!('id' in value) || !isId(value.id) || ('result' in value) === ('error' in value)) {
    throw new Error('Invalid Codex response');
  }
  if ('result' in value) return { kind: 'result', id: value.id, result: value.result };
  if (!('error' in value) || value.error === null || typeof value.error !== 'object' ||
    !('message' in value.error) || typeof value.error.message !== 'string' ||
    !('code' in value.error) || typeof value.error.code !== 'number' || !Number.isSafeInteger(value.error.code)) {
    throw new Error('Invalid Codex error');
  }
  return { kind: 'error', id: value.id, message: value.error.message, code: value.error.code };
}

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class CodexRpc {
  readonly processId = randomUUID();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Deferred<unknown>>();
  private nextId = 1;
  private closed: Error | undefined;
  private decoder = new StringDecoder('utf8');
  private frame = '';
  private frameBytes = 0;
  private killTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: CodexRpcOptions) {
    this.child = spawn(options.executable ?? 'codex', options.args ?? ['app-server', '--stdio'], {
      cwd: options.cwd, stdio: 'pipe', shell: false, env: options.env ?? process.env,
    });
    this.child.stderr.resume();
    this.child.stderr.on('error', () => this.fail(new Error('Codex stderr stream failed')));
    this.child.stdin.on('error', () => this.fail(new Error('Codex input stream failed')));
    this.child.stdout.on('error', () => this.fail(new Error('Codex output stream failed')));
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    this.child.stdout.on('end', () => {
      if (this.frameBytes > 0 && !this.closed) this.deliverFrame();
    });
    this.child.on('error', () => this.fail(new Error('Codex process failed')));
    this.child.on('close', () => {
      if (this.killTimer) clearTimeout(this.killTimer);
      this.fail(new Error('Codex process closed'));
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex request timed out'));
      }, 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      void this.write({ id, method, params }).catch(error => this.fail(error));
    });
  }

  notify(method: string, params: unknown): void {
    void this.write({ method, params }).catch(error => this.fail(error));
  }

  respond(id: string | number, result: unknown): Promise<void> {
    return this.write({ id, result });
  }

  rejectRequest(id: string | number, message: string): void {
    void this.write({ id, error: { code: -32601, message } }).catch(error => this.fail(error));
  }

  close(): void {
    this.fail(new Error('Codex connection closed'));
  }

  private async write(message: unknown): Promise<void> {
    if (this.closed) throw this.closed;
    try {
      const line = `${JSON.stringify(message)}\n`;
      await new Promise<void>((resolve, reject) => {
        this.child.stdin.write(line, error => {
          if (error) reject(new Error('Codex input write failed'));
          else resolve();
        });
      });
    } catch {
      const error = this.closed ?? new Error('Codex input write failed');
      this.fail(error);
      throw error;
    }
  }

  private read(chunk: Buffer): void {
    if (this.closed) return;
    let start = 0;
    while (start < chunk.length && !this.closed) {
      const newline = chunk.indexOf(10, start);
      const end = newline === -1 ? chunk.length : newline;
      this.frameBytes += end - start;
      if (this.frameBytes > MAX_FRAME_BYTES) {
        this.fail(new Error('Codex message exceeds frame limit'));
        return;
      }
      this.frame += this.decoder.write(chunk.subarray(start, end));
      if (newline !== -1) this.deliverFrame();
      start = end + 1;
    }
  }

  private deliverFrame(): void {
    const line = this.frame + this.decoder.end();
    this.frame = '';
    this.frameBytes = 0;
    this.decoder = new StringDecoder('utf8');
    if (line.trim() === '') return;
    try {
      const message = parseMessage(line);
      if (message.kind === 'notification') this.options.onNotification(message.method, message.params);
      else if (message.kind === 'request') this.options.onRequest(message.id, message.method, message.params);
      else if (typeof message.id === 'number') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.kind === 'result') pending.resolve(message.result);
        else pending.reject(new CodexRpcError(message.code, message.message));
      }
    } catch {
      this.fail(new Error('Invalid Codex message or callback failure'));
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    this.frame = '';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    if (this.child.exitCode === null && this.child.signalCode === null && this.child.pid !== undefined) {
      this.child.kill('SIGTERM');
      this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 1_000);
      this.killTimer.unref();
    }
    try { this.options.onClose(error); }
    catch {}
  }
}
