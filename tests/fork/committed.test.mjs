import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { OFFLINE_RECORD_SCOPE, consumerScripts, measureVerifierSources, verifyFork, writeConsumerScripts } from '../../scripts/lib/agui-fork.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const preMigrationLedger = 'evidence/qualification-ledger-pre-ci-migration.json.gz';
const sha256 = (body) => createHash('sha256').update(body).digest('hex');

function committedLedger() {
  const fork = verifyFork(root);
  const qualification = JSON.parse(readFileSync(join(fork.folder, 'qualification.json'), 'utf8'));
  const evidence = new Map([...fork.metadata.evidence, ...qualification.evidence].map((entry) => [entry.path, entry]));
  return { fork, qualification, evidence };
}

test('offline verification checks immutable fork inputs and reports one structured record', () => {
  const output = execFileSync(process.execPath, [join(root, 'scripts/verify-agui-fork.mjs'), '--offline'], { cwd: root, encoding: 'utf8' });
  const records = output.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 1);
  const [report] = records;
  assert.equal(report.scope, OFFLINE_RECORD_SCOPE);
  assert.equal(report.result, 'PASS');
  assert.equal(report.installed, false);
  assert.equal(report.localAguiArchives, 6);
  assert.deepEqual(report.sourceSha256, measureVerifierSources(root).sha256);
});

test('full qualification writes consumer scripts from the measured buffers', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'agentui-consumer-scripts-'));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = new Map(consumerScripts.map((file) => [file, Buffer.from(`measured ${file}\n`)]));
  await writeConsumerScripts(directory, { bytes });
  for (const file of consumerScripts) {
    assert.deepEqual(readFileSync(join(directory, file.split('/').at(-1))), bytes.get(file), file);
  }
  await assert.rejects(writeConsumerScripts(directory, { bytes: new Map() }), TypeError);
});

test('superseded nine-replay ledger retains all original logs and its earlier metadata history', () => {
  const { fork, qualification, evidence } = committedLedger();
  const historyBytes = gunzipSync(readFileSync(join(fork.folder, qualification.metadataHistory)));
  assert.equal(sha256(historyBytes), 'fd918b62044471507f13945acfd3a5f2020ef7ebd7ef16c3ada4a2c902e6fa4f');
  const history = JSON.parse(historyBytes);
  assert.equal(history.nodeReplays.length, 9);
  for (const entry of history.evidence) assert.deepEqual(evidence.get(entry.path), entry, entry.path);
  for (const replay of history.nodeReplays) assert.ok(evidence.has(replay.log), replay.log);
  assert.ok(evidence.has(history.metadataHistory), history.metadataHistory);
});

test('pre-migration ledger snapshot retains the last manual receipt and every earlier evidence entry', () => {
  const { fork, qualification, evidence } = committedLedger();
  assert.ok(evidence.has(preMigrationLedger), 'snapshot must be verified evidence');
  const snapshotBytes = gunzipSync(readFileSync(join(fork.folder, preMigrationLedger)));
  assert.equal(sha256(snapshotBytes), evidence.get(preMigrationLedger).rawSha256);
  const snapshot = JSON.parse(snapshotBytes);
  assert.equal(snapshot.currentReplay.measuredBase, '180a4091943c97724b03f0a70b69128cb4cacac4');
  assert.ok(evidence.has(snapshot.currentReplay.log), snapshot.currentReplay.log);
  assert.ok(evidence.has(snapshot.currentReplay.inputLedger), snapshot.currentReplay.inputLedger);
  assert.equal(snapshot.evidence.length, 19);
  for (const entry of snapshot.evidence) assert.deepEqual(evidence.get(entry.path), entry, entry.path);
  assert.deepEqual(qualification.evidence.slice(0, -1), snapshot.evidence);
  assert.deepEqual(Object.keys(snapshot).filter((key) => key !== 'currentReplay'), Object.keys(qualification));
  for (const key of ['sourceRevision', 'identityProvenanceSha256', 'knownLimitations', 'metadataHistory']) {
    assert.deepEqual(qualification[key], snapshot[key], key);
  }
});
