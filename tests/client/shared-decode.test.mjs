import { EXTENSION_SDK_VERSION } from '@agentui/contracts/compatibility';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, webcrypto } from 'node:crypto';
import { canonicalJson, parseReceipt, parseDecision } from '@agentui/contracts';
import { record, identifier, count, hex, utf8Bytes } from '@agentui/contracts/decode';
import { BROWSER_RUNTIME, manifestPayload, parseArtifactManifest, artifactIdentityText, assertArtifactId } from '@agentui/contracts/artifact';

const digest = text => createHash('sha256').update(text).digest('hex');
const payload = () => manifestPayload({ schemaVersion: 1, platform: 'browser-development', sourceRevision: 'a'.repeat(64),
  sourceDirty: { kind: 'dirty', fingerprint: 'b'.repeat(64) }, wireVersion: 3, extensionSdkVersion: EXTENSION_SDK_VERSION,
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

test('manifest parsing and real Node/WebCrypto identity verification share canonical bytes', async () => {
  const body = payload(), input = { ...body, artifactId: digest(canonicalJson(body)) };
  const manifest = parseArtifactManifest(input);
  assert.deepEqual(manifest, input);
  assert.equal(artifactIdentityText(manifest), canonicalJson(body));
  assertArtifactId(manifest, digest(artifactIdentityText(manifest)));
  const browserDigest = Buffer.from(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(artifactIdentityText(manifest)))).toString('hex');
  assertArtifactId(manifest, browserDigest);
  const tampered = parseArtifactManifest({ ...manifest, artifactId: '0'.repeat(64) });
  assert.throws(() => assertArtifactId(tampered, digest(artifactIdentityText(tampered))), /identity mismatch/);
  assert.throws(() => assertArtifactId(tampered, browserDigest), /identity mismatch/);
  for (const changed of [ { ...manifest, extra: true }, { ...manifest, assets: [{ path: 'artifact.json', sha256: 'd'.repeat(64) }] },
    { ...manifest, assets: [{ path: '../outside', sha256: 'd'.repeat(64) }] }, { ...manifest, sourceDirty: { ...manifest.sourceDirty, extra: true } },
    { ...manifest, assets: [{ path: 'z.js', sha256: 'd'.repeat(64) }, { path: 'a.js', sha256: 'd'.repeat(64) }] } ]) {
    assert.throws(() => parseArtifactManifest(changed));
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
