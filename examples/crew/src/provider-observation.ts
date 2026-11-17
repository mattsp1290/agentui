import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createCrewObserver } from '@birbcrew/client/agui';
import type { CrewClient } from '@birbcrew/client';
import type { BaseEvent } from '@ag-ui/core';
import type { ProviderConversation, ProviderFeed, ProviderItem, ProviderSnapshot } from '@agentui/sdk';
import { approvalKey, choiceLabels, closureCause, cursorSchema, reference, remoteSchema, stateSchema } from './provider-model.js';
import type { CrewModel, CrewCursor, CrewState } from './provider-model.js';

const toolSchema = z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string().max(16384) }) });
const messagesFrame = z.object({ messages: z.array(z.object({ id: z.string(), role: z.string(),
  content: z.string().optional(), toolCalls: z.array(toolSchema).max(128).optional(), subagentRunId: z.string().optional() })).max(2048) });
const textFrame = z.object({ messageId: z.string(), delta: z.string().optional(), role: z.string().optional(),
  subagentRunId: z.string().optional() });
const workItemArguments = z.strictObject({ operation_id: z.uuid() });
const questionArguments = z.strictObject({});
const errorFrame = z.object({ code: z.string().optional() });
export function observation(binding: ProviderConversation<string>, memberId: string,
  use: <T>(action: (client: CrewClient, token: string) => Promise<T>) => Promise<T>, baseUrl: string,
  previous: CrewCursor | null, ownerDetails: boolean, standingPermissions: boolean) {
  let cursor: CrewCursor = { epoch: randomUUID(), sequence: 0, requests: previous?.requests ?? [] };
  let state: CrewState = { binding: stateSchema.shape.binding.parse(binding), messages: [], run: null };
  let remote: z.infer<typeof remoteSchema> | undefined;
  let sawMessages = false, closed = false;
  let endKind: 'closed' | 'disconnected' = 'disconnected';
  const tools = new Map<string, { name: string; arguments: string }>();
  let admitted: ProviderSnapshot<CrewModel, string>['cursor'] | null = null;
  let receiver: ((item: ProviderItem<CrewModel, string>) => Promise<void>) | undefined;
  const gate = Promise.withResolvers<void>(), ready = Promise.withResolvers<ProviderSnapshot<CrewModel, string>>();
  const completion = Promise.withResolvers<Awaited<ProviderFeed<CrewModel, string>['ended']>>();
  let stop: (() => void) | undefined;
  let tail = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const detailReads = new AbortController();
  async function snapshot(client: CrewClient): Promise<ProviderSnapshot<CrewModel, string>> {
    const cards = [...remote?.pendingApprovals ?? [], ...remote?.pendingQuestions ?? []];
    const decisions: ProviderSnapshot<CrewModel, string>['decisions'][number][] = [];
    for (const card of cards) {
      const tool = tools.get(card.approvalId);
      let complete = false, standing = false;
      let ownerPrompt: string | undefined;
      if (ownerDetails && card.toolName === 'record_work_item') {
        const detail = await client.approvalDetail({ conversationId: card.conversationId, memberId: card.memberId,
          requestId: card.requestId, invocationId: card.invocationId, approvalId: card.approvalId, version: card.version },
        { signal: AbortSignal.any([detailReads.signal, AbortSignal.timeout(10000)]) });
        ownerPrompt = `${detail.toolName}\n${JSON.stringify(detail.arguments, null, 2)}`;
        complete = true;
        standing = standingPermissions && remote?.pendingApprovals.includes(card) === true && card.policyVersion === 1 &&
          detail.policyVersion === 1 && card.invocationId === card.requestId && card.standingChoices?.includes('allow_conversation') === true;
      } else if (tool && tool.name === card.toolName) {
        try {
          const args: unknown = JSON.parse(tool.arguments);
          complete = card.toolName === 'choose_next_step' ? questionArguments.safeParse(args).success
            : card.toolName === 'record_work_item' && card.argumentsComplete === true &&
              workItemArguments.safeParse(args).data?.operation_id === card.requestId;
        } catch { /* Incomplete tool arguments cannot authorize a choice. */ }
      }
      const choices = card.choices.filter(choice => choice === 'deny' || complete &&
        (card.toolName === 'record_work_item' ? choice === 'approve' : choice === 'inspect' || choice === 'test'));
      if (standing) choices.push('allow_conversation');
      if (!choices.length) continue;
      const details = ownerPrompt ?? (complete ? tool?.arguments : 'Action details are incomplete. Crew may have redacted the proposed note. Only Deny is available.');
      decisions.push({ ref: reference(binding, 'decision', approvalKey(card)), run: reference(binding, 'run', card.requestId),
        prompt: `${card.summary}\n${details}${standing ? '\nApproving for this conversation approves this item and future owner-initiated, top-level work items, which may contain different notes. Changing the model or profile keeps this permission. Use Permissions to revoke it for later proposals. Already-approved work may finish.' : ''}`, choices: choices.map(choice => ({
          ref: reference(binding, 'choice', JSON.stringify([approvalKey(card), choice])), label: choiceLabels[choice] })) });
    }
    return { binding, projectionVersion: 1, cursor: { binding, kind: 'provider-cursor', opaque: cursorSchema.parse(cursor) },
      state: stateSchema.parse(state), decisions };
  }
  const enqueue = (action: () => Promise<void>) => {
    const task = tail.then(action);
    tail = task.catch(() => { closed = true; stop?.(); gate.resolve(); });
    return task;
  };
  async function refresh(client: CrewClient): Promise<boolean> {
    const requestId = cursor.requests.at(-1);
    if (!requestId) return true;
    try {
      const receipt = await client.requestStatus({ conversationId: binding.authority.binding.opaqueSessionId, requestId },
        { signal: AbortSignal.timeout(10000) });
      state = { ...state, run: { requestId, status: receipt.status,
        cancellation: receipt.cancellation ?? null } };
      return true;
    } catch { /* Missing or unavailable status is not proof of completion. */ return false; }
  }
  async function publish(snapshot: ProviderSnapshot<CrewModel, string>) {
    if (closed || !receiver) return;
    const next = { ...cursor, sequence: cursor.sequence + 1 };
    const replacement = { ...snapshot, cursor: { ...snapshot.cursor, opaque: cursorSchema.parse(next) } };
    await receiver({ kind: 'snapshot', snapshot: replacement });
    cursor = next; admitted = replacement.cursor;
  }
  async function reduce(event: BaseEvent, client: CrewClient) {
    if (closed) return;
    if (event.type === 'RUN_ERROR') {
      if (errorFrame.parse(event).code === 'MEMBER_FAILED' && state.closure?.cause === 'failed') return;
      throw new Error('Crew observation failed');
    }
    if (event.type === 'STATE_DELTA') throw new Error('Crew state requires a fresh snapshot');
    if (event.type === 'MESSAGES_SNAPSHOT') {
      const publicMessages = messagesFrame.parse(event).messages;
      tools.clear();
      for (const message of publicMessages) for (const tool of message.toolCalls ?? []) tools.set(tool.id, tool.function);
      const messages = publicMessages.filter(m => !m.subagentRunId && (m.role === 'user' || m.role === 'assistant'));
      state = { ...state, messages: messages.map(m => ({ messageId: m.id, role: m.role === 'user' ? 'user' : 'assistant',
        text: m.content ?? '', revision: 1, complete: true })) };
      const requests = messages.filter(m => m.role === 'user').map(m => z.uuid().parse(m.id));
      cursor = { ...cursor, requests: [...new Set([...cursor.requests, ...requests])] };
      sawMessages = true;
    } else if (event.type === 'STATE_SNAPSHOT') {
      const next = remoteSchema.parse(z.object({ snapshot: z.unknown() }).parse(event).snapshot);
      if (next.memberId !== memberId || next.conversationId !== binding.authority.binding.opaqueSessionId ||
        [...next.pendingApprovals, ...next.pendingQuestions ?? []].some(card => card.memberId !== memberId ||
          card.conversationId !== next.conversationId || !cursor.requests.includes(card.requestId))) {
        throw new Error('Crew observation identity mismatch');
      }
      remote = next;
      const read = await refresh(client);
      // A closure ends observation for good, so it must not freeze a run whose receipt could not be read.
      const cause = closureCause(next.phase);
      if (cause && read && !state.closure) state = { ...state, closure: { cause } };
    } else if (event.type === 'TOOL_CALL_START' || event.type === 'TOOL_CALL_ARGS') {
      const tool = z.object({ toolCallId: z.string(), toolCallName: z.string().optional(), delta: z.string().optional() }).parse(event);
      const current = tools.get(tool.toolCallId);
      const args = (current?.arguments ?? '') + (tool.delta ?? '');
      if (args.length > 16384 || tools.size > 2048) throw new Error('Crew tool details exceed limit');
      tools.set(tool.toolCallId, { name: tool.toolCallName ?? current?.name ?? '', arguments: args });
    } else if (['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END'].includes(event.type)) {
      const text = textFrame.parse(event);
      if (text.subagentRunId) return;
      const current = state.messages.find(message => message.messageId === text.messageId);
      const next = { messageId: text.messageId, role: 'assistant' as const, text: (current?.text ?? '') + (text.delta ?? ''),
        revision: (current?.revision ?? 0) + 1, complete: event.type === 'TEXT_MESSAGE_END' };
      state = { ...state, messages: current ? state.messages.map(message => message === current ? next : message) : [...state.messages, next] };
    } else return;
    if (!sawMessages || !remote) return;
    const replacement = await snapshot(client);
    if (closed) return;
    ready.resolve(replacement);
    await gate.promise;
    await publish(replacement);
  }
  const lifetime = use(async (client, token) => {
    if (closed) return;
    const from = binding.creation.from, target = binding.authority.binding.opaqueSessionId;
    // The successor's target was drawn by Crew, so Crew must attest it before this acquisition reads it.
    if (from) {
      const { incoming } = await client.handoff({ conversationId: target }, { signal: AbortSignal.timeout(10000) });
      if (!incoming || incoming.requestId !== binding.creation.operationId || incoming.source.conversationId !== from.binding.opaqueSessionId ||
        incoming.target.conversationId !== target || incoming.target.memberId !== memberId) throw new Error('Crew continuation is not attested');
      state = { ...state, handoff: { firstRequestId: incoming.firstRequestId } };
      if (closed) return;
    }
    const observer = createCrewObserver({ baseUrl, token, conversationId: target });
    observer.fetch = async (url, init) => {
      const response = await fetch(url, { ...init, redirect: 'error' });
      if (!response.body) return response;
      const reader = response.body.getReader();
      let bytes = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const part = await reader.read();
            if (part.done) { controller.close(); return; }
            bytes += part.value.byteLength;
            if (bytes > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('Crew observation byte limit reached. Restart the host.'); }
            controller.enqueue(part.value);
          } catch { controller.error(new Error('Crew observation transport ended')); }
        },
        cancel: reason => reader.cancel(reason),
      });
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    let detaching: Promise<void> | undefined;
    stop = () => { detailReads.abort(); observer.abortRun(); detaching ??= observer.detachActiveRun(); void detaching.catch(() => {}); };
    const subscription = observer.subscribe({ onEvent: ({ event }) => enqueue(() => reduce(event, client)) });
    const run = observer.runAgent();
    const poll = async () => {
      if (closed) return;
      try { await enqueue(async () => {
        if (state.run && !['completed', 'cancelled', 'failed'].includes(state.run.status)) { await refresh(client); await publish(await snapshot(client)); }
      }); } catch { return; }
      if (!closed) timer = setTimeout(() => { void poll(); }, 750);
    };
    timer = setTimeout(() => { void poll(); }, 750);
    try { await run; }
    finally {
      closed = true; gate.resolve(); clearTimeout(timer);
      stop(); await detaching?.catch(() => {}); await run.catch(() => {});
      await tail; subscription.unsubscribe();
    }
  });
  void lifetime.then(() => completion.resolve({ kind: endKind, cursor: admitted,
    reason: 'Crew observation ended' }), () => completion.resolve({ kind: endKind, cursor: admitted, reason: 'Crew observation unavailable' }))
    .finally(() => { ready.reject(new Error('Crew baseline unavailable')); });
  const timeout = setTimeout(() => { ready.reject(new Error('Crew baseline timed out')); close(); }, 15000);
  void ready.promise.then(() => clearTimeout(timeout), () => clearTimeout(timeout));
  function close() { endKind = 'closed'; closed = true; detailReads.abort(); clearTimeout(timer); gate.resolve(); stop?.(); }
  return { ready: ready.promise, close, ended: completion.promise,
    attach(receive: (item: ProviderItem<CrewModel, string>) => Promise<void>) { receiver = receive; gate.resolve(); },
  };
}
