import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { canonicalJson, parseReceipt, parseDecision } from '@agentui/contracts';
import { record, identifier, count, hex, utf8Bytes } from '@agentui/contracts/decode';
import { BROWSER_RUNTIME, manifestPayload, parseArtifactManifest } from '@agentui/contracts/artifact';

const digest = text => createHash('sha256').update(text).digest('hex');
const payload = () => manifestPayload({ schemaVersion: 1, platform: 'browser-development', sourceRevision: 'a'.repeat(64),
  sourceDirty: { kind: 'dirty', fingerprint: 'b'.repeat(64) }, wireVersion: 1, extensionSdkVersion: '0.0.0',
  nativeRuntime: BROWSER_RUNTIME, artifactRuntime: BROWSER_RUNTIME, lockSha256: 'c'.repeat(64),
  assets: [{ path: 'browser.html', sha256: 'd'.repeat(64) }],
});

test('shared decoding requires plain data and exact fields', () => {
  assert.deepEqual(record({ x: 1 }, ['x']), { x: 1 });
  for (const value of [new Date(), [], { x: 1, y: 2 }, {}, { get x() { throw new Error('Getter was evaluated'); } }]) {
    assert.throws(() => record(value, ['x']));
  }
  assert.equal(identifier('opaque/id'), 'opaque/id');
  assert.throws(() => identifier('x'.repeat(1025)));
  assert.equal(count(0), 0);
  assert.throws(() => count(1.5));
  assert.equal(hex('a'.repeat(40), 40, 64), 'a'.repeat(40));
  assert.throws(() => hex('a'.repeat(41), 40, 64));
});

test('pure UTF-8 sizing agrees with encoded bytes including replacement of lone surrogates', () => {
  for (const text of ['', 'ascii\n', 'é中😀', '\ud800', '\udc00', '\ud800x\udc00', '\ud800\udc00', JSON.stringify('\ud800')]) {
    assert.equal(utf8Bytes(text), Buffer.byteLength(text));
  }
});

test('manifest schema verifies the same canonical identity with synchronous and asynchronous digests', async () => {
  const body = payload(), manifest = { ...body, artifactId: digest(canonicalJson(body)) };
  assert.deepEqual(parseArtifactManifest(manifest, digest), manifest);
  const actualBrowserDigest = async text => Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
  assert.deepEqual(await parseArtifactManifest(manifest, actualBrowserDigest), manifest);
  assert.throws(() => parseArtifactManifest({ ...manifest, artifactId: '0'.repeat(64) }, digest), /identity mismatch/);
  await assert.rejects(parseArtifactManifest({ ...manifest, artifactId: '0'.repeat(64) }, actualBrowserDigest), /identity mismatch/);
  for (const changed of [ { ...manifest, extra: true }, { ...manifest, assets: [{ path: 'artifact.json', sha256: 'd'.repeat(64) }] },
    { ...manifest, assets: [{ path: '../outside', sha256: 'd'.repeat(64) }] }, { ...manifest, sourceDirty: { ...manifest.sourceDirty, extra: true } },
    { ...manifest, assets: [{ path: 'z.js', sha256: 'd'.repeat(64) }, { path: 'a.js', sha256: 'd'.repeat(64) }] } ]) {
    assert.throws(() => parseArtifactManifest(changed, digest));
  }
});

test('durable receipt and decision boundaries reject unexpected fields before service wrapping', () => {
  const receipt = { scope: { hostId: 'host', conversationId: 'conversation' }, clientCommandId: 'command', hostOperationId: 'operation', sequence: 1, state: { kind: 'pending' } };
  assert.deepEqual(parseReceipt(receipt), receipt);
  assert.throws(() => parseReceipt({ ...receipt, extra: true }));
  assert.throws(() => parseReceipt({ ...receipt, state: { kind: 'pending', reason: 'unexpected' } }));
  assert.throws(() => parseReceipt({ ...receipt, state: { kind: 'uncertain' } }));
  const decision = { pendingId: 'decision', runId: 'run', choices: ['yes'], prompt: 'Continue?' };
  assert.deepEqual(parseDecision(decision), decision);
  assert.throws(() => parseDecision({ ...decision, extra: true }));
});
