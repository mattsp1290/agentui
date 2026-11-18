import { z } from 'zod';

/** The upstream revision this client and its schemas were written from. */
export const COWORKERS_REVISION = '44ed2ad8326a4822a67a3eeca4087cfc98f03df8';
export const COWORKERS_API_VERSION = '1';
export const COWORKERS_REQUEST_CONTRACT = 'sqlite-outbox-keyed-admission-v1';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const coworkerId = z.string().max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u);
export const requestStatusSchema = z.enum(['accepted', 'running', 'completed', 'cancellation_requested', 'cancelled', 'failed', 'uncertain']);
export type RequestStatus = z.infer<typeof requestStatusSchema>;
export const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set(['completed', 'cancelled', 'failed', 'uncertain']);
const failureReason = z.enum(['conversation_busy', 'timeout', 'interrupted', 'workspace_unavailable', 'store_unavailable', 'agent_unavailable',
  'cleanup_failed', 'model_failed', 'no_answer', 'invalid_request', 'configuration_changed', 'coworker_removed', 'process_stopped']);
export const capabilitiesSchema = z.object({ apiVersion: z.string(), requestContract: z.string(), backend: z.string(),
  limits: z.object({ maxPromptBytes: z.number().int().min(0), maxQueuedPerConversation: z.number().int().min(0),
    modelTurnSeconds: z.number().int().min(0), maxPageSize: z.number().int().min(0) }),
  statuses: z.array(requestStatusSchema), reasons: z.array(failureReason) });
export const coworkerSchema = z.object({ coworkerId, name: z.string(), role: z.string(), workspace: z.enum(['disabled', 'read_only', 'read_write']),
  slack: z.boolean(), instructions: z.object({ bytes: z.number().int().min(0), digest: z.string().regex(/^[0-9a-f]{64}$/u) }) });
export type Coworker = z.infer<typeof coworkerSchema>;
const coworkerListSchema = z.object({ apiVersion: z.literal('1'), coworkers: z.array(coworkerSchema) });
const stateSchema = z.object({ conversationId: uuid, coworkerId, phase: z.enum(['idle', 'running']) });
export const conversationSnapshotSchema = z.object({ apiVersion: z.literal('1'), state: stateSchema,
  messages: z.array(z.object({ requestId: uuid, role: z.enum(['user', 'assistant']), text: z.string() })), truncated: z.boolean() });
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
export const receiptSchema = z.object({ apiVersion: z.literal('1'), conversationId: uuid, requestId: uuid,
  acceptance: z.object({ boundary: z.literal('sqlite_outbox') }), status: requestStatusSchema,
  result: z.object({ text: z.string() }).optional(), reason: failureReason.optional(),
  cancellation: z.object({ requestedAt: z.string() }).optional() });
export type RequestReceipt = z.infer<typeof receiptSchema>;
const errorSchema = z.object({ error: z.string() });

/** HTTP and transport failures are values, not exceptions, so callers inside a credential action can classify them. */
export type CallResult<T> =
  | { readonly kind: 'ok'; readonly status: number; readonly value: T }
  | { readonly kind: 'http'; readonly status: number; readonly code: string }
  | { readonly kind: 'transport' }
  | { readonly kind: 'invalid' };

async function boundedText(response: Response): Promise<string | null> {
  const announced = Number(response.headers.get('content-length') ?? '0');
  if (announced > MAX_RESPONSE_BYTES) { await response.body?.cancel(); return null; }
  if (!response.body) return '';
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

/** A fetch client for the crabber-coworkers v1 API. It refuses redirects, bounds bodies and validates every success body. */
export class CoworkersClient {
  readonly #origin: string;
  readonly #token: string;
  constructor(options: { readonly origin: string; readonly token: string }) {
    this.#origin = options.origin.replace(/\/$/u, '');
    this.#token = options.token;
  }
  async #call<T>(method: 'GET' | 'POST', path: string, schema: z.ZodType<T>, body: unknown, signal: AbortSignal | undefined, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CallResult<T>> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let response: Response;
    try {
      response = await fetch(`${this.#origin}${path}`, { method, redirect: 'manual', signal: AbortSignal.any(signals),
        headers: { authorization: `Bearer ${this.#token}`, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { return { kind: 'transport' }; }
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); return { kind: 'invalid' }; }
    let text: string | null;
    try { text = await boundedText(response); } catch { return { kind: 'transport' }; }
    if (text === null) return { kind: 'invalid' };
    let json: unknown;
    try { json = text ? JSON.parse(text) : null; } catch { return response.ok ? { kind: 'invalid' } : { kind: 'http', status: response.status, code: 'unknown' }; }
    if (!response.ok) {
      const parsed = errorSchema.safeParse(json);
      return { kind: 'http', status: response.status, code: parsed.success ? parsed.data.error : 'unknown' };
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? { kind: 'ok', status: response.status, value: parsed.data } : { kind: 'invalid' };
  }
  capabilities(signal?: AbortSignal) { return this.#call('GET', '/v1/capabilities', capabilitiesSchema, undefined, signal); }
  health(signal?: AbortSignal) { return this.#call('GET', '/v1/health', z.unknown(), undefined, signal); }
  coworkers(signal?: AbortSignal) { return this.#call('GET', '/v1/coworkers', coworkerListSchema, undefined, signal); }
  conversations(signal?: AbortSignal) { return this.#call('GET', '/v1/conversations', z.unknown(), undefined, signal); }
  openConversation(input: { readonly conversationId: string; readonly coworkerId: string }, signal?: AbortSignal) {
    return this.#call('POST', '/v1/conversations', conversationSnapshotSchema, input, signal);
  }
  conversation(conversationId: string, signal?: AbortSignal) {
    return this.#call('GET', `/v1/conversations/${encodeURIComponent(conversationId)}`, conversationSnapshotSchema, undefined, signal);
  }
  submit(conversationId: string, input: { readonly requestId: string; readonly text: string }, signal?: AbortSignal) {
    return this.#call('POST', `/v1/conversations/${encodeURIComponent(conversationId)}/requests`, receiptSchema, input, signal);
  }
  receipt(conversationId: string, requestId: string, signal?: AbortSignal) {
    return this.#call('GET', `/v1/conversations/${encodeURIComponent(conversationId)}/requests/${encodeURIComponent(requestId)}`, receiptSchema, undefined, signal);
  }
  cancel(conversationId: string, requestId: string, signal?: AbortSignal) {
    return this.#call('POST', `/v1/conversations/${encodeURIComponent(conversationId)}/requests/${encodeURIComponent(requestId)}/cancel`, receiptSchema, {}, signal);
  }
}
