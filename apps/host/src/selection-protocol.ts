import { isAbsolute, resolve } from 'node:path';
import { count, hex, identifier, record } from '@agentui/contracts/decode';
import type { ServerExtensionFailure, ServerExtensionReplacement } from '@agentui/host/extensions';

import type { ArtifactPin } from './provider-extensions.js';

export const RECEIPT_LIMIT = 16 * 1024 * 1024;
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
export type ApplyRequest = { readonly kind: 'apply'; readonly requestId: string; readonly selectionId: string; readonly expectedRevision: number };
export type RetryRequest = Omit<ApplyRequest, 'kind'> & { readonly kind: 'retry'; readonly afterAttemptId: string };
export type LiveRequest = ApplyRequest | RetryRequest;
export function parseLiveRequest(value: unknown): LiveRequest {
  const input = record(value);
  record(input, input.kind === 'retry' ? ['kind', 'requestId', 'selectionId', 'expectedRevision', 'afterAttemptId'] : ['kind', 'requestId', 'selectionId', 'expectedRevision']);
  const common = { requestId: operationId(input.requestId), selectionId: operationId(input.selectionId), expectedRevision: count(input.expectedRevision) };
  if (input.kind === 'apply') return { kind: 'apply', ...common };
  if (input.kind === 'retry') return { kind: 'retry', ...common, afterAttemptId: operationId(input.afterAttemptId) };
  throw new Error('Invalid selection request');
}
export type SelectionQuery = { readonly kind: 'selection' | 'attempt'; readonly id: string };
export function parseSelectionQuery(value: unknown): SelectionQuery {
  const input = record(value, ['kind', 'id']);
  if (input.kind !== 'selection' && input.kind !== 'attempt') throw new Error('Invalid selection query');
  return { kind: input.kind, id: operationId(input.id) };
}
export type AttemptOutcome = { readonly kind: 'pending' | 'applying' | 'applied' | 'applied-empty' | 'interrupted' | 'grant-mismatch' } | ServerExtensionFailure | Extract<ServerExtensionReplacement, { kind: 'deferred' }>;
export function parseAttemptOutcome(value: unknown): AttemptOutcome {
  const input = record(value);
  if (input.kind === 'deferred') {
    record(input, ['kind', 'reason']);
    if (input.reason === 'active-work' || input.reason === 'changing') return { kind: 'deferred', reason: input.reason };
  } else if (input.kind === 'failed') {
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
  readonly attemptId: string | null; readonly outcome: AttemptOutcome | { readonly kind: 'staged' | 'superseded' } };
export function parseOperationSummary(value: unknown): OperationSummary {
  const input = record(value, ['id', 'revision', 'receiptDigest', 'artifacts', 'attemptId', 'outcome']);
  const outcome = record(input.outcome);
  let parsed: OperationSummary['outcome'];
  if (outcome.kind === 'staged' || outcome.kind === 'superseded') {
    record(outcome, ['kind']); parsed = { kind: outcome.kind };
  } else parsed = parseAttemptOutcome(outcome);
  return { id: identifier(input.id, 96), revision: count(input.revision), receiptDigest: hex(input.receiptDigest, 64),
    artifacts: count(input.artifacts), attemptId: input.attemptId === null ? null : identifier(input.attemptId), outcome: parsed };
}
export type SelectionRuntime = { readonly kind: 'withheld' | 'closed' | 'uncertain' }
  | { readonly kind: 'active' | 'applied-empty'; readonly id: string; readonly revision: number; readonly attemptId: string };
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
    record(runtime, ['kind', 'id', 'revision', 'attemptId']);
    parsed = { kind: runtime.kind, id: identifier(runtime.id, 96), revision: count(runtime.revision), attemptId: identifier(runtime.attemptId) };
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

export interface SelectionControl {
  select(command: SelectionCommand): Promise<OperationSummary>;
  apply(request: ApplyRequest): Promise<OperationSummary>;
  retry(request: RetryRequest): Promise<OperationSummary>;
  status(query?: SelectionQuery): SelectionStatus;
  receipt(digest: string, offset: number): ReceiptChunk;
}
export class SelectionRefusal extends Error {
  constructor(reason: 'ownership' | 'unavailable' | 'id-conflict' | 'revision-conflict' | 'busy' | 'receipt-too-large' | 'unknown-operation' | 'unknown-receipt' | 'invalid-offset' | 'attempt-conflict' | 'uncertain') {
    super(reason === 'ownership' ? 'Selection requires durable artifact ownership' : `Selection ${reason}`);
  }
}
