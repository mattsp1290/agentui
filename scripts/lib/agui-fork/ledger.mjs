import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { digest, forkFile, parseJson } from './bytes.mjs';

export function verifyLedger(fork, body) {
  const qualification = parseJson(body);
  assert.ok(qualification && Array.isArray(qualification.evidence) && Array.isArray(qualification.knownLimitations),
    'qualification ledger must declare evidence and knownLimitations arrays');
  assert.deepEqual(Object.keys(qualification).sort(),
    ['evidence', 'identityProvenanceSha256', 'knownLimitations', 'metadataHistory', 'sourceRevision'],
    'qualification ledger fields');
  assert.equal(qualification.sourceRevision, fork.metadata.sourceRevision, 'qualification source revision');
  assert.equal(qualification.identityProvenanceSha256, fork.provenanceSha256, 'qualification identity digest');
  verifyEvidence(fork, qualification);
  return { sha256: digest(body) };
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
