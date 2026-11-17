import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createBrowserConnection } from '@agentui/client/service';
import { createMacConnection } from '@agentui/client/mac';
import { IMAGE_MAX_BYTES, IMAGE_TRANSFER_MAX_BYTES, IMAGE_BODY_TIMEOUT_MS } from '@agentui/contracts/image';
import { SERVICE_MAX_REQUEST_BYTES } from '@agentui/contracts/service';
import { SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import { openRecordedHost, recordedInstallation } from '@agentui/host/recorded';
import { openAccessDatabase } from '../../apps/host/build/tsc/access-database.js';
import { createApi } from '../../apps/host/build/tsc/api.js';
import { FeedRegistry } from '../../apps/host/build/tsc/feed-registry.js';
import { NO_OBSERVABILITY } from '../../apps/host/build/tsc/observability.js';
import { serviceEndpoint } from '../../apps/host/build/tsc/service-endpoint.js';
import { png, chunk, screenshotPng, screenshotJpeg } from '../host/image-fixtures.mjs';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-images-')), path = join(directory, 'host.sqlite');
  const access = openAccessDatabase(path), feeds = new FeedRegistry();
  const host = openRecordedHost({ path, backendPath: join(directory, 'recorded.jsonl'), hostId: access.hostId });
  const scope = { hostId: access.hostId, conversationId: 'images' };
  host.createConversation(scope, recordedInstallation);
  const compatibility = { wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: RECORDED_RUNTIME,
    desiredGitRevision: 'test', appliedArtifact: { artifactId: 'test', gitRevision: 'test' } };
  const api = createApi({ host, feeds, compatibility, isClosing: () => false,
    agentSelection: { kind: 'native', defaultInstallation: recordedInstallation, agents: [{ installation: recordedInstallation, availability: { kind: 'ready' } }] } });
  const handlers = Object.fromEntries(['native', 'browser-development'].map(client =>
    [client, serviceEndpoint({ hostId: access.hostId, api, client, isClosing: () => false, files: new Map(), observability: NO_OBSERVABILITY })]));
  const incoming = [], responses = [];
  const server = createServer((request, response) => {
    incoming.push(request); responses.push(response);
    void handlers[request.url.startsWith('/native/') ? 'native' : 'browser-development'](request, response).catch(() => response.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = kind => ({ 'Content-Type': 'application/json', ...(kind === 'native' ? {} : { Origin: origin }) });
  const route = kind => kind === 'native' ? '/native/v1/images' : '/api/v1/images';
  const call = async (kind, value, options = {}) => {
    const response = await fetch(origin + (options.path ?? route(kind)), { method: 'POST', headers: options.headers ?? headers(kind),
      body: JSON.stringify(value), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json() };
  };
  const clients = {
    'browser-development': createBrowserConnection({ fetch: (path, init) => fetch(origin + path, { ...init, headers: headers('browser-development') }) }),
    native: createMacConnection({ observation: 'fixture', hostId: access.hostId, principalId: 'trusted-owner' }, async command => {
      assert.equal(command.kind, 'execute');
      assert.equal(command.observation, 'fixture');
      assert.deepEqual(Object.keys(command).sort(), ['kind', 'observation', 'request']);
      const image = command.request.op.startsWith('image-');
      const result = await call('native', command.request, { path: image ? route('native') : '/native/v1' });
      return { status: result.status, body: JSON.stringify(result.body) };
    }),
  };
  const database = new DatabaseSync(path);
  const count = () => database.prepare('SELECT COUNT(*) AS count FROM images').get().count;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    feeds.dispose(); host.close(); await host.drained; database.close(); access.database.close(); rmSync(directory, { recursive: true, force: true });
  });
  const start = (kind, options = {}) => {
    const outgoing = httpRequest(origin + route(kind), { method: 'POST', headers: { ...headers(kind), ...options.headers } });
    const result = new Promise((resolve, reject) => {
      outgoing.once('error', reject);
      outgoing.once('response', response => {
        let text = '';
        response.setEncoding('utf8').on('data', part => { text += part; });
        response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) }));
        response.on('error', reject);
      });
    });
    outgoing.flushHeaders();
    return { outgoing, result };
  };
  return { access, host, scope, clients, call, count, headers, incoming, start, responses };
}
const upload = (scope, bytes = png(), changes = {}) => ({ op: 'image-upload', scope, uploadId: randomUUID(), name: 'Screen.png',
  byteLength: bytes.length, base64: bytes.toString('base64'), ...changes });

for (const kind of ['browser-development', 'native']) {
  test(`${kind} typed image operations persist exact views, retry after lost reply and share owner reads`, async t => {
    const f = await fixture(t), client = f.clients[kind];
    for (const bytes of [screenshotPng(), screenshotJpeg()]) {
      const source = Buffer.concat([Buffer.from('prefix'), bytes, Buffer.from('suffix')]);
      const view = new Uint8Array(source.buffer, source.byteOffset + 6, bytes.length), uploadId = randomUUID();
      const attachment = await client.uploadImage({ scope: f.scope, uploadId, name: 'Screenshot', bytes: view });
      assert.equal(attachment.byteLength, bytes.length);
      const retry = await client.uploadImage({ scope: f.scope, uploadId, name: 'Screenshot', bytes: view });
      assert.deepEqual(retry, attachment);
      const read = await f.clients[kind === 'native' ? 'browser-development' : 'native'].readImage(f.scope, attachment.imageId);
      assert.deepEqual(read.attachment, attachment);
      assert.deepEqual(Buffer.from(read.bytes), bytes);
      await assert.rejects(client.uploadImage({ scope: f.scope, uploadId, name: 'Different', bytes: view }), error => error.kind === 'image-upload-conflict');
      await assert.rejects(client.uploadImage({ scope: f.scope, uploadId, name: 'Screenshot', bytes: png() }), error => error.kind === 'image-upload-conflict');
    }
    const lost = upload(f.scope);
    assert.equal((await f.call(kind, lost)).status, 200);
    const recovered = await client.uploadImage({ scope: f.scope, uploadId: lost.uploadId, name: lost.name, bytes: Buffer.from(lost.base64, 'base64') });
    assert.equal(f.count(), 3);
    assert.equal((await client.readImage(f.scope, recovered.imageId)).bytes.length, lost.byteLength);
    const other = { ...f.scope, conversationId: 'other' };
    f.host.createConversation(other, recordedInstallation);
    for (const scope of [other, { ...f.scope, conversationId: 'missing' }, { ...f.scope, hostId: 'wrong' }]) {
      await assert.rejects(client.readImage(scope, recovered.imageId), error => ['forbidden', 'image-scope'].includes(error.kind));
    }
    await assert.rejects(client.uploadImage({ scope: { ...f.scope, conversationId: 'missing' }, uploadId: randomUUID(), name: 'Screen', bytes: png() }), error => error.kind === 'image-scope');
    const otherClass = await f.call(kind === 'native' ? 'browser-development' : 'native', lost);
    assert.equal(otherClass.body.value.attachment.imageId, recovered.imageId);
    assert.equal(f.count(), 3);
    assert.equal(f.host.inspect(f.scope).snapshot.cursor, 0);
  });

  test(`${kind} admits one image transfer at a time across credential classes`, async t => {
    const f = await fixture(t);
    const waiting = f.start(kind);
    waiting.outgoing.write('{');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await f.call(kind === 'native' ? 'browser-development' : 'native', upload(f.scope))).status, 503);
    const body = JSON.stringify(upload(f.scope));
    waiting.outgoing.end(body.slice(1));
    assert.equal((await waiting.result).status, 200);
    assert.equal(f.count(), 1);
  });

  test(`${kind} rejects invalid framing, encoded bounds and corrupt input without a reference`, async t => {
    const f = await fixture(t), good = upload(f.scope);
    for (const changes of [
      { base64: '!!!!', byteLength: 3 }, { base64: 'AB==', byteLength: 1 }, { base64: 'AAB=', byteLength: 2 },
      { base64: 'AA==\n', byteLength: 1 }, { base64: 'AA-_', byteLength: 3 }, { base64: 'AA', byteLength: 1 },
      { byteLength: good.byteLength - 1 }, { byteLength: IMAGE_MAX_BYTES + 1 }, { byteLength: 0 },
      { base64: 'A'.repeat(5_592_412) }, { uploader: 'forged' }, { scope: undefined }, { name: 'x\n' },
      { imageId: '../private-file' },
    ]) assert.equal((await f.call(kind, { ...good, ...changes })).status, 400);
    const corrupt = await f.call(kind, upload(f.scope, Buffer.from('private decoder payload')));
    assert.equal(corrupt.body.error.kind, 'invalid-image');
    assert.doesNotMatch(JSON.stringify(corrupt), /private decoder payload/);
    assert.equal((await f.call(kind, good, { path: kind === 'native' ? '/native/v1' : '/api/v1' })).status, 400);
    assert.equal((await f.call(kind, { op: 'metadata' })).status, 400);
    const oversized = f.start(kind, { headers: { 'Content-Length': String(IMAGE_TRANSFER_MAX_BYTES + 1) } });
    assert.equal((await oversized.result).status, 400); oversized.outgoing.destroy();
    assert.equal(f.count(), 0);
    assert.equal(f.host.inspect(f.scope).snapshot.cursor, 0);
  });
}

test('maximum compressed image traverses the ordinary typed HTTP path with 6 MiB response framing', async t => {
  const f = await fixture(t), small = png();
  const bytes = png({ extra: [chunk('tEXt', Buffer.alloc(IMAGE_MAX_BYTES - small.length - 12, 65))] });
  assert.equal(bytes.length, IMAGE_MAX_BYTES);
  assert.ok(bytes.toString('base64').length > SERVICE_MAX_REQUEST_BYTES);
  const attachment = await f.clients['browser-development'].uploadImage({ scope: f.scope, uploadId: randomUUID(), name: 'Maximum.png', bytes });
  assert.deepEqual(Buffer.from((await f.clients.native.readImage(f.scope, attachment.imageId)).bytes), bytes);
});

test('partial uploads time out after the image body deadline and release ingress', { timeout: 40_000 }, async t => {
  const f = await fixture(t), partial = f.start('native');
  partial.outgoing.write('{');
  const started = performance.now();
  await assert.rejects(partial.result);
  assert.ok(performance.now() - started >= IMAGE_BODY_TIMEOUT_MS - 1000);
  assert.equal(f.count(), 0);
  assert.equal((await f.call('native', upload(f.scope))).status, 200);
});


test('a dropped committed upload reply retries to its original reference and aborted bodies never commit', async t => {
  const f = await fixture(t), body = upload(f.scope);
  const original = f.host.uploadImage;
  f.host.uploadImage = (...args) => {
    const result = original(...args);
    f.responses.at(-1).destroy();
    f.host.uploadImage = original;
    return result;
  };
  await assert.rejects(f.call('native', body));
  assert.equal(f.count(), 1);
  const retry = await f.call('native', body);
  assert.equal(retry.status, 200);
  assert.equal(f.count(), 1);
  assert.equal((await f.call('native', body)).body.value.attachment.imageId, retry.body.value.attachment.imageId);
  const partial = f.start('native');
  partial.outgoing.write('{');
  await new Promise(resolve => setTimeout(resolve, 20));
  partial.outgoing.destroy(new Error('Client cancelled'));
  await assert.rejects(partial.result);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.count(), 1);
  assert.equal((await f.call('native', upload(f.scope))).status, 200);
});

test('image routes preserve browser origin and native header rules before accepting a body', async t => {
  const f = await fixture(t);
  for (const [kind, headers] of [
    ['browser-development', { Origin: 'https://foreign.example' }],
    ['native', { Origin: 'http://127.0.0.1' }],
    ['native', { Cookie: 'unexpected=value' }],
  ]) {
    const pending = f.start(kind, { headers: { ...headers, 'Content-Length': String(IMAGE_TRANSFER_MAX_BYTES) } });
    assert.equal((await pending.result).status, 400);
    assert.equal(f.incoming.at(-1).complete, false);
    pending.outgoing.destroy();
  }
  assert.equal(f.count(), 0);
});

test('chunked image bodies are bounded even without a declared length', async t => {
  const f = await fixture(t), pending = f.start('native');
  pending.outgoing.end(' '.repeat(IMAGE_TRANSFER_MAX_BYTES + 1));
  const result = await pending.result.catch(error => error);
  assert.ok(result instanceof Error || result.status === 400);
  assert.equal(f.count(), 0);
  assert.equal((await f.call('native', upload(f.scope))).status, 200);
});
