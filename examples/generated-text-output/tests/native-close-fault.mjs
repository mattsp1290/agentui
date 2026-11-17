import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReportExample } from '../dist/consumer.js';

const directory = mkdtempSync(join(tmpdir(), 'agentui-report-close-fault-'));
process.env.AGENTUI_REPORT_DATABASE = join(directory, 'reports.sqlite');
const scope = { hostId: 'host', conversationId: 'close-fault' };
const options = { hostPath: join(directory, 'host.sqlite'), scope };
const close = DatabaseSync.prototype.close, failure = new Error('Injected native host close failure');
let failedDatabase, reopened;
try {
  const example = await openReportExample(options), creation = example.host.creation(scope);
  DatabaseSync.prototype.close = function () {
    if (!failedDatabase) { failedDatabase = this; throw failure; }
    return close.call(this);
  };
  await assert.rejects(example.close(), error => error === failure);
  DatabaseSync.prototype.close = close;
  assert.ok(failedDatabase);
  close.call(failedDatabase); failedDatabase = undefined;
  console.log('Original native host close error observed. Reopening the same report database.');
  reopened = await openReportExample(options);
  assert.deepEqual(reopened.host.creation(scope), creation);
  console.log('Report ownership released after the original native host close error.');
} finally {
  DatabaseSync.prototype.close = close;
  try { if (reopened) await reopened.close(); }
  finally {
    try { if (failedDatabase) close.call(failedDatabase); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
}
