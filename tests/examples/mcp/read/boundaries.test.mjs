import assert from 'node:assert/strict';
import test from 'node:test';
import { SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { parseOrigin } from '../../../../examples/mcp-control/read/dist/host.js';
import { Reader } from '../../../../examples/mcp-control/read/dist/reader.js';
import { compatibility, connect, data, listen } from './support.mjs';

const identity = { hostId: 'host-a', principalId: 'trusted-owner' };
const metadata = { ...identity, compatibility, agents: [{ id: 'agent-a', label: 'Recorded', runtime: compatibility.nativeRuntime,
  imageInput: { kind: 'unsupported', reason: 'This model cannot read images.' }, frontendOffers: 'unsupported', commands: ['send'], availability: { kind: 'ready' } }], defaultAgentId: 'agent-a', extensions: [] };
const scope = { hostId: identity.hostId, conversationId: 'conversation-a' };
const snapshot = () => ({ kind: 'page', page: 1, item: { kind: 'snapshot', snapshot: { scope,
  projectionVersion: transcriptProjection.version, cursor: 0, document: { domain: { messages: [], currentRun: null }, receipts: {}, decisions: {} } } } });
const reply = (response, value) => response.end(JSON.stringify({ ok: true, value }));
const until = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Expected request did not arrive');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const readRequest = async request => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
};

test('MCP refuses malformed, oversized, redirected, mismatched and non-snapshot data and closes every acquired feed', { timeout: 15_000 }, async t => {
  let scenario = 'valid', closes = 0, redirectHits = 0;
  const redirect = await listen(t, (_, response) => { redirectHits++; response.end('{}'); });
  const origin = await listen(t, async (request, response) => {
    const input = await readRequest(request);
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.origin, undefined);
    assert.equal(request.headers.cookie, undefined);
    if (input.op === 'metadata') {
      if (scenario === 'redirect') { response.writeHead(307, { location: redirect }); response.end(); }
      else reply(response, scenario === 'metadata-host' ? { ...metadata, hostId: 'foreign' } : metadata);
    } else if (input.op === 'conversation-agent') reply(response, null);
    else if (input.op === 'watch') { assert.equal(input.after, null); reply(response, { feedId: 'feed-a' }); }
    else if (input.op === 'close') { closes++; reply(response, null); }
    else if (input.op === 'pull') {
      if (scenario === 'malformed') response.end('{"private-host-response":');
      else if (scenario === 'oversized') response.end('x'.repeat(SERVICE_MAX_RESPONSE_BYTES + 1));
      else if (scenario === 'utf8') response.end(Buffer.from([0xff]));
      else if (scenario === 'events') reply(response, { kind: 'page', page: 1, item: { kind: 'events', events: [] } });
      else if (scenario === 'ended') reply(response, { kind: 'ended', end: { kind: 'refused', cursor: null, reason: 'private-host-response' } });
      else {
        const page = snapshot();
        if (scenario === 'scope') page.item.snapshot.scope = { ...scope, hostId: 'foreign' };
        if (scenario === 'projection') page.item.snapshot.projectionVersion++;
        if (scenario === 'state') page.item.snapshot.document.domain.currentRun = { kind: 'ended', runId: 'a', outcome: 'invented' };
        reply(response, page);
      }
    } else throw new Error(`Unexpected operation ${input.op}`);
  });
  const mcp = await connect(t, origin);
  assert.equal(data(await mcp.client.callTool({ name: 'agentui_inspect', arguments: { conversationId: scope.conversationId } })).currentRun, null);
  assert.equal(closes, 1);
  for (scenario of ['malformed', 'oversized', 'utf8', 'events', 'ended', 'scope', 'projection', 'state', 'metadata-host', 'redirect']) {
    const before = closes;
    const result = await mcp.client.callTool({ name: 'agentui_inspect', arguments: { conversationId: scope.conversationId } });
    assert.equal(result.isError, true, scenario);
    assert.equal(result.structuredContent, undefined);
    assert.ok(!JSON.stringify(result).includes('private-host-response'));
    assert.equal(closes, before + (scenario === 'metadata-host' || scenario === 'redirect' ? 0 : 1), scenario);
  }
  assert.equal(redirectHits, 0);
  assert.equal(mcp.stderr, '');
});

test('request deadlines, caller cancellation and admission limits retain an independent feed cleanup budget', { timeout: 15_000 }, async t => {
  let watches = 0, pulls = 0, closes = 0;
  const origin = await listen(t, async (request, response) => {
    const input = await readRequest(request);
    if (input.op === 'metadata') reply(response, metadata);
    else if (input.op === 'conversation-agent') reply(response, null);
    else if (input.op === 'watch') { watches++; reply(response, { feedId: `feed-${watches}` }); }
    else if (input.op === 'close') { closes++; reply(response, null); }
    else if (input.op === 'pull') pulls++;
    else throw new Error('Unexpected operation');
  });
  const reader = await Reader.connect(origin, new AbortController().signal);
  const cancelled = new AbortController();
  t.after(() => cancelled.abort());
  const cancelledRead = assert.rejects(reader.inspect(scope.conversationId, cancelled.signal));
  await until(() => pulls === 1);
  cancelled.abort();
  await cancelledRead;
  assert.equal(watches, 1);
  assert.equal(closes, 1);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const pending = Array.from({ length: 4 }, () => reader.inspect(scope.conversationId, controller.signal));
  const settled = Promise.allSettled(pending);
  await assert.rejects(reader.inspect(scope.conversationId, controller.signal), /Inspection limit/);
  await until(() => pulls === 5);
  controller.abort();
  assert.ok((await settled).every(result => result.status === 'rejected'));
  assert.equal(closes, 5);
  await assert.rejects(reader.inspect(scope.conversationId, new AbortController().signal));
  assert.equal(closes, 6);
});

test('origins must be exactly a canonical loopback http origin', () => {
  assert.equal(parseOrigin('http://127.0.0.1:7140'), 'http://127.0.0.1:7140');
  for (const origin of ['https://127.0.0.1:7140', 'http://localhost:7140', 'http://127.0.0.1:7140/',
    'http://user@127.0.0.1:7140', 'http://127.0.0.1:7140?secret=x', 'http://127.0.0.1:7140#x', 'http://127.0.0.1:0', 'http://127.0.0.1:99999']) {
    assert.throws(() => parseOrigin(origin), origin);
  }
});
