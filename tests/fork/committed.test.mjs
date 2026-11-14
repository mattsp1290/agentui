import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { consumerScripts, measureVerifierSources, verifyFork } from '../../scripts/lib/agui-fork.mjs';
import { verifyCurrentReceipt } from '../../scripts/lib/agui-fork/ledger.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('committed fork receipt binds the current verifier and exact retained input ledger', () => {
  const fork = verifyFork(root);
  assert.equal(fork.packages.size, 6);
  const report = verifyCurrentReceipt(fork, measureVerifierSources(root).sha256);
  assert.notEqual(report.qualificationSha256, fork.ledger.sha256);
});

test('offline reports measure every imported checker and executed consumer script', () => {
  const output = execFileSync(process.execPath, ['--import', join(root, 'tests/fork/support/import-graph.mjs'),
    join(root, 'scripts/verify-agui-fork.mjs'), '--offline'], { cwd: root, encoding: 'utf8' });
  const records = output.trim().split('\n').flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  const reports = records.filter((record) => record?.scope === 'retained archives, evidence, source lock, fixtures, frozen consumer lock and current full-consumer receipt');
  const graphs = records.filter((record) => record?.type === 'fork-import-graph');
  assert.equal(reports.length, 1);
  assert.equal(graphs.length, 1);
  const [report] = reports;
  const [graph] = graphs;
  assert.equal(report.result, 'PASS');
  assert.equal(report.installed, false);
  assert.equal(report.currentReplay.log, verifyFork(root).ledger.currentReplay.log);
  assert.ok(graph.sourceFiles.includes('scripts/verify-agui-fork.mjs'), 'observer must see the driver');
  for (const file of graph.sourceFiles) assert.ok(Object.hasOwn(report.sourceSha256, file), `${file}: imported source must be measured`);
  const sources = measureVerifierSources(root);
  assert.deepEqual(report.sourceSha256, sources.sha256);
  for (const file of consumerScripts) assert.ok(Object.hasOwn(report.sourceSha256, file), `${file}: executed script must be measured`);
  for (const file of Object.keys(report.sourceSha256)) {
    assert.equal(report.sourceSha256[file], createHash('sha256').update(readFileSync(join(root, file))).digest('hex'), file);
  }
});

test('superseded nine-replay ledger retains all original logs and its earlier metadata history', () => {
  const fork = verifyFork(root);
  const qualification = JSON.parse(readFileSync(join(fork.folder, 'qualification.json'), 'utf8'));
  const historyBytes = gunzipSync(readFileSync(join(fork.folder, qualification.metadataHistory)));
  assert.equal(createHash('sha256').update(historyBytes).digest('hex'), 'fd918b62044471507f13945acfd3a5f2020ef7ebd7ef16c3ada4a2c902e6fa4f');
  const history = JSON.parse(historyBytes);
  assert.equal(history.nodeReplays.length, 9);
  const evidence = new Map([...fork.metadata.evidence, ...qualification.evidence].map((entry) => [entry.path, entry]));
  for (const entry of history.evidence) assert.deepEqual(evidence.get(entry.path), entry, entry.path);
  for (const replay of history.nodeReplays) assert.ok(evidence.has(replay.log), replay.log);
  assert.ok(evidence.has(history.metadataHistory), history.metadataHistory);
});
