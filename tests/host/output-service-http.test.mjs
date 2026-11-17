import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createBrowserConnection } from '@agentui/client/service';
import { canonicalJson } from '@agentui/contracts';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import { startBrowserHost } from '../../apps/host/build/tsc/server.js';
import { instance } from '../../examples/generated-text-output/dist/model.js';

const directoryOf = relative => fileURLToPath(new URL(relative, import.meta.url));
const installed = { kind: 'installed', directory: directoryOf('../../examples/generated-text-output/'),
  manifest: { namespace: 'reports', trust: 'full', sdkVersion: EXTENSION_SDK_VERSION, entries: [{ kind: 'server', module: './dist/server.js' }] },
  installations: [{ id: 'reports', instance, service: 'http://127.0.0.1:1', expectedAuthority: 'remote-provider', authentication: { kind: 'unauthenticated' } }] };

test('actual HTTP public client uses installed report producer through create, replay, reopen and 33-output eviction', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-output-http-'));
  const previous = process.env.AGENTUI_REPORT_DATABASE;
  process.env.AGENTUI_REPORT_DATABASE = join(directory, 'reports.sqlite');
  let running, origin;
  const record = value => { if (process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES) appendFileSync(process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES, `${JSON.stringify(value)}\n`); };
  record({ kind: 'temporary-directory', path: directory, pid: process.pid });
  const start = async () => {
    running = await startBrowserHost({ directory: join(directory, 'host'), port: 0, agentStartup: { kind: 'extensions' },
      assetsDirectory: directoryOf('../../apps/desktop/web-dist-browser/'), hostArtifactDirectory: directoryOf('../../apps/host/dist/'),
      extensions: { kind: 'transient', entries: [installed] } });
    origin = running.origin;
    record({ kind: 'listener', origin, pid: process.pid });
  };
  const requests = [];
  const client = createBrowserConnection({ fetch: async (path, init) => {
    requests.push({ path, op: JSON.parse(init.body).op });
    return fetch(`${origin}${path}`, { ...init, headers: { ...init.headers, Origin: origin } });
  } });
  const scope = { hostId: '', conversationId: 'reports' };
  const send = (text, clientCommandId) => client.conversation(scope).submit({ version: 1, scope, clientCommandId, body: { kind: 'send', text } });
  try {
    await start(); scope.hostId = running.hostId;
    const agentId = (await client.metadata()).agents.find(agent => agent.namespace === 'reports').id;
    assert.deepEqual(await client.create(scope, agentId), scope);
    assert.deepEqual(await client.conversationOutputs(scope), { kind: 'available', outputs: [] });
    const text = '\ufeffReport é🐦\n\r\t\u0000', commandId = randomUUID();
    const first = await send(text, commandId);
    assert.equal(first.receipt.state.kind, 'completed');
    const listing = await client.conversationOutputs(scope), outputId = listing.outputs[0].outputId;
    assert.equal(listing.kind, 'available'); assert.equal(listing.outputs.length, 1);
    assert.deepEqual((await client.readOutput(scope, outputId)).bytes, new TextEncoder().encode(text));
    const saved = await client.readOutput(scope, outputId);
    const secondView = createBrowserConnection({ fetch: (path, init) => fetch(`${origin}${path}`, { ...init, headers: { ...init.headers, Origin: origin } }) });
    assert.deepEqual(await secondView.readOutput(scope, outputId), saved);
    assert.deepEqual(await send(text, commandId), first);
    assert.deepEqual(await client.reconcile(scope, commandId), first.receipt);
    assert.equal((await send('different', commandId)).kind, 'rejected');
    assert.equal((await send('', randomUUID())).kind, 'rejected');
    assert.equal((await send('x'.repeat(64_001), randomUUID())).kind, 'rejected');
    const cappedId = randomUUID(), emptyCommand = { version: 1, scope, clientCommandId: cappedId, body: { kind: 'send', text: '' } };
    const cappedText = 'x'.repeat(64_000 - Buffer.byteLength(canonicalJson(emptyCommand)));
    assert.equal((await send(cappedText, cappedId)).kind, 'rejected');
    const acceptedText = 'x'.repeat(63_000);
    const maxCommand = await send(acceptedText, randomUUID());
    assert.equal(maxCommand.kind, 'receipt', JSON.stringify(maxCommand));
    assert.equal(maxCommand.receipt.state.kind, 'completed');
    const maxCommandListing = await client.conversationOutputs(scope);
    assert.equal((await client.readOutput(scope, maxCommandListing.outputs.find(output => output.byteLength === acceptedText.length).outputId)).bytes.length, acceptedText.length);
    await assert.rejects(client.conversationOutputs({ ...scope, hostId: 'foreign' }), error => error.kind === 'forbidden');
    await assert.rejects(client.readOutput({ ...scope, hostId: 'foreign' }, outputId), error => error.kind === 'forbidden');
    await running.close(); running = undefined;
    const originalEncode = TextEncoder.prototype.encode;
    const encodedOriginal = t.mock.method(TextEncoder.prototype, 'encode', function(value) {
      assert.notEqual(value, text, 'Restart/replay/read regenerated retained text');
      return originalEncode.call(this, value);
    });
    await start();
    assert.deepEqual(await client.create(scope, agentId), scope);
    assert.deepEqual(await send(text, commandId), first);
    assert.deepEqual(await client.reconcile(scope, commandId), first.receipt);
    assert.deepEqual(await client.readOutput(scope, outputId), saved);
    encodedOriginal.mock.restore();
    for (let index = 2; index < 33; index++) assert.equal((await send(`report ${index}`, randomUUID())).receipt.state.kind, 'completed');
    const retained = await client.conversationOutputs(scope);
    assert.equal(retained.outputs.length, 32);
    assert.equal(retained.outputs.some(output => output.outputId === outputId), false);
    assert.deepEqual(await client.readOutput(scope, outputId), { kind: 'missing', reason: 'output-missing' });
    const beforeReplay = retained.outputs.map(output => output.outputId);
    assert.deepEqual(await send(text, commandId), first);
    assert.deepEqual(await client.reconcile(scope, commandId), first.receipt);
    assert.deepEqual((await client.conversationOutputs(scope)).outputs.map(output => output.outputId), beforeReplay);
    assert.deepEqual(await client.readOutput(scope, outputId), { kind: 'missing', reason: 'output-missing' });
    assert.ok(requests.every(request => request.path === '/api/v1'));
    for (const op of ['create', 'submit', 'output-list', 'output-read', 'reconcile']) assert.ok(requests.some(request => request.op === op));
    await running.close(); running = undefined;
    const db = new DatabaseSync(process.env.AGENTUI_REPORT_DATABASE);
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM payloads').get().count, 32);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM receipts').get().count > 32, true);
    } finally { db.close(); }
    t.diagnostic('Real loopback HTTP /api/v1 with normally installed SDK 0.9 report server entry; no LocalHost output/read calls in the consumer.');
  } finally {
    if (running) await running.close();
    if (previous === undefined) delete process.env.AGENTUI_REPORT_DATABASE; else process.env.AGENTUI_REPORT_DATABASE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('normal SDK boundary provider fixture carries zero and 65536 byte outputs through actual HTTP', async t => {
  const { providerFixture } = await import('./provider-outputs-fixture.mjs');
  const f = providerFixture(), directory = mkdtempSync(join(tmpdir(), 'agentui-output-http-boundary-'));
  if (process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES) appendFileSync(process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES,
    `${JSON.stringify({ kind: 'temporary-directory', path: directory, pid: process.pid })}\n`);
  let running;
  try {
    running = await startBrowserHost({ directory: join(directory, 'host'), port: 0, agentStartup: { kind: 'extensions' },
      assetsDirectory: directoryOf('../../apps/desktop/web-dist-browser/'), hostArtifactDirectory: directoryOf('../../apps/host/dist/'),
      extensions: { kind: 'transient', entries: [{ manifest: f.extension.manifest, entry: f.extension.entry,
        installations: [{ id: 'reports', instance: f.instance, service: 'http://127.0.0.1:1', expectedAuthority: 'remote-provider', authentication: { kind: 'unauthenticated' } }] }] } });
    if (process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES) appendFileSync(process.env.AGENTUI_OUTPUT_AUDIT_RESOURCES,
      `${JSON.stringify({ kind: 'listener', origin: running.origin, pid: process.pid })}\n`);
    const client = createBrowserConnection({ fetch: (path, init) => fetch(`${running.origin}${path}`, { ...init, headers: { ...init.headers, Origin: running.origin } }) });
    const scope = { hostId: running.hostId, conversationId: 'boundary-fixture' };
    await client.create(scope, (await client.metadata()).defaultAgentId);
    for (const bytes of [new Uint8Array(), new Uint8Array(65_536).fill(65)]) {
      f.state.bytes = bytes;
      const listing = await client.conversationOutputs(scope);
      assert.equal(listing.kind, 'available'); assert.equal(listing.outputs[0].byteLength, bytes.length);
      const result = await client.readOutput(scope, listing.outputs[0].outputId);
      assert.equal(result.kind, 'available'); assert.deepEqual(result.bytes, bytes);
    }
    t.diagnostic('SDK boundary fixture supplies zero/max provider payloads. Normal report producer and ordinary command validation remain unchanged.');
  } finally { if (running) await running.close(); rmSync(directory, { recursive: true, force: true }); }
});
