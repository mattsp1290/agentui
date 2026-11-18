import { randomUUID } from 'node:crypto';
import { createServer, request as forward } from 'node:http';
import { crewProvider } from 'agentui-extension-crew/provider';
import { crewService } from '../../../../extensions/crew/tests/support/crew-service.mjs';
import { instrument } from './instrument.mjs';
import { ledgerExtension, ledgerService } from './ledger.mjs';

/**
 * Records every request a provider makes and can refuse or drop new requests without touching the provider. Responses that
 * are already streaming keep flowing while it is down.
 */
async function recordingProxy(t, target) {
  const traffic = [];
  let down = false, dropped = null;
  const server = createServer((incoming, outgoing) => {
    traffic.push({ method: incoming.method, path: incoming.url, headers: { ...incoming.headers } });
    if (dropped?.(incoming.method, incoming.url)) { outgoing.destroy(); return; }
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
  return { origin: `http://127.0.0.1:${server.address().port}`, traffic, setDown(value) { down = value; },
    setDropped(predicate) { dropped = predicate; } };
}

/**
 * @typedef {{ cancel: boolean, decide: boolean }} Supports
 *   The controls a row advertises. It is the only source of truth: the row's extension is built from it and the suite
 *   generates either the supported or the capability-gated test for each control from it.
 *
 * @typedef {{ creates: number, sends: number, cancels: number, decisions: number }} Effects
 *   Effect requests the provider service received, counted on the wire: duplicates and refused requests included.
 *
 * @typedef {object} Subject
 *   One started provider service and the extension that talks to it through a recording proxy.
 * @property {string} namespace
 * @property {Array<{ method: string, path: string, headers: Record<string, string> }>} traffic Every proxied request.
 * @property {string} credentialHeader The header that carries the provider credential.
 * @property {string[]} secrets Values that must never reach telemetry.
 * @property {() => { value: object, counts: object }} extension A fresh instrumented extension for the next host generation.
 * @property {ReturnType<typeof import('./instrument.mjs').instrument>['counts']} counts Counters of the latest generation.
 * @property {() => Effects} effects
 * @property {() => number} subscriptions Open observation streams at the service.
 * @property {(down: boolean) => void} setDown Takes the service offline at the proxy.
 * @property {(lost: boolean) => void} loseSendReplies While on, sends take effect but their replies are dropped.
 * @property {(dropped: boolean) => void} dropSends While on, sends are cut at the proxy and never reach the service.
 * @property {() => void} dropStreams Ends every open observation stream at the service.
 * @property {(text: string) => void} reply Completes the open run with one assistant message.
 * @property {(prompt: string) => void} card Raises one approve/deny decision. The service withdraws it when answered.
 * @property {() => string[]} answers Choices the service recorded, in order.
 *
 * @typedef {object} ProviderRow
 * @property {string} name
 * @property {Supports} supports
 * @property {(t: import('node:test').TestContext) => Promise<Subject>} start
 * @property {(t: import('node:test').TestContext) => Promise<Subject>} peer A different provider that runs beside it.
 */

/** @returns {Promise<Subject>} */
async function crew(t) {
  const memberId = randomUUID(), token = 'crew-conformance-token-c41f';
  const instance = { namespace: 'crew', installationId: 'conformance', generation: 'one', protocolVersion: '1' };
  let remote;
  remote = await crewService(t, { memberId, token, instance, intercept({ parts, input }) {
    if (parts[4] === 'human') remote.withdraw(parts[3], input.approvalId);
    return false;
  } });
  const proxy = await recordingProxy(t, remote.origin);
  const latest = () => [...remote.conversations.keys()].at(-1);
  const posted = suffix => remote.calls.filter(call => call.method === 'POST' && call.path.endsWith(suffix)).length;
  const isSend = (method, path) => method === 'POST' && new URL(path, 'http://proxy').pathname.endsWith('/requests');
  let current;
  return {
    namespace: 'crew', traffic: proxy.traffic, credentialHeader: 'authorization', secrets: [token, memberId],
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
    loseSendReplies: lost => remote.setLost(lost),
    dropSends: on => proxy.setDropped(on ? isSend : null),
    dropStreams() { for (const stream of remote.streams) stream.response.end(); },
    reply: text => remote.reply(latest(), text),
    card: prompt => { remote.pend(latest(), { summary: prompt }); },
    answers: () => remote.calls.filter(call => call.path.endsWith('/human')).map(call => call.input.choice),
  };
}

/** @returns {Promise<Subject>} */
async function ledger(t, supports) {
  const service = await ledgerService(t), proxy = await recordingProxy(t, service.origin);
  let current;
  return {
    namespace: 'ledger', traffic: proxy.traffic, credentialHeader: 'x-ledger-key', secrets: [service.key],
    extension() { current = instrument(ledgerExtension({ service: proxy.origin, key: service.key, supports })); return current; },
    get counts() { return current.counts; },
    effects: () => ({ ...service.effects }),
    subscriptions: () => service.tails.size,
    setDown: value => proxy.setDown(value),
    loseSendReplies: lost => service.loseRepliesTo(lost ? '/post' : null),
    dropSends: on => proxy.setDropped(on ? (method, path) => method === 'POST' && path === '/post' : null),
    dropStreams: () => service.dropTails(),
    reply: text => service.reply(text),
    card: prompt => service.card(prompt),
    answers: () => service.answers().filter(Boolean),
  };
}

const controlled = { cancel: true, decide: true };
const ledgerRow = supports => t => ledger(t, supports);

/**
 * The conformance table. Each row is driven only through its public extension entry, the real host and the desktop
 * client store. Rows differ in request ids (Crew reuses AgentUI operation UUIDs; ledger assigns rooms and tickets),
 * cursor shape (Crew `{ epoch, sequence, requests }`; ledger `[epoch, offset]`) and event encoding (Crew SSE AG-UI
 * snapshots; ledger NDJSON log entries folded by `apply`).
 * @type {ProviderRow[]}
 */
export const providers = [
  { name: 'Crew example', supports: controlled, start: crew, peer: ledgerRow(controlled) },
  { name: 'ledger fake', supports: controlled, start: ledgerRow(controlled), peer: crew },
  { name: 'ledger fake without controls', supports: { cancel: false, decide: false }, start: ledgerRow({ cancel: false, decide: false }), peer: crew },
];
