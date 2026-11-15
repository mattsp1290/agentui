import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createCrewObserver } from '@birbcrew/client/agui';
import type { CrewClient } from '@birbcrew/client';
import type { BaseEvent } from '@ag-ui/core';
import type { ProviderConversation, ProviderFeed, ProviderItem, ProviderSnapshot } from '@agentui/sdk';
import { approvalKey, choiceLabels, cursorSchema, reference, remoteSchema, stateSchema } from './provider-model.js';
import type { CrewModel, CrewCursor, CrewState } from './provider-model.js';

const toolSchema = z.object({ id: z.string(), function: z.object({ name: z.string(), arguments: z.string().max(16384) }) });
const messagesFrame = z.object({ messages: z.array(z.object({ id: z.string(), role: z.string(),
  content: z.string().optional(), toolCalls: z.array(toolSchema).max(128).optional(), subagentRunId: z.string().optional() })).max(2048) });
const textFrame = z.object({ messageId: z.string(), delta: z.string().optional(), role: z.string().optional(),
  subagentRunId: z.string().optional() });
export function observation(binding: ProviderConversation<string>, memberId: string,
  use: <T>(action: (client: CrewClient, token: string) => Promise<T>) => Promise<T>, baseUrl: string,
  previous: CrewCursor | null) {
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
  function snapshot(nextCursor = cursor): ProviderSnapshot<CrewModel, string> {
    const cards = [...remote?.pendingApprovals ?? [], ...remote?.pendingQuestions ?? []];
    return { binding, projectionVersion: 1, cursor: { binding, kind: 'provider-cursor', opaque: cursorSchema.parse(nextCursor) },
      state: stateSchema.parse(state), decisions: cards.map(card => ({ ref: reference(binding, 'decision', approvalKey(card)),
        run: reference(binding, 'run', card.requestId), prompt: `${card.summary}\n${tools.get(card.approvalId)?.arguments ?? 'Action details unavailable. Deny or wait for a fresh snapshot.'}`,
        choices: [...card.choices, ...card.standingChoices ?? []].filter(choice => tools.has(card.approvalId) || choice === 'deny').map(choice => ({
          ref: reference(binding, 'choice', JSON.stringify([approvalKey(card), choice])), label: choiceLabels[choice] })) })) };
  }
  const enqueue = (action: () => Promise<void>) => {
    const task = tail.then(action);
    tail = task.catch(() => { closed = true; stop?.(); gate.resolve(); });
    return task;
  };
  async function refresh(client: CrewClient) {
    const requestId = cursor.requests.at(-1);
    if (!requestId) return;
    try {
      const receipt = await client.requestStatus({ conversationId: binding.authority.binding.opaqueSessionId, requestId },
        { signal: AbortSignal.timeout(10000) });
      state = { ...state, run: { requestId, status: receipt.status } };
    } catch { /* Missing or unavailable status is not proof of completion. */ }
  }
  async function publish() {
    if (closed || !receiver) return;
    const next = { ...cursor, sequence: cursor.sequence + 1 };
    const replacement = snapshot(next);
    await receiver({ kind: 'snapshot', snapshot: replacement });
    cursor = next; admitted = replacement.cursor;
  }
  async function reduce(event: BaseEvent, client: CrewClient) {
    if (closed) return;
    if (event.type === 'RUN_ERROR') throw new Error('Crew observation failed');
    if (event.type === 'STATE_DELTA') throw new Error('Crew state requires a fresh snapshot');
    if (event.type === 'MESSAGES_SNAPSHOT') {
      const messages = messagesFrame.parse(event).messages.filter(m => !m.subagentRunId && (m.role === 'user' || m.role === 'assistant'));
      state = { ...state, messages: messages.map(m => ({ messageId: m.id, role: m.role === 'user' ? 'user' : 'assistant',
        text: m.content ?? '', revision: 1, complete: true })) };
      const requests = messages.filter(m => m.role === 'user').map(m => z.uuid().parse(m.id));
      cursor = { ...cursor, requests: [...new Set([...cursor.requests, ...requests])] };
      for (const message of messages) for (const tool of message.toolCalls ?? []) tools.set(tool.id, tool.function);
      sawMessages = true;
    } else if (event.type === 'STATE_SNAPSHOT') {
      const next = remoteSchema.parse(z.object({ snapshot: z.unknown() }).parse(event).snapshot);
      if (next.memberId !== memberId || next.conversationId !== binding.authority.binding.opaqueSessionId ||
        [...next.pendingApprovals, ...next.pendingQuestions ?? []].some(card => card.memberId !== memberId ||
          card.conversationId !== next.conversationId || !cursor.requests.includes(card.requestId))) {
        throw new Error('Crew observation identity mismatch');
      }
      remote = next;
      await refresh(client);
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
    ready.resolve(snapshot());
    await gate.promise;
    await publish();
  }
  const lifetime = use(async (client, token) => {
    if (closed) return;
    const observer = createCrewObserver({ baseUrl, token, conversationId: binding.authority.binding.opaqueSessionId });
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
    stop = () => { observer.abortRun(); detaching ??= observer.detachActiveRun(); void detaching.catch(() => {}); };
    const subscription = observer.subscribe({ onEvent: ({ event }) => enqueue(() => reduce(event, client)) });
    const run = observer.runAgent();
    const poll = async () => {
      if (closed) return;
      try { await enqueue(async () => {
        if (state.run && !['completed', 'cancelled', 'failed'].includes(state.run.status)) { await refresh(client); await publish(); }
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
  function close() { endKind = 'closed'; closed = true; clearTimeout(timer); gate.resolve(); stop?.(); }
  return { ready: ready.promise, close, ended: completion.promise,
    attach(receive: (item: ProviderItem<CrewModel, string>) => Promise<void>) { receiver = receive; gate.resolve(); },
  };
}
