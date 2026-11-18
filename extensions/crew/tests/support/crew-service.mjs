import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { crewProvider } from '../../dist/provider.js';

/** The reply Crew's admitted handoff turn records for the successor's reserved first request. */
export const acknowledgement = 'I have read the earlier conversation.';

/**
 * A controlled Crew service over real HTTP. `intercept` may answer a conversation-scoped request before the default
 * routes; it returns true when it wrote the response. Handoff routes mirror Crew's handoff row: `replyHandoffs` queues
 * per-POST outcomes, `holdHandoffs` holds POSTs until released, `failHandoffLookups` fails the next handoff reads, and
 * `commitHandoff`/`admit` drive the row directly.
 */
export async function crewService(t, { memberId, token, instance, approvalDetails, standingGrants, subagents, decisionReceipts, intercept } = {}) {
  const calls = [], streams = new Set(), conversations = new Map(), receipts = new Map(), details = new Map();
  let detailHandler, grantHandler, revokeHandler;
  const grants = [];
  let lost = false, observationMode = 'stream', conflict = null, decisionReply = {}, receiptHold = null, receiptFailure = false;
  const handoffs = [], transcripts = new Map(), handoffReplies = [];
  let handoffLookupFailures = 0, handoffHold = null;
  // Mirrors Crew's handoff row: committing seals the source and opens the target; admission adds the reserved first turn.
  function commitHandoff(source, requestId) {
    const prior = handoffs.find(row => row.requestId === requestId);
    if (prior) return prior;
    const target = randomUUID(), firstRequestId = randomUUID();
    const transcript = `BirbCrew conversation handoff v1. The owner moved an earlier conversation with another coworker to you.\n${JSON.stringify({
      sourceEngine: 'codex', omittedTurns: 1, uncertainTurns: 0, turns: [{ ownerPrompt: 'Earlier owner prompt', modelReply: 'Earlier model reply' }] })}`;
    const row = { handoffId: randomUUID(), requestId, source: { conversationId: source, memberId, engine: 'codex' },
      target: { conversationId: target, memberId, engine: 'codex' }, firstRequestId, firstRequestAdmitted: false,
      carriedTurns: 1, omittedTurns: 1, uncertainTurns: 0, transcriptBytes: Buffer.byteLength(transcript),
      transcriptDigest: createHash('sha256').update(transcript).digest('hex'), createdAt: new Date().toISOString() };
    handoffs.push(row); transcripts.set(firstRequestId, transcript);
    conversations.set(target, { state: { conversationId: target, memberId, engine: 'codex', profile: 'test', phase: 'idle', openStep: null,
      pendingApprovals: [] }, messages: [], cursor: 0, openTools: {}, openText: null, childText: {} });
    return row;
  }
  function admit(target) {
    const row = handoffs.find(row => row.target.conversationId === target);
    if (row.firstRequestAdmitted) return;
    row.firstRequestAdmitted = true;
    conversations.get(target).messages.push({ id: row.firstRequestId, role: 'user', content: transcripts.get(row.firstRequestId) },
      { id: `${row.firstRequestId}/assistant`, role: 'assistant', content: acknowledgement });
    receipts.set(row.firstRequestId, { apiVersion: '1', conversationId: target, requestId: row.firstRequestId,
      acceptance: { boundary: 'sql_admission_and_temporal_queue' }, status: 'accepted' });
  }
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    let text = ''; for await (const chunk of request) text += chunk;
    const url = new URL(request.url, 'http://localhost'), input = text ? JSON.parse(text) : null, path = url.pathname;
    calls.push({ method: request.method, path, input, query: Object.fromEntries(url.searchParams) });
    const parts = path.split('/'), conversationId = parts[3], requestId = parts[5];
    const json = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (path === '/v1/capabilities') return json(200, { apiVersion: '1', requestContract: 'sql-admission-temporal-queue-v1',
      observation: { protocol: 'AG-UI', mode: 'snapshot-and-bounded-tail' }, initiatorKinds: ['owner'],
      ...(approvalDetails && { approvalDetails }), ...(standingGrants && { standingGrants }), ...(decisionReceipts && { decisionReceipts }) });
    if (parts[2] === 'members' && parts[4] === 'grants') {
      if (request.method === 'GET') return json(200, grantHandler ? await grantHandler() : { apiVersion: '1', memberId,
        active: grants.filter(row => row.status === 'active'), inactive: grants.filter(row => row.status !== 'active').slice(-20) });
      const grant = grants.find(row => row.grantId === parts[5]);
      if (!grant) return json(404, { error: 'not_found' });
      if (lost === 'before-revoke') { response.destroy(); return; }
      Object.assign(grant, { status: 'revoked', revokedAt: new Date().toISOString(), revocationReason: 'owner' });
      if (lost) { response.destroy(); return; }
      return json(200, { apiVersion: '1', grant: revokeHandler ? await revokeHandler(grant) : grant });
    }
    if (path === '/v1/members') return json(200, { apiVersion: '1', members: [{ memberId, engine: 'codex', profile: 'test', ...(subagents && { subagents }) }], next: null });
    if (request.method === 'GET' && path === '/v1/conversations') return json(200, { apiVersion: '1',
      conversations: [...conversations.values()].map(row => row.state), next: null });
    if (request.method === 'POST' && path === '/v1/conversations') {
      conversations.set(input.conversationId, { state: { conversationId: input.conversationId, memberId, engine: 'codex', profile: 'test',
        phase: 'idle', openStep: null, pendingApprovals: [] }, messages: [], cursor: 0, openTools: {}, openText: null, childText: {} });
      return json(201, { apiVersion: '1', ...conversations.get(input.conversationId) });
    }
    const conversation = conversations.get(conversationId);
    if (!conversation) return json(404, { error: 'not_found' });
    if (request.method === 'POST' && parts[4] === 'handoffs') {
      await handoffHold;
      const reply = handoffReplies.shift() ?? 'admitted';
      if (typeof reply === 'object') return json(reply.status, { error: reply.code });
      if (reply === 'dropped') { response.destroy(); return; }
      const prior = handoffs.find(row => row.requestId === input.requestId);
      if (prior && (prior.source.conversationId !== conversationId || prior.target.memberId !== input.memberId)) return json(409, { error: 'conflict' });
      if (!prior && handoffs.some(row => row.source.conversationId === conversationId)) return json(409, { error: 'handed_off' });
      const row = commitHandoff(conversationId, input.requestId);
      if (reply === 'admitted' || reply === 'lost') admit(row.target.conversationId);
      if (reply === 'lost') { response.destroy(); return; }
      if (reply === 'update_rejected') return json(409, { error: 'update_rejected' });
      if (reply === 'unavailable') return json(503, { error: 'retry_same_request' });
      return json(201, { apiVersion: '1', ...structuredClone(row) });
    }
    if (request.method === 'GET' && parts[4] === 'handoff') {
      if (handoffLookupFailures > 0) { handoffLookupFailures--; return json(503, { error: 'unavailable' }); }
      const incoming = handoffs.find(row => row.target.conversationId === conversationId) ?? null;
      const outgoing = handoffs.find(row => row.source.conversationId === conversationId) ?? null;
      return incoming || outgoing ? json(200, { apiVersion: '1', conversationId, incoming, outgoing }) : json(404, { error: 'not_found' });
    }
    if (parts.length === 4) return json(200, { apiVersion: '1', ...conversation });
    if (parts[4] === 'events') {
      if (observationMode === 'redirect') { response.writeHead(302, { location: '/v1/capabilities' }); response.end(); return; }
      if (observationMode === 'oversized') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(':' + 'x'.repeat(9 * 1024 * 1024) + '\n\n'); return; }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const stream = { conversationId, response, runId: randomUUID() }; streams.add(stream); response.on('close', () => streams.delete(stream));
      for (const event of [{ type: 'RUN_STARTED', threadId: conversationId, runId: stream.runId },
        { type: 'MESSAGES_SNAPSHOT', messages: conversation.messages }, { type: 'STATE_SNAPSHOT', snapshot: conversation.state }]) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (finish(stream, conversation.state.phase)) response.end();
      return;
    }
    if (intercept && await intercept({ request, response, url, path, parts, input, json })) return;
    if (parts[4] === 'human') {
      if (lost) { response.destroy(); return; }
      return json(200, { approvalId: input.approvalId, decision: input.choice, ...decisionReply });
    }
    if (request.method === 'GET' && parts[6] === 'approvals') {
      const detail = details.get(parts[7]);
      const result = detailHandler ? await detailHandler(detail) : { status: detail ? 200 : 404, body: detail ?? { error: 'not_found' } };
      return json(result.status, result.body);
    }
    if (request.method === 'GET') {
      await receiptHold;
      if (receiptFailure) return json(503, { error: 'unavailable' });
      return receipts.has(requestId) ? json(200, receipts.get(requestId)) : json(404, { error: 'not_found' });
    }
    if (parts[6] === 'cancel') {
      const receipt = { ...receipts.get(requestId), status: 'cancellation_requested', cancellation: {
        receiptId: randomUUID(), delivery: 'pending', nativeTermination: 'unconfirmed', effects: 'not_assessed' } };
      receipts.set(requestId, receipt); return json(202, receipt);
    }
    if (conflict) return json(409, { error: conflict });
    const receipt = { apiVersion: '1', conversationId, requestId: input.requestId,
      acceptance: { boundary: 'sql_admission_and_temporal_queue' }, status: 'accepted' };
    receipts.set(input.requestId, receipt);
    conversation.messages.push({ id: input.requestId, role: 'user', content: input.text });
    conversation.state.phase = 'running'; emit(conversationId);
    if (lost) response.destroy(); else json(202, receipt);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  function emit(conversationId, events) {
    const conversation = conversations.get(conversationId);
    for (const { response, conversationId: id } of streams) if (id === conversationId) {
      for (const event of events ?? [{ type: 'MESSAGES_SNAPSHOT', messages: conversation.messages },
        { type: 'STATE_SNAPSHOT', snapshot: conversation.state }]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
  function finish(stream, phase) {
    const event = phase === 'failed' ? { type: 'RUN_ERROR', code: 'MEMBER_FAILED', message: 'Member conversation failed' }
      : phase === 'complete' ? { type: 'RUN_FINISHED', threadId: stream.conversationId, runId: stream.runId }
      : phase === 'cancelled' ? { type: 'RUN_FINISHED', threadId: stream.conversationId, runId: stream.runId, outcome: { type: 'cancelled' } } : null;
    if (event) stream.response.write(`data: ${JSON.stringify(event)}\n\n`);
    return event !== null;
  }
  function end(conversationId, phase) {
    const conversation = conversations.get(conversationId);
    conversation.state.phase = phase;
    for (const stream of streams) if (stream.conversationId === conversationId) {
      stream.response.write(`data: ${JSON.stringify({ type: 'STATE_SNAPSHOT', snapshot: conversation.state })}\n\n`);
      finish(stream, phase);
      stream.response.end();
    }
  }
  const latestRequest = conversation => conversation.messages.filter(message => message.role === 'user').at(-1).id;
  /** Completes the latest request with one streamed assistant message, the way Crew settles a finished turn. */
  function reply(conversationId, text) {
    const conversation = conversations.get(conversationId), requestId = latestRequest(conversation), messageId = `${requestId}/item/0`;
    emit(conversationId, [{ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text }, { type: 'TEXT_MESSAGE_END', messageId }]);
    conversation.messages.push({ id: messageId, role: 'assistant', content: text });
    receipts.set(requestId, { ...receipts.get(requestId), status: 'completed', result: { text } });
    conversation.state.phase = 'idle'; emit(conversationId);
  }
  /** Raises one `record_work_item` approval card on the latest request, with its complete tool call, and returns it. */
  function pend(conversationId, overrides = {}) {
    const conversation = conversations.get(conversationId), requestId = overrides.requestId ?? latestRequest(conversation);
    const card = { conversationId, memberId, requestId, invocationId: requestId, approvalId: randomUUID(), version: 1,
      toolName: 'record_work_item', argumentsComplete: true, summary: 'Record one work item', choices: ['approve', 'deny'], ...overrides };
    conversation.messages.push({ id: `${card.approvalId}/call`, role: 'assistant', content: '', toolCalls: [{ id: card.approvalId,
      type: 'function', function: { name: card.toolName, arguments: JSON.stringify({ operation_id: card.requestId }) } }] });
    conversation.state.pendingApprovals = [card];
    emit(conversationId);
    return card;
  }
  function withdraw(conversationId, approvalId) {
    const conversation = conversations.get(conversationId);
    conversation.state.pendingApprovals = conversation.state.pendingApprovals.filter(row => row.approvalId !== approvalId);
    emit(conversationId);
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  const extension = () => ({ value: { ...crewProvider({ service: origin, memberId, instance }), installations: [
    { id: 'member', instance, service: origin, expectedAuthority: 'remote-provider', authentication: {
      kind: 'secret', revision: 'one', resolve: async () => token } }] } });
  return { origin, token, calls, streams, conversations, receipts, details, emit, end, reply, pend, withdraw, extension, grants, handoffs, commitHandoff, admit,
    replyHandoffs(...replies) { handoffReplies.push(...replies); }, failHandoffLookups(count = 1) { handoffLookupFailures = count; },
    holdHandoffs() { const hold = Promise.withResolvers(); handoffHold = hold.promise; return () => { handoffHold = null; hold.resolve(); }; },
    setGrantHandler(value) { grantHandler = value; }, setRevokeHandler(value) { revokeHandler = value; },
    setCapability(value) { approvalDetails = value; }, setDetailHandler(value) { detailHandler = value; }, setDecisionReply(value) { decisionReply = value; }, setLost(value) { lost = value; }, setObservation(value) { observationMode = value; }, setConflict(code = 'request_conflict') { conflict = code; },
    holdReceipts() { const hold = Promise.withResolvers(); receiptHold = hold.promise; return () => { receiptHold = null; hold.resolve(); }; },
    setReceiptFailure(value) { receiptFailure = value; } };
}

/** Activates the extension the way the host would and connects one backend directly, outside any host. */
export async function connected(remote) {
  const { value } = remote.extension(), installation = value.installations[0];
  let provider, presentation;
  await value.entry.activate({ namespace: 'crew', providers: { add(_id, backend, renderer) { provider = backend; presentation = renderer; } },
    credentials: { use: (_request, action) => action(remote.token) } });
  const result = await provider.connect({ apiVersion: 1, instance: installation.instance,
    credential: { kind: 'credential-handle', instance: installation.instance, hostId: 'test-host', opaqueHandle: 'test-handle' } });
  assert.equal(result.kind, 'connected');
  return { backend: result.backend, presentation, installation };
}
