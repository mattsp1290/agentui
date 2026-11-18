import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'uncertain']);
const sha = text => createHash('sha256').update(text).digest('hex');
/**
 * A controlled crabber-coworkers v1 service over real HTTP. Requests stay `accepted` until a control moves them:
 * `run`, `complete`, `fail`, `markUncertain`. With `autoReply` every submission completes at once with `Reply: <text>`.
 * `down()` resets every connection until `up()`. `loseNext(route)` commits the next matching command and drops its reply.
 * `invisible(requestId)` hides a request from snapshots and receipts (a read that returns 404 for a committed send).
 */
export async function coworkersService(t, { token = 'coworkers-test-token', coworkers = [
  { coworkerId: 'ada', name: 'Ada', role: 'Researcher', workspace: 'read_only', slack: false, instructions: 'Research carefully.' },
  { coworkerId: 'grace', name: 'Grace', role: 'Engineer', workspace: 'read_write', slack: true, instructions: 'Ship small changes.' },
], autoReply = false, requestContract = 'sqlite-outbox-keyed-admission-v1', maxPromptBytes = 16384, maxQueued = 4 } = {}) {
  const conversations = new Map(), requests = new Map(), hidden = new Set(), calls = [];
  let isDown = false, lose = null, loseSends = false;
  const coworkerView = coworker => ({ coworkerId: coworker.coworkerId, name: coworker.name, role: coworker.role, workspace: coworker.workspace,
    slack: coworker.slack, instructions: { bytes: Buffer.byteLength(coworker.instructions), digest: sha(coworker.instructions) } });
  const receipt = request => ({ apiVersion: '1', conversationId: request.conversationId, requestId: request.requestId,
    acceptance: { boundary: 'sqlite_outbox' }, status: request.status,
    ...(request.status === 'completed' ? { result: { text: request.reply } } : {}),
    ...(request.status === 'failed' || request.status === 'uncertain' ? { reason: request.reason ?? 'model_failed' } : {}),
    ...(request.cancelledAt ? { cancellation: { requestedAt: request.cancelledAt } } : {}) });
  const snapshot = conversation => {
    const own = conversation.requests.map(id => requests.get(id)).filter(request => !hidden.has(request.requestId));
    const window = own.slice(-100);
    return { apiVersion: '1', state: { conversationId: conversation.conversationId, coworkerId: conversation.coworkerId,
      phase: own.some(request => !TERMINAL.has(request.status)) ? 'running' : 'idle' },
      messages: window.flatMap(request => [{ requestId: request.requestId, role: 'user', text: request.text },
        ...(request.status === 'completed' ? [{ requestId: request.requestId, role: 'assistant', text: request.reply }] : [])]),
      truncated: own.length > 100 };
  };
  const server = createServer(async (incoming, response) => {
    if (isDown) { incoming.socket.destroy(); return; }
    let text = ''; for await (const chunk of incoming) text += chunk;
    const url = new URL(incoming.url, 'http://localhost'), parts = url.pathname.split('/'), method = incoming.method;
    calls.push({ method, path: url.pathname });
    const json = (status, body) => {
      if (lose && lose.method === method && lose.match(url.pathname) && status < 300) { lose = null; response.destroy(); return; }
      if (loseSends && method === 'POST' && url.pathname.endsWith('/requests') && status < 300) { response.destroy(); return; }
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
    };
    if (incoming.headers.authorization !== `Bearer ${token}`) return json(401, { error: 'unauthorized' });
    let input = null;
    if (text) { try { input = JSON.parse(text); } catch { return json(400, { error: 'invalid_json' }); } }
    if (method === 'GET' && url.pathname === '/v1/capabilities') return json(200, { apiVersion: '1', requestContract, backend: 'local',
      limits: { maxPromptBytes, maxQueuedPerConversation: maxQueued, modelTurnSeconds: 600, maxPageSize: 100 },
      statuses: ['accepted', 'running', 'completed', 'cancellation_requested', 'cancelled', 'failed', 'uncertain'], reasons: ['model_failed', 'timeout'] });
    if (method === 'GET' && url.pathname === '/v1/health') return json(200, { apiVersion: '1', status: 'ready', dependencies: { database: { status: 'ready' } }, outstandingAdmissions: 0 });
    if (method === 'GET' && url.pathname === '/v1/coworkers') return json(200, { apiVersion: '1', coworkers: coworkers.map(coworkerView) });
    if (method === 'GET' && url.pathname === '/v1/conversations') return json(200, { apiVersion: '1',
      conversations: [...conversations.values()].map(conversation => snapshot(conversation).state), next: null });
    if (method === 'POST' && url.pathname === '/v1/conversations') {
      if (!coworkers.some(coworker => coworker.coworkerId === input?.coworkerId)) return json(404, { error: 'not_found' });
      const existing = conversations.get(input.conversationId);
      if (existing && existing.coworkerId !== input.coworkerId) return json(409, { error: 'conflict' });
      if (!existing) conversations.set(input.conversationId, { conversationId: input.conversationId, coworkerId: input.coworkerId, requests: [] });
      return json(201, snapshot(conversations.get(input.conversationId)));
    }
    const conversation = conversations.get(parts[3]);
    if (!conversation) return json(404, { error: 'not_found' });
    if (method === 'GET' && parts.length === 4) return json(200, snapshot(conversation));
    if (method === 'POST' && parts.length === 5 && parts[4] === 'requests') {
      const prior = requests.get(input.requestId);
      if (prior) return prior.text === input.text ? json(202, receipt(prior)) : json(409, { error: 'conflict' });
      if (Buffer.byteLength(input.text) > maxPromptBytes) return json(413, { error: 'payload_too_large' });
      if (conversation.requests.filter(id => !TERMINAL.has(requests.get(id).status)).length >= maxQueued) return json(409, { error: 'queue_full' });
      const request = { conversationId: conversation.conversationId, requestId: input.requestId, text: input.text, status: 'accepted' };
      requests.set(request.requestId, request); conversation.requests.push(request.requestId);
      if (autoReply) Object.assign(request, { status: 'completed', reply: `Reply: ${input.text}` });
      return json(202, receipt(request));
    }
    const request = requests.get(parts[5]);
    if (!request || request.conversationId !== conversation.conversationId || hidden.has(request.requestId)) return json(404, { error: 'not_found' });
    if (method === 'GET' && parts.length === 6) return json(200, receipt(request));
    if (method === 'POST' && parts[6] === 'cancel') {
      if (!TERMINAL.has(request.status)) Object.assign(request, { status: 'cancelled', cancelledAt: new Date().toISOString() });
      return json(202, receipt(request));
    }
    return json(404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); });
  const latest = () => [...requests.values()].filter(request => !TERMINAL.has(request.status)).at(-1);
  const move = (requestId, values) => Object.assign(requestId ? requests.get(requestId) : latest(), values);
  return { origin: `http://127.0.0.1:${port}`, token, conversations, requests, calls, coworkers,
    reads: path => calls.filter(call => call.method === 'GET' && call.path === path).length,
    run: requestId => move(requestId, { status: 'running' }),
    complete: (text, requestId) => move(requestId, { status: 'completed', reply: text }),
    fail: (requestId, reason = 'model_failed') => move(requestId, { status: 'failed', reason }),
    markUncertain: (requestId, reason = 'interrupted') => move(requestId, { status: 'uncertain', reason }),
    invisible: requestId => hidden.add(requestId), visible: requestId => hidden.delete(requestId),
    loseNext(method, match) { lose = { method, match }; },
    loseReplies(on) { loseSends = on; },
    down() { isDown = true; server.closeAllConnections(); }, up() { isDown = false; },
    addRequest(conversationId, request) { requests.set(request.requestId, { conversationId, ...request }); conversations.get(conversationId).requests.push(request.requestId); },
  };
}
