import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { digest, forkFile, parseJson } from './bytes.mjs';

export const RETAINED_CONSUMER_RECORD_SCOPE = 'controlled package consumer; no native provider or Apple qualification';

export function readConsumerPassRecord(raw, label, sourceRevision) {
  const reports = [];
  for (const line of new TextDecoder('utf-8', { fatal: true }).decode(raw).split(/\r?\n/u)) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.scope === RETAINED_CONSUMER_RECORD_SCOPE) reports.push(entry);
  }
  assert.equal(reports.length, 1, `${label}: exactly one full consumer record is required`);
  const [report] = reports;
  assert.equal(report.result, 'PASS', `${label}: full consumer result`);
  assert.equal(report.sourceRevision, sourceRevision, `${label}: full consumer source revision`);
  const hashes = report.sourceSha256;
  assert.ok(hashes && typeof hashes === 'object' && !Array.isArray(hashes)
    && Object.keys(hashes).length > 0, `${label}: replay source hashes must be a nonempty map`);
  for (const [file, hash] of Object.entries(hashes)) {
    assert.ok(typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash), `${label}: ${file}: replay source digest`);
  }
  return report;
}

function assertClosedKeys(value, allowed, label) {
  assert.deepEqual(Object.keys(value).filter((key) => !allowed.includes(key)), [], label);
}

export function verifyLedger(fork, body) {
  const qualification = parseJson(body);
  assert.ok(qualification && Array.isArray(qualification.evidence) && Array.isArray(qualification.nodeReplays)
    && Array.isArray(qualification.knownLimitations), 'qualification ledger must declare evidence, nodeReplays and knownLimitations arrays');
  const ledgerKeys = ['sourceRevision', 'identityProvenanceSha256', 'knownLimitations', 'nodeReplays', 'evidence', 'metadataHistory'];
  assertClosedKeys(qualification, ledgerKeys, 'unexpected qualification ledger fields');
  assert.equal(qualification.sourceRevision, fork.metadata.sourceRevision, 'qualification source revision');
  assert.equal(qualification.identityProvenanceSha256, fork.provenanceSha256, 'qualification identity digest');
  verifyEvidence(fork, qualification);
  return digest(body);
}

const replayKeys = ['log', 'measuredBase', 'note'];
function verifyReplay(replay, raws, sourceRevision) {
  assert.ok(replay && typeof replay === 'object' && !Array.isArray(replay), 'replay must be an index record');
  assertClosedKeys(replay, replayKeys, `${replay.log}: unexpected replay fields`);
  assert.ok(typeof replay.log === 'string' && raws.has(replay.log), `${replay.log}: replay log must be verified evidence`);
  assert.ok(typeof replay.measuredBase === 'string' && /^[a-f0-9]{40}$/u.test(replay.measuredBase), `${replay.log}: replay base must be a full commit SHA`);
  assert.ok(replay.note === undefined || typeof replay.note === 'string', `${replay.log}: replay note must be a string`);
  return { ...replay, report: readConsumerPassRecord(raws.get(replay.log), replay.log, sourceRevision) };
}

export function verifyEvidence({ folder, metadata }, qualification) {
  const raws = new Map();
  for (const entry of [...metadata.evidence, ...qualification.evidence]) {
    assert.ok(!raws.has(entry.path), `${entry.path}: duplicate evidence path`);
    const packed = readFileSync(forkFile(folder, entry.path));
    assert.equal(packed.length, entry.compressedBytes, `${entry.path}: compressed bytes`);
    assert.equal(digest(packed), entry.compressedSha256, `${entry.path}: compressed hash`);
    const raw = gunzipSync(packed);
    assert.equal(raw.length, entry.rawBytes, `${entry.path}: raw bytes`);
    assert.equal(raw.length, entry.retainedBytes, `${entry.path}: retained bytes`);
    assert.equal(digest(raw), entry.rawSha256, `${entry.path}: raw hash`);
    assert.equal(digest(raw), entry.retainedSha256, `${entry.path}: retained hash`);
    raws.set(entry.path, raw);
  }
  const sourceLock = 'evidence/source-pnpm-lock.yaml.gz';
  assert.ok(raws.has(sourceLock), 'source lock must be verified evidence');
  assert.equal(digest(raws.get(sourceLock)), metadata.sourceLockSha256, 'source lock digest');
  assert.ok(raws.has(qualification.metadataHistory), `${qualification.metadataHistory}: metadata history must be verified evidence`);
  for (const limitation of qualification.knownLimitations) {
    for (const field of ['failureEvidence', 'reproductionEvidence']) {
      assert.ok(raws.has(limitation[field]), `${limitation[field]}: limitation ${field} must be verified evidence`);
    }
  }
  return qualification.nodeReplays.map((replay) => verifyReplay(replay, raws, metadata.sourceRevision));
}
