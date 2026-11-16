import { isAbsolute, resolve } from 'node:path';
import { count, hex, identifier, record } from '@agentui/contracts/decode';
import type { ServerExtensionFailure } from '@agentui/host/extensions';

export const RECEIPT_LIMIT = 16 * 1024 * 1024;
export type ArtifactPin = { readonly directory: string; readonly artifactId: string };
export function operationId(value: unknown): string {
  const id = identifier(value, 96);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error('Invalid selection operation ID');
  return id;
}
export function parseSelection(value: unknown): { readonly version: 1; readonly artifacts: readonly ArtifactPin[] } {
  const input = record(value, ['version', 'artifacts']);
  if (input.version !== 1 || !Array.isArray(input.artifacts)) throw new Error('Invalid artifact selection');
  return { version: 1, artifacts: input.artifacts.map(value => {
    const pin = record(value, ['directory', 'artifactId']);
    if (typeof pin.directory !== 'string' || !isAbsolute(pin.directory) || pin.directory.includes('\0')) throw new Error('Invalid artifact directory');
    return { directory: resolve(pin.directory), artifactId: hex(pin.artifactId, 64) };
  }) };
}
export type SelectionCommand = { readonly id: string; readonly expectedRevision: number; readonly selection: ReturnType<typeof parseSelection> };
export function parseSelectionCommand(value: unknown): SelectionCommand {
  const input = record(value, ['id', 'expectedRevision', 'selection']);
  return { id: operationId(input.id), expectedRevision: count(input.expectedRevision), selection: parseSelection(input.selection) };
}
export type BootOutcome = { readonly kind: 'pending' | 'applying' | 'applied' | 'applied-empty' | 'interrupted' | 'grant-mismatch' } | ServerExtensionFailure;
export function parseBootOutcome(value: unknown): BootOutcome {
  const input = record(value);
  if (input.kind === 'failed') {
    record(input, ['kind', 'failure', 'recovery']);
    if (input.failure === 'cleanup' && input.recovery === 'restart') return { kind: 'failed', failure: 'cleanup', recovery: 'restart' };
    if ((input.failure === 'load' || input.failure === 'authorization' || input.failure === 'activation' || input.failure === 'discovery') && input.recovery === 'replace') {
      return { kind: 'failed', failure: input.failure, recovery: 'replace' };
    }
  } else {
    record(input, ['kind']);
    switch (input.kind) {
      case 'pending': case 'applying': case 'applied': case 'applied-empty': case 'interrupted': case 'grant-mismatch': return { kind: input.kind };
    }
  }
  throw new Error('Invalid selection outcome');
}
export type OperationSummary = { readonly id: string; readonly revision: number; readonly receiptDigest: string; readonly artifacts: number;
  readonly bootId: string | null; readonly outcome: BootOutcome | { readonly kind: 'staged' | 'superseded' } };
export function parseOperationSummary(value: unknown): OperationSummary {
  const input = record(value, ['id', 'revision', 'receiptDigest', 'artifacts', 'bootId', 'outcome']);
  const outcome = record(input.outcome);
  let parsed: OperationSummary['outcome'];
  if (outcome.kind === 'staged' || outcome.kind === 'superseded') {
    record(outcome, ['kind']); parsed = { kind: outcome.kind };
  } else parsed = parseBootOutcome(outcome);
  return { id: identifier(input.id, 96), revision: count(input.revision), receiptDigest: hex(input.receiptDigest, 64),
    artifacts: count(input.artifacts), bootId: input.bootId === null ? null : identifier(input.bootId), outcome: parsed };
}
export type SelectionRuntime = { readonly kind: 'withheld' | 'closed' | 'uncertain' }
  | { readonly kind: 'active' | 'applied-empty'; readonly id: string; readonly revision: number; readonly bootId: string };
export type SelectionStatus = { readonly kind: 'journal-invalid' } | { readonly kind: 'ready'; readonly desiredRevision: number;
  readonly desired: OperationSummary; readonly operation: OperationSummary; readonly lastApplied: OperationSummary | null; readonly runtime: SelectionRuntime };
export function parseSelectionStatus(value: unknown): SelectionStatus {
  const input = record(value);
  if (input.kind === 'journal-invalid') { record(input, ['kind']); return { kind: 'journal-invalid' }; }
  record(input, ['kind', 'desiredRevision', 'desired', 'operation', 'lastApplied', 'runtime']);
  if (input.kind !== 'ready') throw new Error('Invalid selection status');
  const runtime = record(input.runtime);
  let parsed: SelectionRuntime;
  if (runtime.kind === 'active' || runtime.kind === 'applied-empty') {
    record(runtime, ['kind', 'id', 'revision', 'bootId']);
    parsed = { kind: runtime.kind, id: identifier(runtime.id, 96), revision: count(runtime.revision), bootId: identifier(runtime.bootId) };
  } else {
    record(runtime, ['kind']);
    if (runtime.kind !== 'withheld' && runtime.kind !== 'closed' && runtime.kind !== 'uncertain') throw new Error('Invalid runtime');
    parsed = { kind: runtime.kind };
  }
  return { kind: 'ready', desiredRevision: count(input.desiredRevision), desired: parseOperationSummary(input.desired),
    operation: parseOperationSummary(input.operation), lastApplied: input.lastApplied === null ? null : parseOperationSummary(input.lastApplied), runtime: parsed };
}
export type ReceiptChunk = { readonly digest: string; readonly offset: number; readonly next: number; readonly total: number; readonly base64: string };
export function parseReceiptChunk(value: unknown): ReceiptChunk {
  const input = record(value, ['digest', 'offset', 'next', 'total', 'base64']);
  const offset = count(input.offset), next = count(input.next), total = count(input.total);
  if (total > RECEIPT_LIMIT || next > total || next <= offset || next - offset > 8192 || typeof input.base64 !== 'string' ||
    Buffer.from(input.base64, 'base64').toString('base64') !== input.base64 || Buffer.from(input.base64, 'base64').length !== next - offset) throw new Error('Invalid receipt chunk');
  return { digest: hex(input.digest, 64), offset, next, total, base64: input.base64 };
}
