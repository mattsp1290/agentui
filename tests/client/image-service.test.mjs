import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createBrowserConnection, ServiceProtocolError } from '@agentui/client/service';
import { createMacConnection } from '@agentui/client/mac';
import { canonicalJson, parseCommand } from '@agentui/contracts';
import { parseServiceRequest, parseServiceResponse, SERVICE_MAX_RESPONSE_BYTES } from '@agentui/contracts/service';
import { IMAGE_MAX_BYTES, IMAGE_TRANSFER_MAX_BYTES, parseImageBase64 } from '@agentui/contracts/image';

const scope = { hostId: 'host', conversationId: 'chat' }, imageId = randomUUID();
const attachment = { imageId, name: 'Screen', mediaType: 'image/png', byteLength: 1, width: 1, height: 1 };
const responseValue = () => ({ scope, attachment, base64: 'AA==' });
const reply = value => new Response(JSON.stringify({ ok: true, value }), { headers: { 'Content-Type': 'application/json' } });

test('image read responses validate complete metadata, canonical bytes and requested identity', async () => {
  let value = responseValue();
  const client = createBrowserConnection({ fetch: async path => { assert.equal(path, '/api/v1/images'); return reply(value); } });
  assert.deepEqual(await client.readImage(scope, imageId), { attachment, bytes: new Uint8Array([0]) });
  for (const change of [
    { scope: { ...scope, hostId: 'foreign' } }, { scope: { ...scope, conversationId: 'other' } },
    { attachment: { ...attachment, imageId: randomUUID() } }, { attachment: { ...attachment, byteLength: 2 } },
    { attachment: { ...attachment, width: 8193 } }, { attachment: { ...attachment, width: 4001, height: 4000 } },
    { attachment: { ...attachment, name: 'x'.repeat(161) } }, { attachment: { ...attachment, mediaType: 'image/gif' } },
    { attachment: { ...attachment, path: '/private/file' } }, { base64: 'AB==' }, { base64: 'AA==\n' },
  ]) {
    value = { ...responseValue(), ...change };
    await assert.rejects(client.readImage(scope, imageId), ServiceProtocolError);
  }
});

test('typed uploads check bounds before transport and preserve exact input after host errors', async () => {
  const bytes = new Uint8Array([0, 1, 2]), uploadId = randomUUID();
  let calls = 0;
  const client = createBrowserConnection({ fetch: async (_path, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init.body), { op: 'image-upload', scope, uploadId, name: 'Screen', byteLength: 3, base64: 'AAEC' });
    return new Response(JSON.stringify({ ok: false, error: { kind: 'image-capacity', message: 'Storage is full' } }),
      { status: 507, headers: { 'Content-Type': 'application/json' } });
  } });
  for (const input of [new Uint8Array(), new Uint8Array(IMAGE_MAX_BYTES + 1)]) {
    await assert.rejects(client.uploadImage({ scope, uploadId, name: 'Screen', bytes: input }));
  }
  assert.equal(calls, 0);
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(client.uploadImage({ scope, uploadId, name: 'Screen', bytes }), error => error.kind === 'image-capacity');
    assert.deepEqual(bytes, new Uint8Array([0, 1, 2]));
  }
  assert.equal(calls, 2);
  assert.throws(() => parseServiceResponse({ op: 'metadata' }, { ok: false, error: { kind: 'image-capacity', message: 'full' } }));
  assert.throws(() => parseServiceResponse({ op: 'image-read' }, { ok: false, error: { kind: 'image-integrity', message: 'x'.repeat(257) } }));
});

test('base64 lengths and pad bits agree before decode, including the exact 4 MiB boundary', () => {
  for (const length of [1, 2, 3, 4, IMAGE_MAX_BYTES]) {
    const encoded = Buffer.alloc(length, 255).toString('base64');
    assert.equal(parseImageBase64(encoded, length), encoded);
    assert.throws(() => parseImageBase64(encoded, length + 1));
  }
  for (const value of ['AB==', 'AAB=', 'AA==AA==', 'AA-_', 'AA==\n', 'AA', '', '====', 'A'.repeat(5_592_412)]) {
    assert.throws(() => parseImageBase64(value, 1));
  }
});

test('only image operations receive the larger browser and native response allowance', async () => {
  const payload = Buffer.alloc(IMAGE_MAX_BYTES).toString('base64');
  const value = { scope, attachment: { ...attachment, byteLength: IMAGE_MAX_BYTES }, base64: payload };
  const body = JSON.stringify({ ok: true, value });
  assert.ok(body.length > SERVICE_MAX_RESPONSE_BYTES);
  for (const client of [createBrowserConnection({ fetch: async () => reply(value) }),
    createMacConnection({ kind: 'ready', hostId: 'host', principalId: 'owner', observation: 'current' }, async () => ({ status: 200, body }))]) {
    assert.equal((await client.readImage(scope, imageId)).bytes.length, IMAGE_MAX_BYTES);
    await assert.rejects(client.metadata());
  }
  let cancelled = false;
  const oversized = createBrowserConnection({ fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
    { headers: { 'Content-Type': 'application/json', 'Content-Length': String(IMAGE_TRANSFER_MAX_BYTES + 1) } }) });
  await assert.rejects(oversized.readImage(scope, imageId), ServiceProtocolError);
  assert.equal(cancelled, true);
  const streamed = createBrowserConnection({ fetch: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(IMAGE_TRANSFER_MAX_BYTES + 1)); controller.close();
  } }), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(streamed.readImage(scope, imageId), ServiceProtocolError);
});

test('image transfer never changes text command fields or canonical bytes', () => {
  const command = { version: 1, scope, clientCommandId: 'command', body: { kind: 'send', text: 'Hello\n😀' } };
  const before = '{"body":{"kind":"send","text":"Hello\\n😀"},"clientCommandId":"command","scope":{"conversationId":"chat","hostId":"host"},"version":1}';
  assert.equal(canonicalJson(command), before);
  assert.deepEqual(parseServiceRequest({ op: 'submit', command }), { op: 'submit', command });
  assert.equal(canonicalJson(parseCommand(command)), before);
  assert.throws(() => parseServiceRequest({ op: 'submit', command: { ...command, body: { ...command.body, image: attachment } } }));
  assert.throws(() => parseServiceRequest({ op: 'image-upload', scope, uploadId: randomUUID(), name: 'Screen', bytes: [0] }));
});

test('typed upload rejects replies for a different scope, name or byte length', async () => {
  let value = { scope, attachment };
  const client = createBrowserConnection({ fetch: async () => reply(value) });
  const input = { scope, name: 'Screen', uploadId: randomUUID(), bytes: new Uint8Array([0]) };
  assert.deepEqual(await client.uploadImage(input), attachment);
  for (const change of [
    { scope: { ...scope, conversationId: 'other' } },
    { attachment: { ...attachment, name: 'Different' } },
    { attachment: { ...attachment, byteLength: 2 } },
  ]) {
    value = { scope, attachment, ...change };
    await assert.rejects(client.uploadImage(input), ServiceProtocolError);
  }
});
