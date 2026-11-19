import { createHash } from 'node:crypto';
import { canonicalJson } from '@agentui/contracts';
import type { BackendProvider, ConnectedProvider, ConversationRef, CreationIntent, CredentialHandle, ProviderCommand, ProviderCommandEffect,
  ProviderConversation, ProviderCursor, ProviderFeed, ProviderInstance, ProviderOutcome, ProviderSnapshot, ServerExtensionContext } from '@agentui/sdk';
import { COWORKERS_API_VERSION, COWORKERS_REQUEST_CONTRACT, CoworkersClient } from './client.js';
import type { CallResult } from './client.js';
import { bindingSchema, capText, coworkersPresentation, DEFAULT_MAX_PROMPT_BYTES, isTerminal, MAX_REQUESTS, STATE_BUDGET_BYTES, stateCursor } from './presentation.js';
import type { CoworkersModel, CoworkersRequest, CoworkersState } from './presentation.js';
import { createPoller } from './poller.js';
import type { PollHandle, Poller, PollResult } from './poller.js';

export interface CoworkersProviderOptions {
  readonly service: string;
  readonly instance: ProviderInstance<string>;
  /** One scheduler per installation. Tests pass one with a fake clock. */
  readonly poller?: Poller;
}
/** A lowercase v4-shaped UUID derived from its parts, so a retry of the same operation names the same upstream resource. */
export function derivedUuid(...parts: readonly string[]): string {
  const hex = createHash('sha256').update(parts.join('\0')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex[16]!, 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const uncertain = () => ({ kind: 'uncertain', reason: 'The Coworkers service did not confirm this operation.', evidence: null } as const);
const rejected = (reason: string) => ({ kind: 'rejected', reason, evidence: null } as const);
type Failure = { readonly kind: 'unavailable' | 'authentication-failed' | 'unauthorized' | 'version-unsupported'; readonly reason: string };
function failure(result: CallResult<unknown>): Failure {
  if (result.kind === 'http' && result.status === 401) return { kind: 'authentication-failed', reason: 'Coworkers rejected the credential.' };
  if (result.kind === 'invalid') return { kind: 'version-unsupported', reason: 'Coworkers returned an unexpected response.' };
  return { kind: 'unavailable', reason: 'Coworkers is offline or unreachable.' };
}

/** Registers one Coworkers provider under the grant id of the installation it serves. Replies arrive by polling. */
export function registerCoworkersProvider(context: ServerExtensionContext, id: string, options: CoworkersProviderOptions): void {
  const service = new URL(options.service);
  if (!['http:', 'https:'].includes(service.protocol) || service.username || service.password || service.pathname !== '/' ||
    service.search || service.hash) throw new Error('Coworkers requires a service origin');
  if (options.instance.protocolVersion !== '1') throw new Error('Unsupported Coworkers protocol version');
  const instance = Object.freeze({ ...options.instance });
  const limits = { maxPromptBytes: DEFAULT_MAX_PROMPT_BYTES };
  const presentation = coworkersPresentation(instance, limits);
  const provider: BackendProvider<CoworkersModel, string> = { apiVersion: 1, async connect(request) {
    if (request.apiVersion !== 1) return { kind: 'version-unsupported', reason: 'Unsupported provider contract.' };
    if (!request.credential || canonicalJson(request.instance) !== canonicalJson(instance) ||
      canonicalJson(request.credential.instance) !== canonicalJson(instance)) throw new Error('Coworkers installation is misconfigured');
    const credential: CredentialHandle<string> = request.credential;
    const poller = options.poller ?? createPoller();
    const pending = new Set<Promise<unknown>>(), feeds = new Set<{ close(): void; readonly ended: Promise<unknown> }>();
    const handles = new Map<string, Set<PollHandle>>();
    let closed = false;
    /**
     * Every HTTP call runs inside credentials.use behind the installation's in-flight limit. Results are values. A call
     * still queued behind the limit when the provider closes is dropped, so close never waits for it to reach the service.
     */
    function use<T>(action: (client: CoworkersClient) => Promise<CallResult<T>>): Promise<CallResult<T>> {
      if (closed) return Promise.resolve({ kind: 'transport' });
      const task = poller.limit(async (): Promise<CallResult<T>> => closed ? { kind: 'transport' } : context.credentials.use({ credential, service: service.origin },
        token => action(new CoworkersClient({ origin: service.origin, token })))).catch((): CallResult<T> => ({ kind: 'transport' }));
      pending.add(task);
      void task.finally(() => pending.delete(task));
      return task;
    }
    const probe = await use(client => client.capabilities());
    if (probe.kind !== 'ok') return failure(probe);
    if (probe.value.apiVersion !== COWORKERS_API_VERSION || probe.value.requestContract !== COWORKERS_REQUEST_CONTRACT) {
      return { kind: 'unsupported', reason: 'This Coworkers service uses an unsupported API contract.' };
    }
    limits.maxPromptBytes = probe.value.limits.maxPromptBytes;
    const conversationOf = (binding: ProviderConversation<string>) => binding.authority.binding.opaqueSessionId;
    function creation(operation: CreationIntent<string>): ProviderConversation<string> {
      if (operation.agent.kind !== 'agent' || canonicalJson(operation.agent.instance) !== canonicalJson(instance) ||
        !/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(operation.agent.opaqueId) || operation.from) throw new Error('Foreign coworker');
      return bindingSchema.parse({ kind: 'agentui-created', creation: operation, authority: { kind: 'remote-provider',
        binding: { namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: derivedUuid('conversation', operation.operationId) } } });
    }
    function validate(binding: ProviderConversation<string>) {
      if (canonicalJson(binding) !== canonicalJson(creation(binding.creation))) throw new Error('Foreign Coworkers conversation');
    }
    const runRef = (binding: ProviderConversation<string>, requestId: string): ConversationRef<string, 'run'> =>
      ({ binding, ref: { instance, kind: 'run', opaqueId: requestId } });
    async function open(operation: CreationIntent<string>, fresh: boolean): Promise<ProviderOutcome<ProviderConversation<string>>> {
      const binding = creation(operation);
      const result = await use(client => client.openConversation({ conversationId: conversationOf(binding), coworkerId: operation.agent.opaqueId }));
      if (result.kind === 'ok') {
        if (result.value.state.coworkerId !== operation.agent.opaqueId) return uncertain();
        return { kind: 'confirmed', value: binding, evidence: { conversationId: conversationOf(binding) } };
      }
      if (result.kind === 'http' && (result.status === 409 || (result.status === 404 && fresh) || result.status === 400)) return rejected('Coworkers refused this conversation.');
      return uncertain();
    }
    /**
     * One read of the conversation plus the receipts of requests whose status is not yet terminal. `progressing` is true
     * when some request is not terminal and its receipt could be read. A request the conversation lists but whose receipt
     * reads 404 keeps its last status, but cannot move on its own, so it does not keep the conversation on the one-second
     * active schedule.
     */
    async function build(binding: ProviderConversation<string>, previous: CoworkersState | null): Promise<{ kind: 'ok'; state: CoworkersState; progressing: boolean } | { kind: 'gone' } | { kind: 'failed' }> {
      const conversationId = conversationOf(binding);
      const read = await use(client => client.conversation(conversationId));
      if (read.kind === 'http' && read.status === 404) return { kind: 'gone' };
      if (read.kind !== 'ok') return { kind: 'failed' };
      const order: string[] = [], users = new Map<string, string>(), replies = new Map<string, string>();
      for (const message of read.value.messages) {
        if (!users.has(message.requestId) && !replies.has(message.requestId)) order.push(message.requestId);
        (message.role === 'user' ? users : replies).set(message.requestId, message.text);
      }
      const known = new Map((previous?.requests ?? []).map(request => [request.requestId, request]));
      const window = order.slice(-MAX_REQUESTS);
      const requests: CoworkersRequest[] = [];
      let progressing = false;
      for (const requestId of window) {
        const before = known.get(requestId), reply = replies.get(requestId);
        let status = before?.status ?? (reply !== undefined ? 'completed' : 'accepted');
        let assistantText = reply ?? before?.assistantText ?? null;
        // A stored terminal status is never fetched again, and a reply means completed. Every other request, the newest or
        // an older one without a reply, has its receipt fetched: it may still be running or may have failed.
        if (!isTerminal(status)) {
          const receipt = await use(client => client.receipt(conversationId, requestId));
          if (receipt.kind === 'ok') {
            status = receipt.value.status;
            assistantText = assistantText ?? receipt.value.result?.text ?? null;
            if (!isTerminal(status)) progressing = true;
          } else if (!(receipt.kind === 'http' && receipt.status === 404)) return { kind: 'failed' };
        }
        requests.push({ requestId, userText: capText(users.get(requestId) ?? ''), assistantText: assistantText === null ? null : capText(assistantText), status });
      }
      let truncated = read.value.truncated || order.length > MAX_REQUESTS || (previous?.truncated ?? false);
      const state = { binding: bindingSchema.parse(binding), requests, truncated };
      while (requests.length > 1 && Buffer.byteLength(canonicalJson(state)) > STATE_BUDGET_BYTES) { requests.shift(); truncated = true; }
      return { kind: 'ok', state: { ...state, truncated }, progressing };
    }
    function snapshotOf(binding: ProviderConversation<string>, state: CoworkersState): ProviderSnapshot<CoworkersModel, string> {
      const cursor: ProviderCursor<CoworkersModel, string> = { binding, kind: 'provider-cursor', opaque: stateCursor(state) };
      return { binding, cursor, projectionVersion: 1, state, decisions: [] };
    }
    function wake(binding: ProviderConversation<string>) {
      for (const handle of handles.get(conversationOf(binding)) ?? []) handle.wake();
    }
    async function command(operation: ProviderCommand<CoworkersModel, string>, fresh: boolean): Promise<ProviderOutcome<ProviderCommandEffect<string>>> {
      validate(operation.binding);
      const conversationId = conversationOf(operation.binding);
      if (operation.kind === 'decide') return rejected('Coworkers has no approvals.');
      if (operation.kind === 'cancel') {
        if (canonicalJson(operation.run.binding) !== canonicalJson(operation.binding)) throw new Error('Foreign Coworkers run');
        const requestId = operation.run.ref.opaqueId;
        const result = await use(client => fresh ? client.cancel(conversationId, requestId) : client.receipt(conversationId, requestId));
        wake(operation.binding);
        if (result.kind === 'ok') {
          if (!fresh && !result.value.cancellation && result.value.status !== 'cancelled') return uncertain();
          return { kind: 'confirmed', value: { kind: 'cancel', state: result.value.status === 'cancelled' ? 'completed' : 'accepted' }, evidence: { requestId, status: result.value.status } };
        }
        if (fresh && result.kind === 'http' && (result.status === 409 || result.status === 400)) return rejected('Coworkers refused to cancel this request.');
        return uncertain();
      }
      const requestId = derivedUuid('request', operation.operationId, operation.request.text);
      const result = await use(client => fresh ? client.submit(conversationId, { requestId, text: operation.request.text }) : client.receipt(conversationId, requestId));
      wake(operation.binding);
      if (result.kind === 'ok') {
        if (result.value.requestId !== requestId) return uncertain();
        return { kind: 'confirmed', value: { kind: 'send', run: runRef(operation.binding, requestId), state: isTerminal(result.value.status) ? 'completed' : 'accepted' },
          evidence: { requestId, status: result.value.status } };
      }
      if (fresh && result.kind === 'http') {
        if (result.code === 'queue_full') return rejected('This coworker already has the most queued requests it accepts. Wait for one to finish.');
        if (result.code === 'payload_too_large') return rejected('The message is too large for this coworker.');
        if (result.status === 409 || result.status === 400 || result.status === 401) return rejected('Coworkers refused this message.');
      }
      // A 404, a 503 retry_same_request or a lost reply leaves the outcome unknown: the first send can still commit.
      return uncertain();
    }
    const backend: ConnectedProvider<CoworkersModel, string> = { instance,
      capabilities: { create: { kind: 'supported' }, send: { kind: 'supported' }, cancel: { kind: 'supported' },
        decide: { kind: 'unsupported', reason: 'Coworkers has no approvals.' }, reconcile: { kind: 'supported' }, observe: { kind: 'supported' } },
      async discover() {
        const result = await use(client => client.coworkers());
        if (result.kind !== 'ok') return failure(result);
        return { kind: 'available', agents: result.value.coworkers.map(coworker => ({
          ref: { instance, kind: 'agent' as const, opaqueId: coworker.coworkerId },
          name: coworker.name.trim() && coworker.name.length <= 1024 ? coworker.name : coworker.coworkerId,
        })) };
      },
      create: operation => open(operation, true),
      reconcileCreation: operation => open(operation, false),
      submit: operation => command(operation, true),
      reconcileCommand: operation => command(operation, false),
      async snapshot(binding) {
        validate(binding);
        const built = await build(binding, null);
        return built.kind === 'ok' ? { kind: 'available', snapshot: snapshotOf(binding, built.state) } : { kind: 'unavailable', reason: 'Coworkers is offline or unreachable.' };
      },
      observe({ binding, after }, receive) {
        validate(binding);
        if (after && canonicalJson(after.binding) !== canonicalJson(binding)) throw new Error('Foreign Coworkers cursor');
        const conversationId = conversationOf(binding);
        let delivered = after?.opaque ?? null, acknowledged: ProviderCursor<CoworkersModel, string> | null = after, previous: CoworkersState | null = null, stopped = false;
        const ended = Promise.withResolvers<Awaited<ProviderFeed<CoworkersModel, string>['ended']>>();
        const finish = (kind: 'closed' | 'resync' | 'disconnected', reason: string) => {
          if (stopped) return;
          stopped = true; handle.stop();
          const own = handles.get(conversationId);
          own?.delete(handle);
          if (own?.size === 0) handles.delete(conversationId);
          feeds.delete(feed);
          ended.resolve({ kind, cursor: acknowledged, reason });
        };
        const handle = poller.schedule(async (): Promise<PollResult> => {
          const built = await build(binding, previous);
          if (stopped) return 'idle';
          if (built.kind === 'gone') { finish('resync', 'The Coworkers conversation is no longer available.'); return 'idle'; }
          if (built.kind === 'failed') return 'failed';
          previous = built.state;
          const snapshot = snapshotOf(binding, built.state);
          if (snapshot.cursor.opaque !== delivered) {
            try { await receive({ kind: 'snapshot', snapshot }); }
            catch { finish('disconnected', 'The host refused a Coworkers snapshot.'); return 'idle'; }
            if (stopped) return 'idle';
            delivered = snapshot.cursor.opaque; acknowledged = snapshot.cursor;
          }
          return built.progressing ? 'active' : 'idle';
        });
        const feed = { close: () => finish('closed', 'Closed by host.'), ended: ended.promise };
        feeds.add(feed);
        const set = handles.get(conversationId) ?? new Set<PollHandle>();
        set.add(handle); handles.set(conversationId, set);
        return feed;
      },
      async close() {
        closed = true;
        const active = [...feeds];
        active.forEach(feed => feed.close());
        await Promise.all(active.map(feed => feed.ended));
        await Promise.allSettled(pending);
      },
    };
    return { kind: 'connected', backend };
  } };
  context.providers.add(id, provider, presentation);
}
