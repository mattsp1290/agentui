import { createServer } from 'node:http';
import { canonicalJson } from '@agentui/contracts';
import { parseTranscript, transcriptProjection } from '@agentui/contracts/conversation';
import { EXTENSION_SDK_VERSION, backendProviderContractVersion } from '@agentui/sdk';

/**
 * A second provider service that shares nothing with Crew. The service assigns its own room and ticket numbers
 * instead of reusing AgentUI operation ids, authenticates with `x-ledger-key`, resumes from an `[epoch, offset]`
 * cursor, and streams NDJSON log entries that the presentation folds event by event.
 */
export async function ledgerService(t, { key = 'ledger-private-key-5e1a' } = {}) {
  const rooms = new Map(), opened = new Map(), tails = new Set();
  const effects = { creates: 0, sends: 0, cancels: 0, decisions: 0 };
  // Counted on arrival, before the idempotency check, so a redispatched operation shows up as a second effect.
  const effectRoutes = { '/open': 'creates', '/post': 'sends', '/halt': 'cancels', '/answer': 'decisions' };
  let tickets = 0, cards = 0, lostRoute = null;
  const append = (room, entry) => {
    room.log.push(entry);
    const offset = room.log.length;
    for (const tail of tails) if (tail.room === room) tail.response.write(`${JSON.stringify({ at: [room.epoch, offset], entry })}\n`);
  };
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const json = (status, body) => {
      if (lostRoute === request.url && status < 300) { response.destroy(); return; }
      response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
    };
    if (request.headers['x-ledger-key'] !== key) return json(401, { error: 'key' });
    if (effectRoutes[request.url]) effects[effectRoutes[request.url]]++;
    const input = text ? JSON.parse(text) : {}, room = rooms.get(input.room);
    switch (request.url) {
      case '/hello': return json(200, { version: 'ledger-2' });
      case '/desks': return json(200, { desks: [{ desk: 'desk-1', title: 'Ledger desk' }] });
      case '/open': case '/open-lookup': {
        if (!opened.has(input.key)) {
          if (request.url === '/open-lookup') return json(404, { error: 'unknown' });
          const id = `room-${opened.size + 1}`;
          rooms.set(id, { id, epoch: 1, log: [], keys: new Map(), cards: new Map(), open: null });
          opened.set(input.key, id);
        }
        return json(200, { room: opened.get(input.key) });
      }
      case '/state': return room ? json(200, { epoch: room.epoch, offset: room.log.length, log: room.log,
        cards: [...room.cards.values()].filter(card => !card.answer) }) : json(404, { error: 'room' });
      case '/tail': {
        if (!room) return json(404, { error: 'room' });
        response.writeHead(200, { 'content-type': 'application/x-ndjson' }); response.flushHeaders();
        const tail = { room, response }; tails.add(tail);
        response.on('close', () => tails.delete(tail));
        if (input.from[0] !== room.epoch) { response.end(`${JSON.stringify({ resync: true })}\n`); return; }
        room.log.slice(input.from[1]).forEach((entry, index) =>
          response.write(`${JSON.stringify({ at: [room.epoch, input.from[1] + index + 1], entry })}\n`));
        return;
      }
      case '/lookup': {
        const found = room?.keys.get(input.key);
        if (!found) return json(404, { error: 'unknown' });
        return json(200, found.ticket ? { ...found, closed: room.open !== found.ticket } : found);
      }
      case '/post': {
        if (!room) return json(404, { error: 'room' });
        if (!room.keys.has(input.key)) {
          if (room.open) return json(409, { error: 'busy' });
          const ticket = `ticket-${++tickets}`;
          room.keys.set(input.key, { ticket }); room.open = ticket;
          append(room, { op: 'user', ticket, text: input.input.map(item => item.content).join('\n') });
        }
        return json(202, room.keys.get(input.key));
      }
      case '/halt': {
        if (!room || room.open !== input.ticket) return json(409, { error: 'not-running' });
        if (!room.keys.has(input.key)) {
          room.keys.set(input.key, { halted: input.ticket });
          room.open = null; append(room, { op: 'done', ticket: input.ticket, outcome: 'interrupted' });
        }
        return json(200, room.keys.get(input.key));
      }
      case '/answer': {
        const card = room?.cards.get(input.card);
        if (!card || !card.options.includes(input.option)) return json(404, { error: 'card' });
        if (!room.keys.has(input.key)) {
          if (card.answer) return json(409, { error: 'answered' });
          card.answer = input.option; room.keys.set(input.key, { answered: card.id, option: input.option });
          append(room, { op: 'card', card: card.id });
        }
        return json(200, room.keys.get(input.key));
      }
    }
    json(404, { error: 'route' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const latest = () => [...rooms.values()].at(-1);
  return { origin, key, effects, rooms, tails,
    loseRepliesTo(path) { lostRoute = path; },
    dropTails() { for (const tail of tails) tail.response.end(); },
    reply(text) {
      const room = latest(), ticket = room.open;
      for (const part of [text.slice(0, 3), text.slice(3)]) append(room, { op: 'say', ticket, text: part });
      room.open = null; append(room, { op: 'done', ticket, outcome: 'completed' });
    },
    card(prompt) {
      const room = latest(), id = `card-${++cards}`;
      room.cards.set(id, { id, ticket: room.open, prompt, options: ['approve', 'deny'], answer: null });
      append(room, { op: 'card', card: id });
    },
    answers() { return [...latest().cards.values()].map(card => card.answer); },
  };
}

async function* lines(body) {
  let buffered = '';
  for await (const bytes of body) {
    buffered += Buffer.from(bytes).toString();
    for (let newline; (newline = buffered.indexOf('\n')) >= 0; buffered = buffered.slice(newline + 1)) yield JSON.parse(buffered.slice(0, newline));
  }
}

const instance = { namespace: 'ledger', installationId: 'books', generation: 'g1', protocolVersion: 'ledger-2' };
const ref = (binding, kind, opaqueId) => ({ binding, ref: { instance: binding.creation.agent.instance, kind, opaqueId } });
const failure = status => status === 401 ? { kind: 'authentication-failed', reason: 'Ledger rejected the key.' }
  : status === 403 ? { kind: 'unauthorized', reason: 'Ledger refused the key.' } : { kind: 'unavailable', reason: 'Ledger is unreachable.' };
const uncertain = { kind: 'uncertain', reason: 'Ledger outcome is unknown.', evidence: null };

/** Folds one log entry into the transcript the host renders. */
function fold(state, entry, refs) {
  const runId = refs.run(ref(state.binding, 'run', entry.ticket)).runId;
  const previous = state.transcript.currentRun, reply = state.transcript.messages.find(message => message.messageId === `${entry.ticket}/reply`);
  const events = entry.op === 'user'
    ? [{ kind: 'run-started', runId, previousRunId: previous?.kind === 'ended' ? previous.runId : null },
      { kind: 'message-updated', messageId: `${entry.ticket}/user`, revision: 1, role: 'user', text: entry.text, complete: true }]
    : entry.op === 'say'
      ? [{ kind: 'message-updated', messageId: `${entry.ticket}/reply`, revision: (reply?.revision ?? 0) + 1, role: 'assistant',
        text: (reply?.text ?? '') + entry.text, complete: false }]
      : [...(reply ? [{ kind: 'message-updated', messageId: reply.messageId, revision: reply.revision + 1, role: 'assistant', text: reply.text, complete: true }] : []),
        { kind: 'run-ended', runId, outcome: entry.outcome }];
  return { state: { ...state, transcript: events.reduce(transcriptProjection.apply, state.transcript) }, events };
}

export const ledgerPresentation = {
  instance,
  decodeRequest(value) {
    if (!Array.isArray(value?.input) || value.input.some(item => item?.role !== 'user' || typeof item.content !== 'string') ||
      Object.keys(value).length !== 1) throw new Error('Invalid ledger request');
    return value;
  },
  decodeCursor(value) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isSafeInteger)) throw new Error('Invalid ledger cursor');
    return value;
  },
  decodeState(value) { if (!value?.binding) throw new Error('Invalid ledger state'); parseTranscript(value.transcript); return value; },
  decodeEvent(value) {
    if (!['user', 'say', 'done'].includes(value?.op) || typeof value.ticket !== 'string') throw new Error('Invalid ledger event');
    return value;
  },
  request: text => ({ input: [{ role: 'user', content: text }] }),
  snapshot(state, refs) {
    if (state.transcript.currentRun) refs.run(ref(state.binding, 'run', state.transcript.currentRun.runId));
    return state.transcript;
  },
  apply: (previous, event, refs) => fold(previous, event, refs),
};

/** The ledger extension through the public entry contract. `supports` says which of cancel and decide it offers. */
export function ledgerExtension({ service, key, supports }) {
  const entry = { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate(context) {
    context.providers.add('books', { apiVersion: backendProviderContractVersion, async connect(request) {
      const credential = request.credential, feeds = new Set();
      const call = (path, input, signal) => context.credentials.use({ credential, service }, async secret =>
        fetch(`${service}${path}`, { method: 'POST', headers: { 'x-ledger-key': secret }, body: JSON.stringify(input), signal }));
      const post = async (path, input) => {
        const response = await call(path, input);
        return { status: response.status, body: await response.json() };
      };
      const hello = await post('/hello', {}).catch(() => ({ status: 503 }));
      if (hello.status !== 200) return failure(hello.status);
      const room = binding => binding.authority.binding.opaqueSessionId;
      const state = async binding => {
        const { status, body } = await post('/state', { room: room(binding) });
        if (status !== 200) return failure(status);
        const refs = { run: value => ({ runId: value.ref.opaqueId }) };
        const folded = body.log.reduce((current, entry) => entry.op === 'card' ? current : fold(current, entry, refs).state,
          { binding, transcript: transcriptProjection.initial() });
        return { kind: 'available', snapshot: { binding, cursor: { kind: 'provider-cursor', binding, opaque: [body.epoch, body.offset] },
          projectionVersion: 1, state: folded, decisions: body.cards.map(card => ({ ref: ref(binding, 'decision', card.id),
            run: ref(binding, 'run', card.ticket), prompt: card.prompt,
            choices: card.options.map(option => ({ ref: ref(binding, 'choice', `${card.id}/${option}`), label: option === 'approve' ? 'Approve' : 'Deny' })) })) } };
      };
      const binding = (operation, id) => ({ kind: 'agentui-created', creation: operation,
        authority: { kind: 'remote-provider', binding: { namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: id } } });
      const creation = async (operation, path) => {
        try {
          const { status, body } = await post(path, { key: operation.operationId });
          return status === 200 ? { kind: 'confirmed', value: binding(operation, body.room), evidence: { room: body.room } } : uncertain;
        } catch { return uncertain; }
      };
      const routes = {
        send: (id, operation) => post('/post', { room: id, key: operation.operationId, input: operation.request.input }),
        cancel: (id, operation) => post('/halt', { room: id, key: operation.operationId, ticket: operation.run.ref.opaqueId }),
        decide: (id, operation) => {
          const [card, option] = operation.choice.ref.opaqueId.split('/');
          return post('/answer', { room: id, key: operation.operationId, card, option });
        },
      };
      const foreignChoice = operation => operation.kind === 'decide' && operation.choice.ref.opaqueId.split('/')[0] !== operation.decision.ref.opaqueId;
      const command = async (operation, fresh) => {
        const id = room(operation.binding);
        if (fresh && foreignChoice(operation)) return { kind: 'rejected', reason: 'Foreign ledger choice.', evidence: null };
        try {
          const result = fresh ? await routes[operation.kind](id, operation) : await post('/lookup', { room: id, key: operation.operationId });
          if (result.status === 409 && fresh) return { kind: 'rejected', reason: 'Ledger refused this operation.', evidence: result.body };
          if (result.status >= 300) return uncertain;
          const value = operation.kind === 'send'
            ? { kind: 'send', run: ref(operation.binding, 'run', result.body.ticket), state: result.body.closed ? 'completed' : 'accepted' }
            : { kind: operation.kind, state: 'completed' };
          return { kind: 'confirmed', value, evidence: result.body };
        } catch { return uncertain; }
      };
      const unsupported = { kind: 'unsupported', reason: 'This ledger desk has no controls.' };
      return { kind: 'connected', backend: { instance,
        capabilities: { create: { kind: 'supported' }, send: { kind: 'supported' }, reconcile: { kind: 'supported' }, observe: { kind: 'supported' },
          cancel: supports.cancel ? { kind: 'supported' } : unsupported, decide: supports.decide ? { kind: 'supported' } : unsupported },
        async discover() {
          const result = await post('/desks', {}).catch(() => ({ status: 503 }));
          if (result.status !== 200) return failure(result.status);
          return { kind: 'available', agents: result.body.desks.map(desk => ({ ref: { instance, kind: 'agent', opaqueId: desk.desk }, name: desk.title })) };
        },
        create: operation => creation(operation, '/open'), reconcileCreation: operation => creation(operation, '/open-lookup'),
        submit: operation => command(operation, true), reconcileCommand: operation => command(operation, false),
        snapshot: binding => state(binding).catch(() => failure(503)),
        observe({ binding, after }, receive) {
          // A card changes the decision set, which reaches the host only through a fresh snapshot.
          const deliver = async line => {
            if (line.entry.op !== 'card') {
              const cursor = { kind: 'provider-cursor', binding, opaque: line.at };
              return { kind: 'event', eventId: `ledger-${line.at[0]}-${line.at[1]}`, cursor, event: line.entry };
            }
            const current = await state(binding);
            return current.kind === 'available' ? { kind: 'snapshot', snapshot: current.snapshot, cursor: current.snapshot.cursor } : current;
          };
          if (after && canonicalJson(after.binding) !== canonicalJson(binding)) throw new Error('Foreign ledger cursor');
          const controller = new AbortController(), ended = Promise.withResolvers();
          let stopped = false, acknowledged = after;
          const finish = result => { if (!stopped) { stopped = true; controller.abort(); feeds.delete(feed); ended.resolve({ ...result, cursor: acknowledged }); } };
          const feed = { close: () => finish({ kind: 'closed', reason: 'Closed by host.' }), ended: ended.promise };
          feeds.add(feed);
          void (async () => {
            let at = after?.opaque ?? [0, 0];
            try {
              const response = await call('/tail', { room: room(binding), from: at }, controller.signal);
              if (response.status !== 200) return finish(failure(response.status));
              for await (const line of lines(response.body)) {
                if (line.resync) return finish({ kind: 'resync', reason: 'Ledger epoch changed.' });
                if (line.at[1] <= at[1]) continue;
                const item = await deliver(line);
                if (item.kind !== 'snapshot' && item.kind !== 'event') return finish(item);
                at = item.cursor.opaque;
                await receive(item.kind === 'snapshot' ? { kind: 'snapshot', snapshot: item.snapshot } : item);
                if (!stopped) acknowledged = item.cursor;
              }
              finish({ kind: 'disconnected', reason: 'Ledger tail ended.' });
            } catch { finish({ kind: 'disconnected', reason: 'Ledger tail failed.' }); }
          })();
          return feed;
        },
        async close() { const active = [...feeds]; active.forEach(feed => feed.close()); await Promise.all(active.map(feed => feed.ended)); },
      } };
    } }, ledgerPresentation);
    return { dispose() {} };
  } };
  return { value: {
    manifest: { namespace: instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './ledger.js' }] },
    entry,
    installations: [{ id: 'books', instance, service, expectedAuthority: 'remote-provider', authentication: { kind: 'secret', revision: 'r1', resolve: async () => key } }],
  } };
}
