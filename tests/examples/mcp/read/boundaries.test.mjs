import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { parseAccess, loadAccess } from '../../../../examples/mcp-control/read/dist/access.js';
import { Reader } from '../../../../examples/mcp-control/read/dist/reader.js';
import { cli, compatibility, connect, data, listen, privateDirectory, writeProfile } from './support.mjs';

const identity = { hostId: 'host-a', principalId: 'principal-a', secret: 's'.repeat(43) };
const metadata = { ...identity, compatibility, agents: [{ id: 'agent-a', label: 'Recorded', runtime: compatibility.nativeRuntime,
  frontendOffers: 'unsupported', commands: ['send'], availability: { kind: 'ready' } }], defaultAgentId: 'agent-a' };
delete metadata.secret;
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
    assert.equal(request.headers.authorization, `Bearer ${identity.secret}`);
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
  const path = writeProfile(privateDirectory(t), { version: 1, origin, ...identity });
  const mcp = await connect(t, path);
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
  const reader = new Reader(parseAccess({ version: 1, origin, ...identity }));
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

test('pairing is a one-shot exchange with no output, no redirects, no overwrite and bounded invitation and host input', { timeout: 15_000 }, async t => {
  const directory = privateDirectory(t), invitation = JSON.stringify({ ok: true, value: { hostId: identity.hostId, code: 'i'.repeat(32) } });
  let scenario = 'valid', requests = 0, targetHits = 0;
  const target = await listen(t, (_, response) => { targetHits++; response.end('{}'); });
  const origin = await listen(t, async (request, response) => {
    const input = await readRequest(request);
    if (request.url === '/native/v1/pair') {
      requests++;
      assert.equal(request.headers.authorization, undefined);
      assert.deepEqual(input, { version: 1, hostId: identity.hostId, code: 'i'.repeat(32) });
      if (scenario === 'redirect') { response.writeHead(307, { location: target }); response.end(); }
      else if (scenario === 'oversized') response.end('x'.repeat(4097));
      else if (scenario === 'malformed') response.end('{');
      else if (scenario === 'lost') response.destroy();
      else reply(response, scenario === 'host' ? { ...identity, hostId: 'foreign' } : identity);
    } else reply(response, scenario === 'metadata-host' ? { ...metadata, hostId: 'foreign' } : metadata);
  });
  for (scenario of ['valid', 'host', 'metadata-host', 'redirect', 'oversized', 'malformed', 'lost']) {
    const path = join(directory, scenario), before = requests;
    const result = await cli(['pair', origin, path], invitation);
    assert.equal(result.code, scenario === 'valid' ? 0 : 1, scenario);
    assert.equal(result.stdout, '');
    assert.ok(!result.stderr.includes(identity.secret) && !result.stderr.includes('i'.repeat(32)));
    assert.equal(requests, before + 1, scenario);
    assert.equal(existsSync(path), scenario === 'valid');
  }
  assert.equal(targetHits, 0);
  const stored = readFileSync(join(directory, 'valid'), 'utf8'), before = requests;
  assert.equal((await cli(['pair', origin, join(directory, 'valid')], invitation)).code, 1);
  assert.equal(readFileSync(join(directory, 'valid'), 'utf8'), stored);
  for (const input of ['{', 'x'.repeat(4097), JSON.stringify({ hostId: 'a', code: 'b' })]) {
    const path = join(directory, 'invalid');
    assert.equal((await cli(['pair', origin, path], input)).code, 1);
    assert.equal(existsSync(path), false);
  }
  assert.equal(requests, before);
});

test('private profiles reject noncanonical origins, oversized files, loose directories, symlink directories and checkout storage', async t => {
  const directory = privateDirectory(t), record = { version: 1, origin: 'http://127.0.0.1:7140', ...identity };
  for (const origin of ['https://127.0.0.1:7140', 'http://localhost:7140', 'http://127.0.0.1:7140/',
    'http://user@127.0.0.1:7140', 'http://127.0.0.1:7140?secret=x', 'http://127.0.0.1:7140#x', 'http://127.0.0.1:0', 'http://127.0.0.1:99999']) {
    assert.throws(() => parseAccess({ ...record, origin }));
  }
  const large = join(directory, 'large'); writeFileSync(large, 'x'.repeat(4097), { mode: 0o600 });
  await assert.rejects(loadAccess(large));
  const loose = join(directory, 'loose'); mkdirSync(loose, { mode: 0o700 });
  const path = writeProfile(loose, record);
  chmodSync(loose, 0o755); await assert.rejects(loadAccess(path));
  const link = join(directory, 'link'); symlinkSync(loose, link);
  await assert.rejects(loadAccess(join(link, 'profile.json')));
  await assert.rejects(loadAccess(new URL('../../../../examples/mcp-control/read/profile.json', import.meta.url).pathname));
});
