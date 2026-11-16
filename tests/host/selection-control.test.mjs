import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { formatControlResponse, parseControlRequest, requestControl } from '../../apps/host/build/tsc/control.js';
import { parseReceiptChunk, RECEIPT_LIMIT } from '../../apps/host/build/tsc/selection-protocol.js';

const main = fileURLToPath(new URL('../../apps/host/dist/main.js', import.meta.url));
const hash = 'a'.repeat(64);
const operation = { id: 'first', revision: 1, receiptDigest: hash, artifacts: 0, attemptId: null, outcome: { kind: 'staged' } };
const status = { kind: 'ready', desiredRevision: 1, desired: operation, operation, lastApplied: null, runtime: { kind: 'withheld' } };

test('control codecs enforce raw chunk, total receipt and framed UTF-8 byte limits', async () => {
  const chunk = { digest: hash, offset: 0, next: 8192, total: RECEIPT_LIMIT, base64: Buffer.alloc(8192).toString('base64') };
  assert.deepEqual(parseReceiptChunk(chunk), chunk);
  for (const changed of [{ total: RECEIPT_LIMIT + 1 }, { next: 8193, base64: Buffer.alloc(8193).toString('base64') },
    { offset: 8192 }, { base64: 'YQ' }, { base64: '!'.repeat(8192) }, { digest: 'invalid' }]) {
    assert.throws(() => parseReceiptChunk({ ...chunk, ...changed }));
  }
  const base = Buffer.byteLength(formatControlResponse({ ok: true, value: { code: '' } }));
  assert.equal(Buffer.byteLength(formatControlResponse({ ok: true, value: { code: 'x'.repeat(16000 - base) } })), 16000);
  assert.throws(() => formatControlResponse({ ok: true, value: { code: 'x'.repeat(16001 - base) } }), /too large/);
  assert.throws(() => formatControlResponse({ ok: true, value: { code: '雪'.repeat(6000) } }), /too large/);
  await assert.rejects(requestControl('/missing-control', { op: 'revoke', id: '雪'.repeat(1400) }), /too large/);
  assert.throws(() => parseControlRequest({ op: 'extensions-select', command: { id: 'x', expectedRevision: 0, selection: { version: 1, artifacts: [], secret: 'PRIVATE' } } }));
  assert.throws(() => parseControlRequest({ op: 'extensions-status', query: { kind: 'selection', id: 'non-ascii-雪' } }));
});

for (const [name, change] of [
  ['wrong offset', chunk => ({ ...chunk, offset: 1, next: 3, total: 3 })],
  ['wrong digest', chunk => ({ ...chunk, digest: 'b'.repeat(64) })],
  ['wrong full receipt hash', chunk => chunk],
  ['oversize receipt', chunk => ({ ...chunk, total: RECEIPT_LIMIT + 1 })],
]) test(`packaged CLI refuses ${name} before exporting a receipt`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer(socket => {
    let text = '';
    socket.on('data', bytes => {
      text += bytes;
      if (!text.includes('\n')) return;
      const request = JSON.parse(text);
      socket.end(JSON.stringify({ ok: true, value: request.op === 'extensions-status' ? status :
        change({ digest: hash, offset: 0, next: 2, total: 2, base64: Buffer.from('{}').toString('base64') }) }) + '\n');
    });
  });
  server.listen(join(directory, 'control.sock')); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const output = join(directory, 'receipt.json');
  await assert.rejects(promisify(execFile)(process.execPath, [main, 'extensions-status', '--data-dir', directory, '--receipt', output]));
  await assert.rejects(readFile(output), { code: 'ENOENT' });
});

for (const command of ['extensions-apply', 'extensions-retry']) test(`${command} uses strict request fields and rejects unrelated packaged flags`, async () => {
  const kind = command === 'extensions-apply' ? 'apply' : 'retry';
  const request = { kind, requestId: 'request', selectionId: 'selection', expectedRevision: 1, ...(kind === 'retry' ? { afterAttemptId: 'previous' } : {}) };
  assert.deepEqual(parseControlRequest({ op: 'extensions-live', request }), { op: 'extensions-live', request });
  for (const changed of [{ ...request, selection: { version: 1, artifacts: [] } }, { ...request, requestId: '雪' }, { ...request, expectedRevision: -1 }, { ...request, grants: [] }, { ...request, kind: 'boot' },
    { ...request, afterAttemptId: kind === 'apply' ? 'unexpected' : undefined }]) {
    assert.throws(() => parseControlRequest({ op: 'extensions-live', request: changed }));
  }
  for (const op of ['extensions-apply', 'extensions-retry']) assert.throws(() => parseControlRequest({ op, request }));
  assert.throws(() => parseControlRequest({ op: 'extensions-live', request, extra: true }));
  for (const flag of ['--selection', '--receipt', '--attempt']) await assert.rejects(promisify(execFile)(process.execPath, [main, command, '--data-dir', '/missing', flag, 'value']), /not valid/);
  await assert.rejects(promisify(execFile)(process.execPath, [main, 'extensions-status', '--data-dir', '/missing', '--operation', 'selection', '--attempt', 'request']), /Use --operation or --attempt/);
});

for (const kind of ['apply', 'retry']) for (const reply of ['lost', 'refused']) test(`packaged ${kind} emits one live envelope and preserves ${reply} reply guidance`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agentui-live-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const server = createServer(socket => {
    let text = '';
    socket.on('data', bytes => {
      text += bytes;
      if (!text.includes('\n')) return;
      requests.push(JSON.parse(text));
      if (reply === 'lost') socket.destroy();
      else socket.end(JSON.stringify({ ok: false, error: 'Selection attempt-conflict' }) + '\n');
    });
  });
  server.listen(join(directory, 'control.sock')); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const flags = ['--operation', 'selection', '--expected-revision', '1', '--request', 'request',
    ...(kind === 'retry' ? ['--after-attempt', 'previous'] : [])];
  await assert.rejects(promisify(execFile)(process.execPath, [main, 'extensions-' + kind, '--data-dir', directory, ...flags]), error => {
    assert.equal(error.stderr.trim(), reply === 'lost' ? 'Selection reply unavailable; inspect --attempt or resend the identical --request' : 'Selection attempt-conflict');
    return true;
  });
  assert.deepEqual(requests, [{ op: 'extensions-live', request: { kind, requestId: 'request', selectionId: 'selection', expectedRevision: 1,
    ...(kind === 'retry' ? { afterAttemptId: 'previous' } : {}) } }]);
});
