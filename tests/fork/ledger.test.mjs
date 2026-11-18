import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { verifyEvidence, verifyLedger } from '../../scripts/lib/agui-fork/ledger.mjs';

const revision = 'a'.repeat(40);
const historicalLog = Buffer.from('historical output without a scoped record');
const digest = (body) => createHash('sha256').update(body).digest('hex');

function evidenceFixture(context) {
  const folder = mkdtempSync(join(tmpdir(), 'agentui-ledger-test-'));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'evidence'));
  const files = { 'source-pnpm-lock.yaml': Buffer.from('frozen lock'), history: Buffer.from('historical metadata'), replay: historicalLog };
  const evidence = Object.entries(files).map(([name, raw]) => {
    const path = `evidence/${name}.gz`;
    const compressed = gzipSync(raw);
    writeFileSync(join(folder, path), compressed);
    return { path, rawBytes: raw.length, retainedBytes: raw.length, rawSha256: digest(raw), retainedSha256: digest(raw), compressedBytes: compressed.length, compressedSha256: digest(compressed) };
  });
  return {
    fork: { folder, provenancePath: 'provenance.json', provenanceSha256: 'f'.repeat(64), metadata: { evidence, sourceRevision: revision, sourceLockSha256: digest(files['source-pnpm-lock.yaml']) } },
    qualification: { sourceRevision: revision, identityProvenanceSha256: 'f'.repeat(64), evidence: [], metadataHistory: 'evidence/history.gz', knownLimitations: [] },
  };
}

test('verified evidence passes without parsing historical report formats', (context) => {
  const { fork, qualification } = evidenceFixture(context);
  assert.doesNotThrow(() => verifyEvidence(fork, qualification));
});

for (const [label, mutate, error] of [
  ['retired current replay index', (q) => { q.currentReplay = { log: 'evidence/replay.gz' }; }, /qualification ledger fields/u],
  ['legacy replay index', (q) => { q.nodeReplays = []; }, /qualification ledger fields/u],
  ['unverified history', (q) => { q.metadataHistory = 'unverified.gz'; }, /verified evidence/u],
  ['unverified limitation', (q) => { q.knownLimitations = [{ failureEvidence: 'unverified.gz' }]; }, /verified evidence/u],
]) test(`ledger validation rejects ${label}`, (context) => {
  const { fork, qualification } = evidenceFixture(context);
  mutate(qualification);
  assert.throws(() => verifyLedger(fork, Buffer.from(JSON.stringify(qualification))), error);
});

test('ledger validation returns the digest of its exact verified input bytes', (context) => {
  const { fork, qualification } = evidenceFixture(context);
  const body = Buffer.from(JSON.stringify(qualification, null, 2));
  assert.equal(verifyLedger(fork, body).sha256, digest(body));
});

for (const [label, value, error] of [
  ['null', () => null, /must declare/u],
  ['array', () => [], /must declare/u],
  ['non-array evidence', (q) => ({ ...q, evidence: {} }), /must declare/u],
  ['non-array limitations', (q) => ({ ...q, knownLimitations: {} }), /must declare/u],
  ['unknown top-level field', (q) => ({ ...q, command: 'obsolete command' }), /qualification ledger fields/u],
  ['wrong revision', (q) => ({ ...q, sourceRevision: 'c'.repeat(40) }), /qualification source revision/u],
  ['wrong identity digest', (q) => ({ ...q, identityProvenanceSha256: 'e'.repeat(64) }), /qualification identity digest/u],
]) test(`ledger validation rejects ${label}`, (context) => {
  const { fork, qualification } = evidenceFixture(context);
  assert.throws(() => verifyLedger(fork, Buffer.from(JSON.stringify(value(qualification)))), error);
});

for (const [label, body, error] of [
  ['malformed JSON', Buffer.from('{'), SyntaxError],
  ['invalid UTF-8', Buffer.from([0xff]), /encoded data/u],
]) test(`ledger validation rejects ${label}`, (context) => {
  const { fork } = evidenceFixture(context);
  assert.throws(() => verifyLedger(fork, body), error);
});

for (const [label, mutate, error] of [
  ['compressed hash mismatch', (f) => { f.metadata.evidence[0].compressedSha256 = '0'.repeat(64); }, /compressed hash/u],
  ['raw hash mismatch', (f) => { f.metadata.evidence[1].rawSha256 = '0'.repeat(64); }, /raw hash/u],
  ['retained hash mismatch', (f) => { f.metadata.evidence[1].retainedSha256 = '0'.repeat(64); }, /retained hash/u],
  ['source-lock digest mismatch', (f) => { f.metadata.sourceLockSha256 = '0'.repeat(64); }, /source lock digest/u],
  ['duplicate evidence path', (f, q) => { q.evidence.push(f.metadata.evidence[1]); }, /duplicate evidence path/u],
]) test(`ledger validation rejects ${label}`, (context) => {
  const { fork, qualification } = evidenceFixture(context);
  mutate(fork, qualification);
  assert.throws(() => verifyLedger(fork, Buffer.from(JSON.stringify(qualification))), error);
});
