import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { canonicalJson } from '@agentui/contracts';
import { openReportExample } from '../dist/consumer.js';

for (const [name, text] of [['BOM-prefixed', '\ufeffReport preserves its first character. é🐦\n'], ['BOM-only', '\ufeff']]) {
  test(`public ${name} send preserves creation, receipt, output identity and exact bytes after restart`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'agentui-report-bom-'));
    const previous = process.env.AGENTUI_REPORT_DATABASE;
    process.env.AGENTUI_REPORT_DATABASE = join(directory, 'reports.sqlite');
    const options = { hostPath: join(directory, 'host.sqlite'), scope: { hostId: 'host', conversationId: 'bom' } };
    let example;
    try {
      example = await openReportExample(options);
      const id = randomUUID(), receipt = await example.send(text, id);
      assert.equal(receipt.receipt.state.kind, 'completed');
      const creation = example.host.creation(options.scope), listing = await example.outputs();
      assert.equal(listing.kind, 'available'); assert.equal(listing.outputs.length, 1);
      const output = listing.outputs[0], read = await example.read(output.outputId);
      assert.equal(read.kind, 'available');
      assert.deepEqual(read.bytes, new TextEncoder().encode(text));
      assert.deepEqual(read.bytes.slice(0, 3), Uint8Array.of(0xef, 0xbb, 0xbf));
      t.diagnostic(`${name} public send completed and original UTF-8 bytes were read before restart.`);
      await example.close(); example = undefined;
      const encode = t.mock.method(TextEncoder.prototype, 'encode', () => { throw new Error('Restart or replay re-encoded output'); });
      example = await openReportExample(options);
      assert.deepEqual(example.host.creation(options.scope), creation);
      assert.deepEqual(await example.send(text, id), receipt);
      assert.deepEqual(await example.host.reconcile(options.scope, id), receipt.receipt);
      assert.deepEqual(await example.outputs(), listing);
      assert.deepEqual(await example.read(output.outputId), read);
      assert.equal(encode.mock.callCount(), 0);
    } finally {
      try { if (example) await example.close(); }
      finally {
        if (previous === undefined) delete process.env.AGENTUI_REPORT_DATABASE; else process.env.AGENTUI_REPORT_DATABASE = previous;
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
}

test('public reopening rejects invalid UTF-8 even with matching payload length and digest without repair', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-report-invalid-utf8-'));
  const previous = process.env.AGENTUI_REPORT_DATABASE, path = join(directory, 'reports.sqlite');
  process.env.AGENTUI_REPORT_DATABASE = path;
  const options = { hostPath: join(directory, 'host.sqlite'), scope: { hostId: 'host', conversationId: 'invalid-utf8' } };
  let example;
  try {
    example = await openReportExample(options);
    assert.equal((await example.send('x', randomUUID())).receipt.state.kind, 'completed');
    await example.close(); example = undefined;
    const bytes = Uint8Array.of(0xff), db = new DatabaseSync(path);
    try {
      const metadata = JSON.parse(db.prepare('SELECT metadata FROM payloads').get().metadata);
      metadata.sha256 = createHash('sha256').update(bytes).digest('hex');
      assert.equal(metadata.byteLength, bytes.length);
      db.prepare('UPDATE payloads SET bytes=?, metadata=?').run(bytes, canonicalJson(metadata));
    } finally { db.close(); }
    const before = readFileSync(path);
    await assert.rejects(async () => { example = await openReportExample(options); }, /Provider activation failed/);
    assert.deepEqual(readFileSync(path), before);
  } finally {
    try { if (example) await example.close(); }
    finally {
      if (previous === undefined) delete process.env.AGENTUI_REPORT_DATABASE; else process.env.AGENTUI_REPORT_DATABASE = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('native host close failure remains visible and releases report ownership in a disposable child', () => {
  const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('./native-close-fault.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.match(stdout, /Report ownership released after the original native host close error/);
});
