import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  assertIosArtifactId, assertIosRuntime, canonicalJson, iosArtifactIdentityText, parseOptionalIosArtifact,
} from '@agentui/contracts';
import { EXTENSION_SDK_VERSION } from '@agentui/contracts/compatibility';

const digest = text => createHash('sha256').update(text).digest('hex');
function fixture() {
  const artifact = {
    kind: 'ios', delivery: 'embedded-full-native-build', sdkVersion: EXTENSION_SDK_VERSION,
    runtime: { engine: 'hermes', version: '250829098.0.14', format: 'hermes-bytecode',
      reactNativeVersion: '0.86.0', nativeBuildIdentity: 'c'.repeat(64) },
    assets: [{ path: 'assets/icon.png', sha256: 'a'.repeat(64) }, { path: 'main.hbc', sha256: 'b'.repeat(64) }],
  };
  return { schemaVersion: 1, kind: 'present',
    artifact: { ...artifact, artifactId: digest(canonicalJson({ schemaVersion: 1, ...artifact })) } };
}
const parse = input => parseOptionalIosArtifact(input);

test('optional iOS artifact accepts absence and a matching embedded full native build', () => {
  assert.deepEqual(parse({ schemaVersion: 1, kind: 'absent' }), { schemaVersion: 1, kind: 'absent' });
  const input = fixture(), parsed = parse(input);
  assert.deepEqual(parsed, input);
  assert.notEqual(parsed.artifact, input.artifact);
  assert.notEqual(parsed.artifact.assets, input.artifact.assets);
  assert.notEqual(parsed.artifact.runtime, input.artifact.runtime);
  assert.doesNotThrow(() => assertIosArtifactId(parsed.artifact, digest(iosArtifactIdentityText(parsed.artifact))));
  assert.doesNotThrow(() => assertIosRuntime(parsed.artifact, {
    sdkVersion: EXTENSION_SDK_VERSION, runtime: { ...parsed.artifact.runtime },
  }));
});

for (const field of ['engine', 'version', 'format', 'reactNativeVersion', 'nativeBuildIdentity']) {
  test(`iOS runtime rejects independent ${field} mismatch`, () => {
    const { artifact } = parse(fixture());
    const installed = { sdkVersion: EXTENSION_SDK_VERSION, runtime: { ...artifact.runtime, [field]: 'd'.repeat(64) } };
    assert.throws(() => assertIosRuntime(artifact, installed), new RegExp(`${field} mismatch`));
  });
}

test('iOS runtime rejects SDK mismatch independently', () => {
  const { artifact } = parse(fixture());
  assert.throws(() => assertIosRuntime(artifact, { sdkVersion: 'other-sdk', runtime: artifact.runtime }), /SDK version mismatch/);
});

test('canonical iOS identity covers version, delivery, SDK, runtime and all asset digests', () => {
  const { artifact } = parse(fixture());
  const { artifactId, ...payload } = artifact;
  assert.equal(iosArtifactIdentityText(artifact), canonicalJson({ schemaVersion: 1, ...payload }));
  assert.throws(() => assertIosArtifactId(artifact, 'd'.repeat(64)), /identity mismatch/);
  for (const field of ['engine', 'version', 'format', 'reactNativeVersion', 'nativeBuildIdentity']) {
    const changed = { ...artifact, runtime: { ...artifact.runtime, [field]: 'e'.repeat(64) } };
    assert.throws(() => assertIosArtifactId(changed, digest(iosArtifactIdentityText(changed))), /identity mismatch/);
  }
  const changed = { ...artifact, assets: [{ ...artifact.assets[0], sha256: 'f'.repeat(64) }, artifact.assets[1]] };
  assert.throws(() => assertIosArtifactId(changed, digest(iosArtifactIdentityText(changed))), /identity mismatch/);
  assert.equal(artifactId, digest(iosArtifactIdentityText(artifact)));
});

for (const [label, change] of [
  ['unknown wrapper field', input => { input.extra = true; }],
  ['unknown artifact field', input => { input.artifact.extra = true; }],
  ['unknown runtime field', input => { input.artifact.runtime.extra = true; }],
  ['unknown asset field', input => { input.artifact.assets[0].extra = true; }],
  ['unsupported schema version', input => { input.schemaVersion = 2; }],
  ['unsupported descriptor kind', input => { input.kind = 'unknown'; }],
  ['missing payload', input => { delete input.artifact; }],
  ['browser payload', input => { input.artifact.kind = 'browser'; }],
  ['live update delivery', input => { input.artifact.delivery = 'live-update'; }],
  ['wrong SDK version', input => { input.artifact.sdkVersion = 'wrong'; }],
  ['invalid artifact id', input => { input.artifact.artifactId = 'A'.repeat(64); }],
  ['empty inventory', input => { input.artifact.assets = []; }],
  ['non-array inventory', input => { input.artifact.assets = {}; }],
  ['sparse inventory', input => { input.artifact.assets = Array(1); }],
  ['duplicate paths', input => { input.artifact.assets.push({ ...input.artifact.assets[1] }); }],
  ['unsorted paths', input => { input.artifact.assets.reverse(); }],
  ['invalid asset digest', input => { input.artifact.assets[0].sha256 = 'bad'; }],
  ['invalid native build identity', input => { input.artifact.runtime.nativeBuildIdentity = 'bad'; }],
  ...['engine', 'version', 'format', 'reactNativeVersion'].map(field => [
    `empty runtime ${field}`, input => { input.artifact.runtime[field] = ''; },
  ]),
]) test(`optional iOS contract rejects ${label}`, () => {
  const input = fixture();
  change(input);
  assert.throws(() => parse(input));
});

for (const path of ['', '/', '/absolute', '../escape', './main.hbc', 'a/../main.hbc',
  'a//main.hbc', 'a/', 'a\\main.hbc', 'C:/main.hbc', 'C:main.hbc', 'main\0.hbc']) {
  test(`optional iOS contract rejects invalid path ${JSON.stringify(path)}`, () => {
    const input = fixture();
    input.artifact.assets[0].path = path;
    assert.throws(() => parse(input));
  });
}

test('optional iOS boundary rejects malformed objects and payloads attached to absence', () => {
  for (const value of [undefined, null, [], 'absent', {}, new Date(),
    { schemaVersion: 1, kind: 'absent', artifact: fixture().artifact },
    { schemaVersion: 1, get kind() { throw new Error('getter must not run'); } }]) {
    assert.throws(() => parse(value), error => error.message !== 'getter must not run');
  }
});
