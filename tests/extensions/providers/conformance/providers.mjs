import { randomUUID } from 'node:crypto';
import { createServer, request as forward } from 'node:http';
import { crewProvider } from '../../../../examples/crew/dist/provider.js';
import { crewService } from '../../../../examples/crew/tests/support/crew-service.mjs';
import { instrument } from './instrument.mjs';
import { ledgerExtension, ledgerService } from './ledger.mjs';

/** Records every request a provider makes and can take the service offline without touching the provider. */
async function recordingProxy(t, target) {
  const traffic = [];
  let down = false;
  const server = createServer((incoming, outgoing) => {
    traffic.push({ method: incoming.method, path: incoming.url, headers: { ...incoming.headers } });
    if (down) { outgoing.writeHead(503, { 'content-type': 'application/json' }); outgoing.end('{"error":"unavailable"}'); return; }
    const upstream = new URL(target);
    const proxied = forward({ host: upstream.hostname, port: upstream.port, method: incoming.method, path: incoming.url,
      headers: { ...incoming.headers, host: upstream.host } }, response => {
      outgoing.writeHead(response.statusCode, response.headers); outgoing.flushHeaders(); response.pipe(outgoing);
    });
    proxied.on('error', () => outgoing.destroy());
    outgoing.on('close', () => proxied.destroy());
    incoming.pipe(proxied);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { origin: `http://127.0.0.1:${server.address().port}`, traffic, setDown(value) { down = value; } };
}

async function crew(t) {
  const memberId = randomUUID(), token = 'crew-conformance-token-c41f';
  const instance = { namespace: 'crew', installationId: 'conformance', generation: 'one', protocolVersion: '1' };
  const remote = await crewService(t, { memberId, token, instance }), proxy = await recordingProxy(t, remote.origin);
  const latest = () => [...remote.conversations.entries()].at(-1);
  const posted = suffix => remote.calls.filter(call => call.method === 'POST' && call.path.endsWith(suffix)).length;
  let current;
  return {
    namespace: 'crew', supports: { cancel: true, decide: true }, traffic: proxy.traffic, credentialHeader: 'authorization', secrets: [token, memberId],
    extension() {
      current = instrument({ value: { ...crewProvider({ service: proxy.origin, memberId, instance }), installations: [{ id: 'member', instance,
        service: proxy.origin, expectedAuthority: 'remote-provider', authentication: { kind: 'secret', revision: 'one', resolve: async () => token } }] } });
      return current;
    },
    get counts() { return current.counts; },
    effects: () => ({ creates: remote.calls.filter(call => call.method === 'POST' && call.path === '/v1/conversations').length,
      sends: posted('/requests'), cancels: posted('/cancel'), decisions: posted('/human') }),
    subscriptions: () => remote.streams.size,
    setDown: value => proxy.setDown(value),
    loseSends() { remote.setLost(true); },
    restore() { remote.setLost(false); },
    reply(text) {
      const [conversationId, conversation] = latest();
      const requestId = conversation.messages.filter(message => message.role === 'user').at(-1).id, receipt = remote.receipts.get(requestId);
      const messageId = `${requestId}/item/0`;
      remote.emit(conversationId, [{ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text }, { type: 'TEXT_MESSAGE_END', messageId }]);
      conversation.messages.push({ id: messageId, role: 'assistant', content: text });
      remote.receipts.set(requestId, { ...receipt, status: 'completed', result: { text } });
      conversation.state.phase = 'idle'; remote.emit(conversationId);
    },
    card(prompt) {
      const [conversationId, conversation] = latest();
      const requestId = conversation.messages.filter(message => message.role === 'user').at(-1).id, approvalId = randomUUID();
      conversation.messages.push({ id: `tool-${approvalId}`, role: 'assistant', content: '', toolCalls: [{ id: approvalId, type: 'function',
        function: { name: 'record_work_item', arguments: JSON.stringify({ operation_id: requestId }) } }] });
      conversation.state.pendingApprovals = [{ conversationId, memberId, requestId, invocationId: requestId, approvalId, version: 1,
        toolName: 'record_work_item', argumentsComplete: true, summary: prompt, choices: ['approve', 'deny'] }];
      remote.emit(conversationId);
    },
    settle() { const [conversationId, conversation] = latest(); conversation.state.pendingApprovals = []; remote.emit(conversationId); },
    answers: () => remote.calls.filter(call => call.path.endsWith('/human')).map(call => call.input.choice),
  };
}

async function ledger(t, { controls = true } = {}) {
  const service = await ledgerService(t), proxy = await recordingProxy(t, service.origin);
  let current;
  return {
    namespace: 'ledger', supports: { cancel: controls, decide: controls }, traffic: proxy.traffic, credentialHeader: 'x-ledger-key', secrets: [service.key],
    extension() { current = instrument(ledgerExtension({ service: proxy.origin, key: service.key, controls })); return current; },
    get counts() { return current.counts; },
    effects: () => ({ ...service.effects }),
    subscriptions: () => service.tails.size,
    tailRequests: service.tailRequests,
    setDown: value => proxy.setDown(value),
    loseSends() { service.loseReplyTo('/post'); },
    restore() {},
    reply: text => service.reply(text),
    card: prompt => service.card(prompt),
    settle() {},
    answers: () => service.answers().filter(Boolean),
  };
}

/**
 * The conformance table. Each row is driven only through its public extension entry, the real host and the desktop
 * client store. Rows differ in request ids (Crew reuses AgentUI operation UUIDs; ledger assigns rooms and tickets),
 * cursor shape (Crew `{ epoch, sequence, requests }`; ledger `[epoch, offset]`) and event encoding (Crew SSE AG-UI
 * snapshots; ledger NDJSON log entries folded by `apply`).
 */
export const providers = [
  { name: 'Crew example', start: crew, peer: t => ledger(t) },
  { name: 'ledger fake', start: t => ledger(t), peer: crew },
  { name: 'ledger fake without controls', start: t => ledger(t, { controls: false }), peer: crew },
];
