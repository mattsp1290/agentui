import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createProviderRegistry, openLocalHost } from '@agentui/host';
import { frontendToolsFor } from '@agentui/host/frontend-tools';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { controlledProvider, instance } from './fixtures/provider-observations.ts';
import { until } from '../host/fixture.mjs';
export const actor = { id: 'owner', platform: 'desktop', authorized: () => true };
export const scope = { hostId: 'host', conversationId: 'conversation' };
export const command = (id = 'send') => ({ version: 2, scope, clientCommandId: id, body: { kind: 'send', text: 'Observe', frontend: {
  platform: 'desktop', tools: [{ definition: { name: 'test__inspect', description: 'Inspect', parameters: { type: 'object' } }, activationId: 'original-activation' }],
} } });
export const events = operation => [
  { type: 'RUN_STARTED', threadId: operation.request.threadId, runId: operation.request.runId },
  { type: 'TOOL_CALL_START', toolCallId: 'call', toolCallName: 'test__inspect' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'call', delta: '{"value":' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'call', delta: '42}' },
  { type: 'TOOL_CALL_END', toolCallId: 'call' },
  { type: 'RUN_FINISHED', threadId: operation.request.threadId, runId: operation.request.runId },
];
export async function observationFixture(t, options = {}) {
  const directory = options.directory ?? mkdtempSync(join(tmpdir(), 'provider-observations-')), path = join(directory, 'host.sqlite');
  const requests = [], waiting = [], queue = [], submissions = [], histories = [];
  let binding, held = options.held ?? false, outcome = options.outcome ?? 'confirmed', serial = 0;
  const respond = (response, value) => response.end(JSON.stringify(value));
  const server = createServer(async (request, response) => {
    response.setHeader('connection', 'close');
    let body = ''; for await (const bytes of request) body += bytes;
    const input = JSON.parse(body); requests.push({ path: request.url, input });
    if (request.url === '/create') {
      binding = { kind: 'agentui-created', creation: input, authority: { kind: 'remote-provider', binding: { namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: 'original' } } };
      respond(response, binding);
    } else if (request.url === '/snapshot') respond(response, { cursor: `snapshot-${serial}`, state: { histories } });
    else if (request.url === '/submit') {
      submissions.push(input);
      const finish = () => respond(response, outcome === 'confirmed' ? { kind: 'confirmed', runId: input.request.runId } : { kind: outcome });
      if (held) waiting.push({ response, finish, kind: 'submit' }); else finish();
    } else if (request.url === '/next') {
      if (response.destroyed || input.streamId !== provider.streamId) { response.destroy(); return; }
      const value = queue.shift();
      if (value) respond(response, value);
      else { const entry = { response, kind: 'feed', streamId: input.streamId }; waiting.push(entry); response.on('close', () => { const index = waiting.indexOf(entry); if (index >= 0) waiting.splice(index, 1); }); }
    } else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const service = `http://127.0.0.1:${server.address().port}`;
  let provider, registry, host, enabled = options.enabled ?? true;
  const start = async (create = false) => {
    provider = controlledProvider(service);
    options.configure?.(provider);
    registry = createProviderRegistry([{ manifest: { namespace: instance.namespace, trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './fixture.js' }] },
      entry: { kind: 'server', sdkVersion: EXTENSION_SDK_VERSION, activate: context => provider.activate(context, enabled) },
      authority: { credentials: {}, issue: () => ({ credential: null, expectedAuthority: 'remote-provider', assertAuthorized() {} }), async close() {} } }]);
    await registry.activate(); const [discovered] = await registry.discover();
    host = openLocalHost({ path, projection: transcriptProjection, providers: registry, driver: [], authorize: () => true });
    if (create) await host.createProviderConversation(scope, { kind: 'provider', contributionId: discovered.contributionId, instance: discovered.instance,
      agent: discovered.agents[0], presentationVersion: 1, expectedAuthority: discovered.expectedAuthority }, registry);
    else await host.observeProvider(scope);
  };
  await start(!options.directory);
  const close = async () => { host.close(); await host.drained; await registry.close(); await until(() => waiting.every(item => item.kind !== 'feed')); };
  t.after(async () => { for (const entry of waiting.filter(item => item.kind === 'submit')) entry.finish(); await close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const database = fn => { const db = new DatabaseSync(path); try { return fn(db); } finally { db.close(); } };
  const dump = () => database(db => Object.fromEntries(['conversations','commands','runs','provider_checkpoints','provider_event_ids','frontend_observation_runs','frontend_observation_events','frontend_runs','frontend_events','frontend_receipts','frontend_send_owners'].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
  return { directory, path, requests, submissions, histories, database, dump, get host() { return host; }, get provider() { return provider; },
    get binding() { return binding; }, retire: () => registry.close(),
    async restart(nextEnabled = enabled) { await close(); enabled = nextEnabled; await start(); },
    async resnapshot() { provider.disconnect(); await until(() => host.observationStatus(scope).kind === 'stopped'); return host.retryObservation(scope); },
    release(kind = outcome) { held = false; outcome = kind; for (const entry of waiting.filter(item => item.kind === 'submit')) { waiting.splice(waiting.indexOf(entry),1); entry.finish(); } },
    async submit(id = 'send') { const result = await host.conversation(scope, actor).submit(command(id)); assert.equal(result.kind, 'receipt'); return result.receipt; },
    batch(operation = submissions[0], list = events(operation), firstPosition = 1) { return { operationId: operation.operationId, threadId: operation.request.threadId, runId: operation.request.runId, firstPosition, events: list }; },
    async emit(batches, id = `item-${++serial}`) {
      const before = provider.counters.acknowledgements, failures = provider.counters.failures.length;
      const item = { id, cursor: id, event: { batches } }, pending = waiting.find(item => item.kind === 'feed' && item.streamId === provider.streamId);
      if (pending) { waiting.splice(waiting.indexOf(pending),1); respond(pending.response, item); } else queue.push(item);
      await until(() => provider.counters.acknowledgements > before || provider.counters.failures.length > failures).catch(error => { throw new Error(JSON.stringify({ status: host.observationStatus(scope), counters: provider.counters, requests: requests.map(item => item.path), waiting: waiting.map(item => item.kind), queue }), { cause: error }); });
      return provider.counters.acknowledgements > before;
    },
    inspect(operation = submissions[0]) { return frontendToolsFor(host).producer(scope).inspect({ threadId: operation.request.threadId, runId: operation.request.runId }); },
    withdraw() { return host.frontendBinding({ scope, id: 'send', action: 'unavailable' }, actor, () => assert.fail('withdrawal producer')); },
  };
}
