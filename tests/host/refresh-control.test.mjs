import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { formatControlResponse, parseControlRequest, requestControl, startControl } from '../../apps/host/build/tsc/control.js';
import { parseRefreshReceipt } from '../../apps/host/build/tsc/refresh-jobs.js';
import { chunkReceipt, RECEIPT_LIMIT } from '../../apps/host/build/tsc/selection-protocol.js';
import { databaseFixture, deferred, realFixture, request, rows } from './refresh-support.mjs';

const main = fileURLToPath(new URL('../../apps/host/dist/main.js', import.meta.url));
const hash = 'a'.repeat(64);
const query = { op: 'extensions-refresh-status', id: 'request' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function largeReceipt() {
  const directory = '/' + 'd'.repeat(3500) + '/attempt';
  const intent = request('request', { repository: '/' + 'r'.repeat(3500), commit: 'a'.repeat(40) });
  const builder = { identity: hash, esbuildVersion: '0.28.2' };
  const command = { id: 'attempt', requestId: intent.id, source: intent.reference, directory,
    toolchain: { kind: 'ready', node: '/' + 'n'.repeat(3500), entrySha256: hash, lockSha256: hash, builder } };
  const pin = { directory, artifactId: hash };
  const operation = { id: 'refresh.attempt', revision: 1, receiptDigest: hash, artifacts: 1, attemptId: null, outcome: { kind: 'staged' } };
  return { job: { request: intent, ordinal: 1, build: { kind: 'built', command, pin,
    provenance: { root: hash, sdkVersion: '1.0.0', builder, runtime: { engine: 'node', version: '24.22.3', modules: '137', abiIdentity: hash } } },
    promotion: { kind: 'selected', command: { id: operation.id, expectedRevision: 0, selection: { version: 1, artifacts: [pin] } }, operation } },
  latestRequestId: intent.id, selectionStatus: { kind: 'ready', desiredRevision: 1, desired: operation, operation, lastApplied: null, runtime: { kind: 'withheld' } } };
}
function frames(bytes) {
  const digest = createHash('sha256').update(bytes).digest('hex'), result = [];
  for (let offset = 0; offset < bytes.length;) {
    const chunk = chunkReceipt(bytes, digest, offset);
    result.push({ ok: true, value: chunk }); offset = chunk.next;
  }
  return result;
}
const wire = values => values.map(value => JSON.stringify(value) + '\n').join('');
async function directory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-refresh-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function fakeServer(t, send) {
  const root = await directory(t), path = join(root, 'control.sock'), requests = [];
  const server = createServer(socket => {
    socket.on('error', () => {});
    let text = '';
    socket.on('data', bytes => {
      text += bytes;
      if (!text.includes('\n')) return;
      requests.push(JSON.parse(text));
      Promise.resolve(send(socket)).catch(error => socket.destroy(error));
    });
  });
  server.listen(path); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { root, path, requests };
}

test('full receipt codec accepts every build and promotion branch and rejects extra or inconsistent saved fields', () => {
  const built = largeReceipt();
  assert.ok(Buffer.byteLength(JSON.stringify(built)) > 16000);
  assert.deepEqual(parseRefreshReceipt(built), built);
  for (const kind of ['unconfirmed', 'refused']) {
    const value = JSON.parse(JSON.stringify(built));
    value.job.promotion = { kind, command: value.job.promotion.command, ...(kind === 'refused' ? { reason: 'revision-conflict' } : {}) };
    assert.deepEqual(parseRefreshReceipt(value), value);
  }
  for (const kind of ['building', 'interrupted', 'failed']) {
    const value = JSON.parse(JSON.stringify(built));
    value.job.build = { kind, command: value.job.build.command, ...(kind === 'failed' ? { failure: 'build' } : {}) };
    value.job.promotion = { kind: 'not-built' };
    assert.deepEqual(parseRefreshReceipt(value), value);
  }
  for (const mutate of [
    r => { r.secret = 'PRIVATE'; }, r => { r.job.extra = true; }, r => { r.latestRequestId = ''; },
    r => { r.job.ordinal = 0; }, r => { r.job.request.extra = true; }, r => { r.job.build.extra = true; },
    r => { r.job.build.command.requestId = 'other'; }, r => { r.job.build.command.source.commit = 'b'.repeat(40); },
    r => { r.job.build.command.toolchain.extra = true; }, r => { r.job.build.pin.artifactId = 'invalid'; },
    r => { r.job.build.provenance.extra = true; }, r => { r.job.build.provenance.runtime.engine = 'other'; },
    r => { r.job.build.provenance.runtime.extra = true; }, r => { r.job.build.provenance.builder.identity = 'b'.repeat(64); },
    r => { r.job.promotion.command.expectedRevision = 1; }, r => { r.job.promotion.operation.artifacts = 2; },
    r => { r.job.promotion.extra = true; }, r => { r.selectionStatus.runtime.kind = 'unknown'; },
  ]) {
    const value = JSON.parse(JSON.stringify(built)); mutate(value); assert.throws(() => parseRefreshReceipt(value));
  }
});

for (const mode of ['fragmented', 'coalesced']) test(`refresh assembles ${mode} frames with complete saved commands beyond one old frame`, async t => {
  const receipt = largeReceipt(), encoded = frames(Buffer.from(JSON.stringify(receipt)));
  assert.ok(encoded.length > 1);
  assert.ok(encoded.every(frame => Buffer.byteLength(formatControlResponse(frame)) <= 16000));
  const server = await fakeServer(t, async socket => {
    const bytes = Buffer.from(wire(encoded));
    if (mode === 'coalesced') socket.end(bytes);
    else {
      for (let offset = 0; offset < bytes.length; offset += 47) {
        socket.write(bytes.subarray(offset, offset + 47));
        await new Promise(resolve => setImmediate(resolve));
      }
      socket.end();
    }
  });
  assert.deepEqual(await requestControl(server.path, query), { ok: true, value: receipt });
  assert.equal(server.requests.length, 1);
});

for (const mode of ['offset', 'digest', 'total', 'payload', 'truncated', 'partial', 'oversized', 'total-limit', 'trailing', 'trailing-partial', 'utf8-frame', 'utf8-body']) {
  test(`refresh rejects ${mode} on the real socket`, async t => {
    const encoded = frames(Buffer.from(JSON.stringify(largeReceipt())));
    if (mode === 'offset') encoded[1].value.offset++;
    if (mode === 'digest') encoded[1].value.digest = 'b'.repeat(64);
    if (mode === 'total') encoded[1].value.total++;
    if (mode === 'payload') encoded[0].value.base64 = Buffer.alloc(8192, 32).toString('base64');
    if (mode === 'truncated') encoded.pop();
    if (mode === 'total-limit') encoded[0].value.total = RECEIPT_LIMIT + 1;
    if (mode === 'trailing') encoded.push(encoded[0]);
    let bytes = Buffer.from(wire(encoded));
    if (mode === 'partial') bytes = bytes.subarray(0, bytes.length - 1);
    if (mode === 'trailing-partial') bytes = Buffer.concat([bytes, Buffer.from('{')]);
    if (mode === 'oversized') bytes = Buffer.from(' '.repeat(16000) + '{}\n');
    if (mode === 'utf8-frame') bytes = Buffer.from([0xff, 10]);
    if (mode === 'utf8-body') bytes = Buffer.from(wire(frames(Buffer.from([0xff]))));
    const server = await fakeServer(t, socket => socket.end(bytes));
    await assert.rejects(requestControl(server.path, query));
  });
}

test('refresh request envelope admits a 4096-byte domain intent while other request limits remain unchanged', async t => {
  const root = await directory(t), f = databaseFixture(t), owner = await f.open(), path = join(root, 'control.sock');
  const control = await startControl(path, {}, {}, () => false, owner.selection, async () => [], owner);
  t.after(() => control.close());
  const intent = request('maximum', { repository: '/source', commit: 'a'.repeat(40) });
  intent.reference.repository += 'r'.repeat(4096 - Buffer.byteLength(JSON.stringify(intent)));
  const reply = await requestControl(path, { op: 'extensions-refresh-request', request: intent });
  assert.equal(reply.value.job.request.reference.repository, intent.reference.repository);
  await assert.rejects(requestControl(path, { op: 'extensions-refresh-request', request: { ...intent, padding: 'x'.repeat(8192) } }), /too large/);
  assert.throws(() => parseControlRequest({ op: 'extensions-refresh-request', request: { ...intent, reference: { ...intent.reference, repository: intent.reference.repository + 'x' } } }));
  for (const op of ['extensions-refresh-status', 'extensions-refresh-promote']) {
    assert.throws(() => parseControlRequest({ op, id: 'maximum', command: {} }));
  }
  assert.equal((await requestControl(path, { op: 'extensions-refresh-status', id: 'maximum' })).value.job.build.failure, 'unavailable');
  assert.deepEqual(await requestControl(path, { op: 'extensions-refresh-status', id: 'unknown' }), { ok: false, error: 'Refresh unknown-request' });
});

for (const op of ['extensions-refresh-request', 'extensions-refresh-promote']) test(`${op} waits past initial deadline without repeating work`, { timeout: 15000 }, async t => {
  const root = await directory(t), path = join(root, 'control.sock'), receipt = largeReceipt();
  let calls = 0;
  const work = async () => { calls++; await sleep(5400); return receipt; };
  const control = await startControl(path, {}, {}, () => false, {}, async () => [], { request: work, promote: work });
  t.after(() => control.close());
  const input = op === 'extensions-refresh-request' ? { op, request: receipt.job.request } : { op, id: 'request' };
  assert.deepEqual(await requestControl(path, input), { ok: true, value: receipt });
  assert.equal(calls, 1);
});

for (const mode of ['no-first-frame', 'partial-first-frame', 'after-first-frame', 'after-complete-frame']) test(`refresh bounds inactivity ${mode}`, { timeout: 15000 }, async t => {
  const encoded = frames(Buffer.from(JSON.stringify(largeReceipt())));
  const server = await fakeServer(t, socket => {
    if (mode === 'partial-first-frame') socket.write('{');
    if (mode === 'after-first-frame') socket.write(wire([encoded[0]]));
    if (mode === 'after-complete-frame') socket.write(wire(encoded));
  });
  const input = mode === 'no-first-frame' ? query : { op: 'extensions-refresh-promote', id: 'request' };
  await assert.rejects(requestControl(server.path, input), /timed out/);
});

test('a slow reader is disconnected while unrelated control remains available', { timeout: 15000 }, async t => {
  const root = await directory(t), path = join(root, 'control.sock'), began = deferred();
  const receipt = largeReceipt();
  receipt.job.build.provenance.sdkVersion = 'x'.repeat(8 * 1024 * 1024);
  const control = await startControl(path, {}, {}, () => false, {}, async () => [], { inspect: async () => { began.resolve(); return receipt; } });
  t.after(() => control.close());
  const socket = createConnection(path);
  socket.on('error', () => {}); socket.pause();
  t.after(() => socket.destroy());
  await once(socket, 'connect'); socket.write(JSON.stringify(query) + '\n');
  await began.promise;
  assert.deepEqual(await requestControl(path, { op: 'providers-refresh' }), { ok: true, value: [] });
  await Promise.race([control.close(), sleep(10000).then(() => { throw new Error('Slow reader retained the server'); })]);
  socket.destroy();
});

for (const op of ['extensions-refresh-request', 'extensions-refresh-status', 'extensions-refresh-promote']) test(`packaged ${op} emits its exact envelope and reconstructs the full receipt`, async t => {
  const receipt = largeReceipt(), server = await fakeServer(t, socket => socket.end(wire(frames(Buffer.from(JSON.stringify(receipt))))));
  const source = join(server.root, 'source.json'); await writeFile(source, JSON.stringify(receipt.job.request.reference));
  const flags = ['--request', 'request', ...(op === 'extensions-refresh-request' ? ['--source', source, '--expected-revision', '0'] : [])];
  const result = await promisify(execFile)(process.execPath, [main, op, '--data-dir', server.root, ...flags]);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, value: receipt });
  assert.deepEqual(server.requests, [op === 'extensions-refresh-request' ? { op, request: receipt.job.request } : { op, id: 'request' }]);
  for (const invalid of [['--selection', source], ['--attempt', 'other'], ...(op === 'extensions-refresh-request' ? [] : [['--source', source], ['--expected-revision', '1']])]) {
    await assert.rejects(promisify(execFile)(process.execPath, [main, op, '--data-dir', server.root, ...flags, ...invalid]), /not valid/);
  }
});

test('packaged refresh loss names status and identical replay without resending', async t => {
  const server = await fakeServer(t, socket => socket.destroy());
  await assert.rejects(promisify(execFile)(process.execPath, [main, 'extensions-refresh-promote', '--data-dir', server.root, '--request', 'request']), error => {
    assert.match(error.stderr, /extensions-refresh-status --request ID.*identical extensions-refresh-request/); return true;
  });
  assert.equal(server.requests.length, 1);
});

test('disconnect preserves the canonical real build; status and exact replay never promote or rebuild; explicit promote reuses its saved pins', async t => {
  const f = await realFixture(t), owner = await f.open(), entered = deferred(), release = deferred();
  f.setRun(async command => { entered.resolve(); await release.promise; return f.actual(command); });
  const root = await directory(t), path = join(root, 'control.sock');
  const control = await startControl(path, {}, {}, () => false, owner.selection, async () => [], owner);
  t.after(() => control.close());
  t.after(() => release.resolve());
  const intent = request('lost', f.first), socket = createConnection(path);
  socket.on('error', () => {}); t.after(() => socket.destroy());
  await once(socket, 'connect'); socket.write(JSON.stringify({ op: 'extensions-refresh-request', request: intent }) + '\n');
  await entered.promise; socket.destroy();
  const before = rows(f.database);
  assert.equal((await requestControl(path, { op: 'extensions-refresh-status', id: 'lost' })).value.job.build.kind, 'building');
  assert.equal((await requestControl(path, { op: 'extensions-refresh-request', request: intent })).value.job.build.kind, 'building');
  assert.deepEqual(rows(f.database), before);
  release.resolve();
  let built;
  for (let i = 0; i < 100; i++) {
    built = (await requestControl(path, { op: 'extensions-refresh-status', id: 'lost' })).value;
    if (built.job.promotion.kind === 'selected') break;
    await sleep(50);
  }
  assert.equal(built.job.promotion.kind, 'selected');
  const promoted = await requestControl(path, { op: 'extensions-refresh-promote', id: 'lost' });
  assert.deepEqual(promoted.value.job.promotion.command, built.job.promotion.command);
  assert.equal(f.commands.length, 1);
  assert.equal(f.replacements(), 0);
  assert.equal(promoted.value.selectionStatus.runtime.kind, 'withheld');
});
