import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { registerHooks } from 'node:module';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createBrowserConnection } from '@agentui/client/service';
import { EXTENSION_SDK_VERSION, backendProviderContractVersion } from '@agentui/sdk';
import { parseTranscript, transcriptProjection } from '@agentui/contracts/conversation';

const artifact = new URL('../../apps/host/build/tsc/artifact.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './artifact.js' && context.parentURL?.endsWith('/server.js')) {
    const source = `export * from ${JSON.stringify(artifact)};
      import { readInstalledArtifact as read } from ${JSON.stringify(artifact)};
      export function readInstalledArtifact() { return read(${JSON.stringify(fileURLToPath(new URL('../../apps/host/dist/', import.meta.url)))}); }`;
    return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
  }
  return next(specifier, context);
} });
const { startBrowserHost } = await import('../../apps/host/build/tsc/server.js');
export const send = (scope, id = 'send') => ({ version: 1, scope, clientCommandId: id, body: { kind: 'send', text: 'A real provider reply' } });
const secret = 'STREAM_PRIVATE_SECRET';
export async function providerService(t, { native = false } = {}) {
  const instance = { namespace: 'stream-fixture', installationId: 'stream-installation', generation: 'original', protocolVersion: '1' };
  const conversations = new Map(), clients = new Set(), requests = [], replyGates = new Map();
  let sequence = 0, beforeReply = false, commandHandler;
  const ref = (binding, kind, opaqueId) => ({ binding, ref: { kind, instance, opaqueId } });
  const cursor = binding => ({ kind: 'provider-cursor', binding, opaque: { token: `opaque-${++sequence}-z` } });
  const state = () => ({ run: null, transcript: transcriptProjection.initial() });
  const makeEvent = (binding, text, revision, complete = false) => ({ kind: 'event', eventId: `event-${revision}`, cursor: cursor(binding),
    event: { run: ref(binding, 'run', 'same-run'), text, revision, complete } });
  const present = (previous, event, refs) => {
    const runId = refs.run(event.run).runId;
    const events = [...(!previous.run ? [{ kind: 'run-started', runId, previousRunId: null },
      { kind: 'message-updated', messageId: 'user', revision: 1, role: 'user', text: 'A real provider reply', complete: true }] : []),
      { kind: 'message-updated', messageId: 'answer', revision: event.revision, role: 'assistant', text: event.text, complete: event.complete },
      ...(event.complete ? [{ kind: 'run-ended', runId, outcome: 'completed' }] : [])];
    return { state: { run: event.run, transcript: events.reduce(transcriptProjection.apply, previous.transcript) }, events };
  };
  const emit = (item, retain = true) => {
    const binding = item.kind === 'snapshot' ? item.snapshot.binding : item.cursor.binding;
    const saved = conversations.get(binding.creation.scope.conversationId);
    if (retain) {
      saved.history.push(structuredClone(item));
      if (item.kind === 'snapshot') saved.snapshot = structuredClone(item.snapshot);
      else {
        saved.snapshot.state = present(saved.snapshot.state, item.event, { run: value => ({ runId: value.ref.opaqueId }) }).state;
        saved.snapshot.cursor = item.cursor;
      }
    }
    for (const client of clients) if (client.id === binding.creation.scope.conversationId) client.response.write(`${JSON.stringify(item)}\n`);
    return item;
  };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); requests.push({ path: request.url, input });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/create') {
      const binding = { kind: 'agentui-created', creation: input, authority: { kind: native ? 'agentui-host' : 'remote-provider',
        ...(native ? { hostId: input.scope.hostId } : {}), binding: { namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: 'same-session' } } };
      conversations.set(input.scope.conversationId, { history: [], snapshot: { binding, cursor: cursor(binding), projectionVersion: 1, state: state(), decisions: [] } });
      response.end(JSON.stringify({ kind: 'confirmed', value: binding, evidence: null }));
    } else if (request.url === '/snapshot') response.end(JSON.stringify({ kind: 'available', snapshot: conversations.get(input.creation.scope.conversationId).snapshot }));
    else if (request.url === '/observe') {
      const id = input.binding.creation.scope.conversationId, saved = conversations.get(id);
      const client = { id, response }; clients.add(client);
      response.flushHeaders(); request.on('close', () => clients.delete(client)); response.on('close', () => clients.delete(client));
      const index = saved.history.findIndex(item => JSON.stringify(item.kind === 'snapshot' ? item.snapshot.cursor : item.cursor) === JSON.stringify(input.after));
      if (index >= 0) for (const item of saved.history.slice(index + 1)) response.write(`${JSON.stringify(item)}\n`);
    } else if ((request.url === '/submit' || request.url === '/lookup') && commandHandler) {
      const result = await commandHandler(input, request.url);
      if (result === 'lost-reply') response.destroy();
      else response.end(JSON.stringify(result));
    } else if (request.url === '/submit') {
      if (beforeReply) {
        const gate = Promise.withResolvers(); replyGates.set(input.binding.creation.scope.conversationId, gate);
        emit(makeEvent(input.binding, 'Before acceptance', 1)); await gate.promise;
      }
      response.end(JSON.stringify({ kind: 'confirmed', value: { kind: 'send', state: 'accepted', run: ref(input.binding, 'run', 'same-run') }, evidence: null }));
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const service = `http://127.0.0.1:${server.address().port}`;
  const extension = ({ revision = '1', generation = 'original', mutate, onAck, holdReceive, controls = false } = {}) => {
    const installed = { ...instance, generation }, calls = { observe: [], ack: [], failures: [], connected: [], closed: 0, disposed: 0, ready: 0 };
    let context, credential;
    const request = (path, input, signal) => context.credentials.use({ credential, service }, async token => {
      const response = await fetch(`${service}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal });
      return path === '/observe' ? response : response.json();
    });
    const presentation = {
      instance: installed,
      decodeRequest(value) { if (typeof value?.text !== 'string') throw new Error('request'); return value; },
      decodeCursor(value) { if (typeof value?.token !== 'string') throw new Error('cursor'); return value; },
      decodeState(value) { parseTranscript(value.transcript); return value; },
      decodeEvent(value) { if (typeof value?.text !== 'string') throw new Error('event'); return value; },
      request: text => ({ text }),
      snapshot(value, refs) { if (value.run) refs.run(value.run); return value.transcript; },
      apply: present,
    };
    if (mutate) mutate(presentation);
    const backend = {
      instance: installed,
      capabilities: Object.fromEntries(['create', 'send', 'reconcile', 'observe', 'cancel', 'decide'].map(kind => [kind,
        !controls && ['cancel', 'decide'].includes(kind) ? { kind: 'unsupported', reason: 'Not enabled' } : { kind: 'supported' }])),
      async discover() { return { kind: 'available', agents: [{ ref: { instance: installed, kind: 'agent', opaqueId: 'agent' }, name: 'Streaming provider' }] }; },
      create: value => request('/create', value), snapshot: value => request('/snapshot', value),
      submit: value => request('/submit', value), reconcileCreation: async () => ({ kind: 'unsupported', reason: 'Unused' }),
      reconcileCommand: value => controls ? request('/lookup', value) : { kind: 'unsupported', reason: 'Unused' },
      observe(input, receive) {
        calls.observe.push(structuredClone(input));
        calls.receive = receive;
        const controller = new AbortController(), end = Promise.withResolvers();
        let stopped = false;
        const close = () => { if (stopped) return; stopped = true; controller.abort(); end.resolve({ kind: 'closed', cursor: null, reason: 'closed' }); };
        void (async () => {
          try {
            const response = await request('/observe', input, controller.signal);
            calls.ready++;
            let buffered = '';
            for await (const bytes of response.body) {
              buffered += Buffer.from(bytes).toString();
              let newline;
              while ((newline = buffered.indexOf('\n')) >= 0) {
                const item = JSON.parse(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1);
                if (holdReceive) await holdReceive(item);
                if (stopped) return;
                try { await receive(item); } catch (error) { calls.failures.push(error); throw error; }
                calls.ack.push(structuredClone(item)); onAck?.(item);
                const scope = (item.kind === 'snapshot' ? item.snapshot.binding : item.cursor.binding).creation.scope;
                replyGates.get(scope.conversationId)?.resolve(); replyGates.delete(scope.conversationId);
              }
            }
          } catch (error) { if (!stopped) calls.failures.push(error); }
          finally { close(); }
        })();
        return { close, ended: end.promise };
      },
      async close() { calls.closed++; },
    };
    return { calls, presentation, backend, value: {
      manifest: { namespace: instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './provider.js' }] },
      entry: { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate(value) {
        context = value;
        value.providers.add('service', { apiVersion: backendProviderContractVersion, async connect(input) {
          credential = input.credential; calls.connected.push(structuredClone(input)); return { kind: 'connected', backend };
        } }, presentation);
        return { async dispose() { calls.disposed++; } };
      } },
      installations: [{ id: 'service', instance: installed, service, expectedAuthority: native ? 'agentui-host' : 'remote-provider',
        authentication: { kind: 'secret', revision, resolve: async () => secret } }],
    } };
  };
  return { extension, requests, conversations, clients, ref, cursor, makeEvent, emit, command(handler) { commandHandler = handler; }, beforeReply() { beforeReply = true; } };
}
export async function fixture(t, extensions) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-provider-stream-'));
  let running, cookie, port;
  const control = op => new Promise((resolve, reject) => {
    const socket = createConnection(join(directory, 'control.sock')); let output = '';
    socket.once('error', reject); socket.once('connect', () => socket.end(`${JSON.stringify(op)}\n`));
    socket.on('data', data => { output += data; }); socket.once('end', () => { const result = JSON.parse(output); if (result.ok) resolve(result.value); else reject(new Error(result.error)); });
  });
  const client = createBrowserConnection({ fetch: async (url, init) => {
    const response = await fetch(`${running.origin}${url}`, { ...init, headers: { ...init.headers, Connection: 'close', Origin: running.origin, ...(cookie ? { Cookie: cookie } : {}) } });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return response;
  } });
  const start = async values => {
    running = await startBrowserHost({ directory, port: port ?? 0, assetsDirectory: fileURLToPath(new URL('../../apps/desktop/web-dist-browser/', import.meta.url)), providerExtensions: values.map(item => item.value) });
    port = Number(new URL(running.origin).port);
    if (!cookie) await client.pair((await control({ op: 'invite' })).code);
  };
  await start(extensions);
  t.after(async () => { await running.close(); rmSync(directory, { recursive: true, force: true }); });
  const inspect = action => { const db = new DatabaseSync(join(directory, 'host.sqlite')); try { return action(db); } finally { db.close(); } };
  return { client, directory, inspect, control, get running() { return running; }, get cookie() { return cookie; },
    scope: id => ({ hostId: running.hostId, conversationId: id }),
    async create(id = 'chat') { const scope = { hostId: running.hostId, conversationId: id }; const agent = (await client.metadata()).agents.find(value => value.kind === 'provider'); await client.create(scope, agent.id); return scope; },
    async restart(values) { await running.close(); await start(values); },
  };
}
export function saved(f, id = 'chat') {
  return f.inspect(db => ({ checkpoint: db.prepare('SELECT * FROM provider_checkpoints WHERE conversation=?').get(id),
    conversation: db.prepare('SELECT * FROM conversations WHERE conversation=?').get(id),
    events: db.prepare('SELECT * FROM events WHERE conversation=? ORDER BY sequence').all(id),
    ids: db.prepare('SELECT * FROM provider_event_ids WHERE conversation=? ORDER BY id').all(id),
    runs: db.prepare('SELECT * FROM runs WHERE conversation=? ORDER BY id').all(id),
    decisions: db.prepare('SELECT * FROM pending_decisions WHERE conversation=? ORDER BY id').all(id),
    commands: db.prepare('SELECT * FROM commands WHERE conversation=? ORDER BY id').all(id) }));
}
