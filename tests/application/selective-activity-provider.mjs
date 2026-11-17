import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EXTENSION_SDK_VERSION, backendProviderContractVersion } from '@agentui/sdk';
import { parseTranscript, transcriptProjection } from '@agentui/contracts/conversation';

export async function activityProvider(t) {
  const instance = { namespace: 'activity-feed', installationId: 'activity-install', generation: 'one', protocolVersion: '1' };
  const saved = new Map(), clients = new Set(), requests = [], errors = [], feeds = new Set(), pumps = [];
  let sequence = 0, context, credential;
  const ref = binding => ({ binding, ref: { kind: 'run', instance, opaqueId: 'same-run' } });
  const cursor = binding => ({ kind: 'provider-cursor', binding, opaque: { token: String(++sequence) } });
  const apply = (previous, event, refs) => {
    const runId = refs.run(event.run).runId;
    const events = [...(!previous.run ? [{ kind: 'run-started', runId, previousRunId: null }] : []),
      ...event.events.map(item => item.kind === 'command-updated' || item.kind === 'file-change-updated' ? { ...item, activity: { ...item.activity, runId } }
        : item.kind === 'run-ended' ? { ...item, runId } : item)];
    return { state: { run: event.run, transcript: events.reduce(transcriptProjection.apply, previous.transcript) }, events };
  };
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer activity-secret');
    let body = ''; for await (const part of request) body += part;
    const input = JSON.parse(body); requests.push({ path: request.url, input });
    response.setHeader('content-type', 'application/json');
    if (request.url === '/create') {
      const binding = { kind: 'agentui-created', creation: input, authority: { kind: 'remote-provider', binding: {
        namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: input.scope.conversationId } } };
      saved.set(input.scope.conversationId, { binding, cursor: cursor(binding), projectionVersion: 1,
        state: { run: null, transcript: transcriptProjection.initial() }, decisions: [] });
      response.end(JSON.stringify({ kind: 'confirmed', value: binding, evidence: null }));
    } else if (request.url === '/snapshot') response.end(JSON.stringify({ kind: 'available', snapshot: saved.get(input.creation.scope.conversationId) }));
    else if (request.url === '/observe') {
      const client = { id: input.binding.creation.scope.conversationId, response };
      clients.add(client); response.flushHeaders(); response.on('close', () => clients.delete(client));
    } else if (request.url === '/submit') response.end(JSON.stringify({ kind: 'confirmed', evidence: null,
      value: { kind: 'send', state: 'accepted', run: ref(input.binding) } }));
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const close of feeds) close();
    server.closeAllConnections(); server.close();
    await Promise.all(pumps);
    assert.deepEqual(errors, []);
  });
  const service = `http://127.0.0.1:${server.address().port}`;
  const request = (path, input, signal) => context.credentials.use({ credential, service }, async token => {
    const response = await fetch(service + path, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(input), signal });
    return path === '/observe' ? response : response.json();
  });
  const presentation = {
    instance, decodeRequest: value => value, decodeCursor: value => value, decodeEvent: value => value,
    decodeState(value) { parseTranscript(value.transcript); return value; }, request: text => ({ text }), apply,
    snapshot(value, refs) {
      if (!value.run) return value.transcript;
      const runId = refs.run(value.run).runId;
      return { ...value.transcript, currentRun: value.transcript.currentRun && { ...value.transcript.currentRun, runId },
        activities: value.transcript.activities?.map(activity => ({ ...activity, runId })) };
    },
  };
  const backend = {
    instance, capabilities: Object.fromEntries(['create', 'send', 'reconcile', 'observe', 'cancel', 'decide'].map(kind => [kind,
      ['cancel', 'decide'].includes(kind) ? { kind: 'unsupported', reason: 'Unused' } : { kind: 'supported' }])),
    async discover() { return { kind: 'available', agents: [{ ref: { instance, kind: 'agent', opaqueId: 'agent' }, name: 'Activity feed' }] }; },
    create: input => request('/create', input), snapshot: input => request('/snapshot', input), submit: input => request('/submit', input),
    async reconcileCreation() { return { kind: 'unsupported', reason: 'Unused' }; },
    async reconcileCommand() { return { kind: 'unsupported', reason: 'Unused' }; },
    observe(input, receive) {
      const controller = new AbortController(), end = Promise.withResolvers(); let stopped = false;
      const close = () => { if (stopped) return; stopped = true; feeds.delete(close); controller.abort(); end.resolve({ kind: 'closed', cursor: null, reason: 'closed' }); };
      feeds.add(close);
      const pump = (async () => {
        try {
          const response = await request('/observe', input, controller.signal); let buffered = '';
          for await (const bytes of response.body) {
            buffered += Buffer.from(bytes).toString(); let newline;
            while ((newline = buffered.indexOf('\n')) >= 0) {
              const item = JSON.parse(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1);
              if (!stopped) {
                try { await receive(item); }
                catch (error) { errors.push(error); return; }
              }
            }
          }
        } catch (error) { if (!stopped) errors.push(error); }
        finally { close(); }
      })();
      pumps.push(pump);
      return { close, ended: end.promise };
    },
    async close() {},
  };
  const extension = {
    manifest: { namespace: instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './provider.js' }] },
    entry: { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate(value) {
      context = value;
      value.providers.add('feed', { apiVersion: backendProviderContractVersion, async connect(input) {
        credential = input.credential; return { kind: 'connected', backend };
      } }, presentation);
      return { dispose() {} };
    } },
    installations: [{ id: 'feed', instance, service, expectedAuthority: 'remote-provider',
      authentication: { kind: 'secret', revision: 'one', resolve: async () => 'activity-secret' } }],
  };
  return { extension, requests, clients, saved,
    emit(id, events) {
      const snapshot = saved.get(id), event = { run: ref(snapshot.binding), events };
      const item = { kind: 'event', eventId: `event-${sequence + 1}`, cursor: cursor(snapshot.binding), event };
      snapshot.state = apply(snapshot.state, event, { run: value => ({ runId: value.ref.opaqueId }) }).state;
      snapshot.cursor = item.cursor;
      for (const client of clients) if (client.id === id) client.response.write(JSON.stringify(item) + '\n');
    },
    end(id) { for (const client of clients) if (client.id === id) client.response.end(); },
  };
}
