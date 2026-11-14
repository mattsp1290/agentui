import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { RETAINED_CONSUMER_RECORD_SCOPE, readConsumerPassRecord, verifyEvidence, verifyLedger } from '../../scripts/lib/agui-fork/ledger.mjs';

const revision = 'a'.repeat(40);
const pass = { result: 'PASS', scope: 'controlled package consumer; no native provider or Apple qualification', sourceRevision: revision, sourceSha256: { 'checker.mjs': 'b'.repeat(64) } };
const log = (...records) => Buffer.from(records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n'));
const provenance = { path: 'provenance.json', sha256: 'f'.repeat(64) };
const read = (body) => readConsumerPassRecord(body, 'test.log', revision, provenance);
const digest = (body) => createHash('sha256').update(body).digest('hex');

test('retained full-consumer record discriminator stays compatible with historical logs', () => {
  assert.equal(RETAINED_CONSUMER_RECORD_SCOPE, pass.scope);
});

test('full consumer records accept field order, whitespace and unrelated process output', () => {
  const reordered = Object.fromEntries(Object.entries(pass).reverse());
  assert.deepEqual(read(log('npm progress', null, [], 42, { scope: 'npm', result: 'PASS' }, `  ${JSON.stringify(reordered)}  `)), pass);
});

for (const [label, body, error] of [
  ['missing record', log('progress'), /exactly one/u],
  ['wrong scope', log({ ...pass, scope: 'different' }), /exactly one/u],
  ['duplicate record', log(pass, pass), /exactly one/u],
  ['FAIL plus PASS', log({ ...pass, result: 'FAIL' }, pass), /exactly one/u],
  ['only FAIL', log({ ...pass, result: 'FAIL' }), /result/u],
  ['wrong source', log({ ...pass, sourceRevision: 'c'.repeat(40) }), /source revision/u],
  ['missing hashes', log({ ...pass, sourceSha256: undefined }), /nonempty map/u],
  ['empty hashes', log({ ...pass, sourceSha256: {} }), /nonempty map/u],
  ['array hashes', log({ ...pass, sourceSha256: [] }), /nonempty map/u],
  ['uppercase digest', log({ ...pass, sourceSha256: { file: 'B'.repeat(64) } }), /source digest/u],
  ['short digest', log({ ...pass, sourceSha256: { file: 'b'.repeat(63) } }), /source digest/u],
  ['non-string digest', log({ ...pass, sourceSha256: { file: 123 } }), /source digest/u],
  ['invalid UTF-8', Buffer.from([0xff]), /encoded data/u],
]) test(`full consumer records reject ${label}`, () => assert.throws(() => read(body), error));

function evidenceFixture(context, report = pass) {
  const folder = mkdtempSync(join(tmpdir(), 'agentui-ledger-test-'));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, 'evidence'));
  const files = { 'source-pnpm-lock.yaml': Buffer.from('frozen lock'), history: Buffer.from('historical metadata'), replay: log(report) };
  const evidence = Object.entries(files).map(([name, raw]) => {
    const path = `evidence/${name}.gz`;
    const compressed = gzipSync(raw);
    writeFileSync(join(folder, path), compressed);
    return { path, rawBytes: raw.length, retainedBytes: raw.length, rawSha256: digest(raw), retainedSha256: digest(raw), compressedBytes: compressed.length, compressedSha256: digest(compressed) };
  });
  return {
    fork: { folder, provenancePath: provenance.path, provenanceSha256: provenance.sha256, metadata: { evidence, sourceRevision: revision, sourceLockSha256: digest(files['source-pnpm-lock.yaml']) } },
    qualification: { sourceRevision: revision, identityProvenanceSha256: 'f'.repeat(64), evidence: [], metadataHistory: 'evidence/history.gz', knownLimitations: [], nodeReplays: [{ log: 'evidence/replay.gz', measuredBase: 'd'.repeat(40) }] },
  };
}

test('verified evidence supplies the uniformly shaped replay report', (context) => {
  const { fork, qualification } = evidenceFixture(context);
  assert.deepEqual(verifyEvidence(fork, qualification), [{ ...qualification.nodeReplays[0], report: pass }]);
});

for (const [label, mutate, error] of [
  ['extra replay fields', (q) => { q.nodeReplays[0].kind = 'self-reported'; }, /unexpected replay fields/u],
  ['duplicate replay log', (q) => { q.nodeReplays.push({ ...q.nodeReplays[0], measuredBase: 'e'.repeat(40) }); }, /replay logs must be indexed once/u],
  ['unverified replay log', (q) => { q.nodeReplays[0].log = 'unverified.gz'; }, /verified evidence/u],
  ['abbreviated base', (q) => { q.nodeReplays[0].measuredBase = 'ddddddd'; }, /full commit SHA/u],
  ['non-string note', (q) => { q.nodeReplays[0].note = {}; }, /note must be a string/u],
  ['unverified history', (q) => { q.metadataHistory = 'unverified.gz'; }, /verified evidence/u],
  ['unverified limitation', (q) => { q.knownLimitations = [{ failureEvidence: 'unverified.gz' }]; }, /verified evidence/u],
]) test(`verified evidence rejects ${label}`, (context) => {
  const { fork, qualification } = evidenceFixture(context);
  mutate(qualification);
  assert.throws(() => verifyEvidence(fork, qualification), error);
});


test('ledger validation returns the digest of its exact verified input bytes', (context) => {
  const { fork, qualification } = evidenceFixture(context);
  const body = Buffer.from(JSON.stringify(qualification, null, 2));
  assert.equal(verifyLedger(fork, body), digest(body));
});

for (const [label, value, error] of [
  ['null', () => null, /must declare/u],
  ['array', () => [], /must declare/u],
  ['non-array evidence', (q) => ({ ...q, evidence: {} }), /must declare/u],
  ['non-array replays', (q) => ({ ...q, nodeReplays: {} }), /must declare/u],
  ['non-array limitations', (q) => ({ ...q, knownLimitations: {} }), /must declare/u],
  ['unknown top-level field', (q) => ({ ...q, command: 'obsolete command' }), /unexpected qualification ledger fields/u],
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

const successfulSteps = [{ command: ['controlled-child'], exitCode: 0, signal: null }];
test('full consumer records accept the exact measured identity and successful child results', () => {
  const bound = { ...pass, provenance, results: successfulSteps };
  assert.deepEqual(read(log(bound)), bound);
});

for (const [label, fields, error] of [
  ['foreign identity digest', { provenance: { ...provenance, sha256: 'e'.repeat(64) } }, /replay frozen identity/u],
  ['foreign identity path', { provenance: { ...provenance, path: 'other.json' } }, /replay frozen identity/u],
  ['null identity', { provenance: null }, /replay frozen identity/u],
  ['array identity', { provenance: [] }, /replay frozen identity/u],
  ['missing identity digest', { provenance: { path: provenance.path } }, /replay frozen identity/u],
  ['extra identity field', { provenance: { ...provenance, extra: true } }, /replay frozen identity/u],
  ['non-array child results', { results: {} }, /replay child results/u],
  ['empty child results', { results: [] }, /replay child results/u],
  ['null child step', { results: [null] }, /replay child results/u],
  ['failed child step', { results: [{ exitCode: 1, signal: null }] }, /replay child results/u],
  ['signalled child step', { results: [{ exitCode: 0, signal: 'SIGTERM' }] }, /replay child results/u],
  ['missing child exit', { results: [{ signal: null }] }, /replay child results/u],
  ['missing child signal', { results: [{ exitCode: 0 }] }, /replay child results/u],
]) test(`full consumer records reject ${label}`, () => {
  assert.throws(() => read(log({ ...pass, ...fields })), error);
});

test('verified ledger admits a replay bound to its resolved identity', (context) => {
  const bound = { ...pass, provenance, results: successfulSteps };
  const { fork, qualification } = evidenceFixture(context, bound);
  assert.deepEqual(verifyEvidence(fork, qualification)[0].report, bound);
  assert.equal(verifyLedger(fork, Buffer.from(JSON.stringify(qualification))), digest(Buffer.from(JSON.stringify(qualification))));
});

test('verified ledger rejects a replay bound to another resolved identity', (context) => {
  const { fork, qualification } = evidenceFixture(context, { ...pass, provenance: { ...provenance, sha256: 'e'.repeat(64) } });
  assert.throws(() => verifyLedger(fork, Buffer.from(JSON.stringify(qualification))), /replay frozen identity/u);
});
