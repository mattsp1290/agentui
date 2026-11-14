import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { RETAINED_CONSUMER_RECORD_SCOPE, readConsumerPassRecord, verifyCurrentReceipt, verifyEvidence, verifyLedger } from '../../scripts/lib/agui-fork/ledger.mjs';

const revision = 'a'.repeat(40);
const provenance = { path: 'provenance.json', sha256: 'f'.repeat(64) };
const successfulSteps = [{ command: ['controlled-child'], exitCode: 0, signal: null }];
const inputLedger = Buffer.from('exact input ledger bytes');
const pass = { provenance, results: successfulSteps, qualificationSha256: createHash('sha256').update(inputLedger).digest('hex'), result: 'PASS', scope: 'controlled package consumer; no native provider or Apple qualification', sourceRevision: revision, sourceSha256: { 'checker.mjs': 'b'.repeat(64) } };
const log = (...records) => Buffer.from(records.map((record) => typeof record === 'string' ? record : JSON.stringify(record)).join('\n'));
const read = (body) => readConsumerPassRecord(body, 'test.log', revision, provenance);
const digest = (body) => createHash('sha256').update(body).digest('hex');

test('driver and current receipt reader share the full-consumer discriminator', () => {
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
  const files = { 'source-pnpm-lock.yaml': Buffer.from('frozen lock'), history: Buffer.from('historical metadata'), input: inputLedger, replay: log(report) };
  const evidence = Object.entries(files).map(([name, raw]) => {
    const path = `evidence/${name}.gz`;
    const compressed = gzipSync(raw);
    writeFileSync(join(folder, path), compressed);
    return { path, rawBytes: raw.length, retainedBytes: raw.length, rawSha256: digest(raw), retainedSha256: digest(raw), compressedBytes: compressed.length, compressedSha256: digest(compressed) };
  });
  return {
    fork: { folder, provenancePath: provenance.path, provenanceSha256: provenance.sha256, metadata: { evidence, sourceRevision: revision, sourceLockSha256: digest(files['source-pnpm-lock.yaml']) } },
    qualification: { sourceRevision: revision, identityProvenanceSha256: 'f'.repeat(64), evidence: [], metadataHistory: 'evidence/history.gz', knownLimitations: [], currentReplay: { log: 'evidence/replay.gz', inputLedger: 'evidence/input.gz', measuredBase: 'd'.repeat(40) } },
  };
}

test('verified evidence returns raw bytes without parsing historical report formats', (context) => {
  const { fork, qualification } = evidenceFixture(context, 'historical output without a scoped record');
  const raws = verifyEvidence(fork, qualification);
  assert.ok(raws instanceof Map);
  assert.deepEqual(raws.get('evidence/input.gz'), inputLedger);
});

for (const [label, mutate, error] of [
  ['missing current replay', (q) => { delete q.currentReplay; }, /currentReplay/u],
  ['null current replay', (q) => { q.currentReplay = null; }, /currentReplay/u],
  ['array current replay', (q) => { q.currentReplay = []; }, /currentReplay/u],
  ['extra current replay field', (q) => { q.currentReplay.note = 'obsolete'; }, /currentReplay fields/u],
  ['missing input ledger', (q) => { delete q.currentReplay.inputLedger; }, /currentReplay fields/u],
  ['unverified replay log', (q) => { q.currentReplay.log = 'unverified.gz'; }, /verified evidence/u],
  ['unverified input ledger', (q) => { q.currentReplay.inputLedger = 'unverified.gz'; }, /verified evidence/u],
  ['same log and input ledger', (q) => { q.currentReplay.inputLedger = q.currentReplay.log; }, /must differ/u],
  ['abbreviated base', (q) => { q.currentReplay.measuredBase = 'ddddddd'; }, /full commit SHA/u],
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

for (const [label, fields, error] of [
  ['missing identity', { provenance: undefined }, /replay frozen identity/u],
  ['missing child results', { results: undefined }, /replay child results/u],
  ['missing input digest', { qualificationSha256: undefined }, /input-ledger digest/u],
  ['uppercase input digest', { qualificationSha256: 'A'.repeat(64) }, /input-ledger digest/u],
  ['short input digest', { qualificationSha256: 'a'.repeat(63) }, /input-ledger digest/u],
  ['non-string input digest', { qualificationSha256: 123 }, /input-ledger digest/u],
]) test(`current receipts reject ${label}`, () => {
  assert.throws(() => read(log({ ...pass, ...fields })), error);
});

for (const report of ['unscoped historical output', { ...pass, provenance: undefined }, { ...pass, results: undefined }]) {
  test('static ledger verification permits replacing an obsolete receipt contract', (context) => {
    const { fork, qualification } = evidenceFixture(context, report);
    const ledger = verifyLedger(fork, Buffer.from(JSON.stringify(qualification)));
    assert.deepEqual(ledger.logRaw, log(report));
    assert.throws(() => verifyCurrentReceipt({ ...fork, ledger }, pass.sourceSha256));
  });
}

test('current receipt binds exact input ledger bytes and current source hashes', (context) => {
  const { fork, qualification } = evidenceFixture(context);
  const ledger = verifyLedger(fork, Buffer.from(JSON.stringify(qualification)));
  assert.deepEqual(verifyCurrentReceipt({ ...fork, ledger }, pass.sourceSha256), pass);
  assert.notEqual(pass.qualificationSha256, ledger.sha256);
});

for (const [label, hashes] of [
  ['stale source bytes', { 'checker.mjs': 'c'.repeat(64) }],
  ['missing measured source', {}],
  ['extra measured source', { ...pass.sourceSha256, 'extra.mjs': 'c'.repeat(64) }],
]) test(`current receipts reject ${label}`, (context) => {
  const { fork, qualification } = evidenceFixture(context);
  const ledger = verifyLedger(fork, Buffer.from(JSON.stringify(qualification)));
  assert.throws(() => verifyCurrentReceipt({ ...fork, ledger }, hashes), /current verifier sources/u);
});

test('current receipt rejects a valid-shaped digest naming different retained bytes', (context) => {
  const { fork, qualification } = evidenceFixture(context);
  qualification.currentReplay.inputLedger = qualification.metadataHistory;
  const ledger = verifyLedger(fork, Buffer.from(JSON.stringify(qualification)));
  assert.throws(() => verifyCurrentReceipt({ ...fork, ledger }, pass.sourceSha256), /input.ledger/u);
});

for (const [label, fields, error] of [
  ['foreign identity', { provenance: { ...provenance, sha256: 'e'.repeat(64) } }, /replay frozen identity/u],
  ['failed child', { results: [{ exitCode: 1, signal: null }] }, /replay child results/u],
]) test(`current receipt validation rejects ${label}`, (context) => {
  const { fork, qualification } = evidenceFixture(context, { ...pass, ...fields });
  const ledger = verifyLedger(fork, Buffer.from(JSON.stringify(qualification)));
  assert.throws(() => verifyCurrentReceipt({ ...fork, ledger }, pass.sourceSha256), error);
});
