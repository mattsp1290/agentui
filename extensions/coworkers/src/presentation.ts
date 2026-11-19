import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '@agentui/contracts';
import type { RunOutcome, Transcript, TranscriptMessage } from '@agentui/contracts/conversation';
import type { ProviderInstance, ProviderModel, ProviderPresentation } from '@agentui/sdk';
import { requestStatusSchema, TERMINAL_STATUSES } from './client.js';
import type { RequestStatus } from './client.js';

/** The newest requests the state keeps, the same window the service returns. */
export const MAX_REQUESTS = 100;
/**
 * The host bounds every decoded provider state and presented transcript at 1,000,000 bytes of canonical JSON
 * (packages/host/src/provider-stream.ts). Each stored text is capped at this many JSON-encoded bytes, and the state keeps
 * at most STATE_BUDGET_BYTES, dropping the oldest requests first.
 */
export const MAX_TEXT_BYTES = 4_000;
export const STATE_BUDGET_BYTES = 900_000;
export const TRUNCATION_MARKER = '\n… [truncated]';
export const DEFAULT_MAX_PROMPT_BYTES = 16 * 1024;
const id = z.string().min(1).max(1024);
const instanceSchema = z.strictObject({ namespace: id, installationId: id, generation: id, protocolVersion: id });
const scopeSchema = z.strictObject({ hostId: id, conversationId: id });
const sessionSchema = z.strictObject({ namespace: id, installationId: id, opaqueSessionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u) });
export const bindingSchema = z.strictObject({ kind: z.literal('agentui-created'),
  creation: z.strictObject({ kind: z.literal('create'), operationId: id, scope: scopeSchema,
    agent: z.strictObject({ instance: instanceSchema, kind: z.literal('agent'), opaqueId: z.string().max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u) }) }),
  authority: z.strictObject({ kind: z.literal('remote-provider'), binding: sessionSchema }) });
const requestSchema = z.strictObject({ requestId: z.string().min(1).max(64), userText: z.string(), assistantText: z.string().nullable(), status: requestStatusSchema });
const stateSchema = z.strictObject({ binding: bindingSchema, requests: z.array(requestSchema).max(MAX_REQUESTS), truncated: z.boolean() });
export type CoworkersRequest = z.infer<typeof requestSchema>;
export type CoworkersState = z.infer<typeof stateSchema>;
export interface CoworkersModel extends ProviderModel {
  readonly request: { readonly text: string };
  readonly cursor: string;
  readonly state: CoworkersState;
  readonly event: null;
}

const encodedBytes = (text: string) => Buffer.byteLength(JSON.stringify(text));
/** Caps a text at MAX_TEXT_BYTES of JSON-encoded bytes, with a visible marker. */
export function capText(text: string): string {
  if (encodedBytes(text) <= MAX_TEXT_BYTES) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encodedBytes(text.slice(0, middle) + TRUNCATION_MARKER) <= MAX_TEXT_BYTES) low = middle; else high = middle - 1;
  }
  return text.slice(0, low).replace(/[\uD800-\uDBFF]$/u, '') + TRUNCATION_MARKER;
}
/** The cursor is a SHA-256 of the canonical state, so it changes exactly when the delivered snapshot would. */
export function stateCursor(state: Pick<CoworkersState, 'requests' | 'truncated'>): string {
  return createHash('sha256').update(canonicalJson({ requests: state.requests, truncated: state.truncated })).digest('hex');
}
export function runOutcome(status: RequestStatus): RunOutcome | null {
  switch (status) {
    case 'completed': return 'completed';
    case 'cancelled': return 'interrupted';
    case 'failed': return 'failed';
    // The service lost track of the turn's result; a known failure would claim more than it knows.
    case 'uncertain': return 'connection-lost';
    default: return null;
  }
}
export function coworkersPresentation(instance: ProviderInstance<string>, limits: { maxPromptBytes: number }): ProviderPresentation<CoworkersModel, string> {
  return {
    instance,
    decodeRequest(value) {
      const parsed = z.strictObject({ text: z.string() }).parse(value);
      if (!parsed.text.trim() || parsed.text.includes('\0') || Buffer.byteLength(parsed.text) > limits.maxPromptBytes) throw new Error('Invalid coworker request');
      return parsed;
    },
    decodeCursor(value) {
      if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new Error('Invalid coworker cursor');
      return value;
    },
    decodeState: value => stateSchema.parse(value),
    decodeEvent() { throw new Error('Coworkers delivers snapshots only'); },
    request: text => ({ text }),
    snapshot(state, refs) {
      const messages: TranscriptMessage[] = [];
      if (state.truncated) messages.push({ messageId: 'coworkers:truncated', revision: 1, role: 'assistant', complete: true,
        text: 'Older turns are not shown. This conversation keeps the newest 100 requests.' });
      for (const request of state.requests) {
        messages.push({ messageId: `${request.requestId}:user`, revision: 1, role: 'user', text: request.userText, complete: true });
        if (request.assistantText !== null) messages.push({ messageId: `${request.requestId}:assistant`, revision: 1, role: 'assistant', text: request.assistantText, complete: true });
      }
      const last = state.requests.at(-1);
      let currentRun: Transcript['currentRun'] = null;
      if (last) {
        const runId = refs.run({ binding: state.binding, ref: { instance, kind: 'run', opaqueId: last.requestId } }).runId;
        const outcome = runOutcome(last.status);
        currentRun = outcome ? { kind: 'ended', runId, outcome } : { kind: 'running', runId };
      }
      return { messages, currentRun };
    },
    apply() { throw new Error('Coworkers delivers snapshots only'); },
  };
}
export const isTerminal = (status: RequestStatus) => TERMINAL_STATUSES.has(status);
