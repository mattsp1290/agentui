import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { digest, forkFile, parseJson } from './bytes.mjs';

export const RETAINED_CONSUMER_RECORD_SCOPE = 'controlled package consumer; no native provider or Apple qualification';

export function readConsumerPassRecord(raw, label, sourceRevision, expectedProvenance) {
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
  assert.deepEqual(report.provenance, expectedProvenance, `${label}: replay frozen identity`);
  assert.ok(typeof report.qualificationSha256 === 'string' && /^[a-f0-9]{64}$/u.test(report.qualificationSha256),
    `${label}: replay input-ledger digest`);
  assert.ok(Array.isArray(report.results) && report.results.length > 0
    && report.results.every((step) => step?.exitCode === 0 && step.signal === null), `${label}: replay child results`);
  const hashes = report.sourceSha256;
  assert.ok(hashes && typeof hashes === 'object' && !Array.isArray(hashes)
    && Object.keys(hashes).length > 0, `${label}: replay source hashes must be a nonempty map`);
  for (const [file, hash] of Object.entries(hashes)) {
    assert.ok(typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash), `${label}: ${file}: replay source digest`);
  }
  return report;
}

export function verifyLedger(fork, body) {
  const qualification = parseJson(body);
  assert.ok(qualification && Array.isArray(qualification.evidence) && Array.isArray(qualification.knownLimitations),
    'qualification ledger must declare evidence and knownLimitations arrays');
  assert.deepEqual(Object.keys(qualification).sort(),
    ['currentReplay', 'evidence', 'identityProvenanceSha256', 'knownLimitations', 'metadataHistory', 'sourceRevision'],
    'qualification ledger fields');
  assert.equal(qualification.sourceRevision, fork.metadata.sourceRevision, 'qualification source revision');
  assert.equal(qualification.identityProvenanceSha256, fork.provenanceSha256, 'qualification identity digest');
  const raws = verifyEvidence(fork, qualification);
  const replay = qualification.currentReplay;
  assert.ok(replay && typeof replay === 'object' && !Array.isArray(replay), 'currentReplay must be an index record');
  assert.deepEqual(Object.keys(replay).sort(), ['inputLedger', 'log', 'measuredBase'], 'currentReplay fields');
  for (const field of ['log', 'inputLedger']) {
    assert.ok(typeof replay[field] === 'string' && raws.has(replay[field]), `${replay[field]}: currentReplay ${field} must be verified evidence`);
  }
  assert.notEqual(replay.log, replay.inputLedger, 'currentReplay log and input ledger must differ');
  assert.ok(typeof replay.measuredBase === 'string' && /^[a-f0-9]{40}$/u.test(replay.measuredBase), 'currentReplay base must be a full commit SHA');
  return { sha256: digest(body), currentReplay: replay, logRaw: raws.get(replay.log), inputLedgerRaw: raws.get(replay.inputLedger) };
}

export function verifyCurrentReceipt(fork, sourceSha256) {
  const { currentReplay, logRaw, inputLedgerRaw } = fork.ledger;
  const report = readConsumerPassRecord(logRaw, currentReplay.log, fork.metadata.sourceRevision,
    { path: fork.provenancePath, sha256: fork.provenanceSha256 });
  assert.equal(report.qualificationSha256, digest(inputLedgerRaw), `${currentReplay.log}: input-ledger digest must name the retained pre-append ledger`);
  assert.deepEqual(report.sourceSha256, sourceSha256,
    `${currentReplay.log}: receipt does not measure the current verifier sources; run the full qualification and record a new receipt`);
  return report;
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
  return raws;
}
