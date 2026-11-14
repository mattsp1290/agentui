import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCompatibility } from '@agentui/client';

const nativeRuntime = { engine: 'recorded', version: '1.0.0', format: 'recorded-v1' };
const client = { supportedWireVersions: [1], supportedClientSdkVersions: ['0.2'], supportedNativeRuntimes: [nativeRuntime], expectedArtifactId: 'artifact-a' };
const host = { wireVersion: 1, clientSdkVersion: '0.2', nativeRuntime, desiredGitRevision: 'revision-a', appliedArtifact: { gitRevision: 'revision-a', artifactId: 'artifact-a' } };

test('compatibility uses declared support independently of application version', () => {
  assert.deepEqual(checkCompatibility(client, host), { kind: 'compatible' });
  assert.deepEqual(checkCompatibility({ ...client, expectedArtifactId: null }, { ...host, appliedArtifact: { ...host.appliedArtifact, artifactId: 'different-build' } }), { kind: 'compatible' });
});

for (const [dimension, change] of [
  ['wire', { wireVersion: 2 }],
  ['client-sdk', { clientSdkVersion: '0.3' }],
  ['native-runtime', { nativeRuntime: { ...nativeRuntime, engine: 'other' } }],
  ['native-runtime', { nativeRuntime: { ...nativeRuntime, version: '2.0' } }],
  ['native-runtime', { nativeRuntime: { ...nativeRuntime, format: 'recorded-v2' } }],
  ['deployment', { desiredGitRevision: 'revision-b' }],
  ['artifact', { appliedArtifact: { ...host.appliedArtifact, artifactId: 'artifact-b' } }],
]) {
  test(`${dimension} mismatch is explicit and actionable ${JSON.stringify(change)}`, () => {
    const result = checkCompatibility(client, { ...host, ...change });
    assert.equal(result.kind, 'incompatible');
    assert.deepEqual(result.issues.map(issue => issue.dimension), [dimension]);
    assert.ok(result.issues[0].reason.length > 10);
    assert.ok(result.issues[0].action.length > 10);
  });
}

test('deployment and applied artifact mismatches remain distinct findings', () => {
  const result = checkCompatibility(client, { ...host, wireVersion: 2, clientSdkVersion: 'unknown', nativeRuntime: { ...nativeRuntime, version: 'unknown' }, desiredGitRevision: 'pending-revision', appliedArtifact: { artifactId: 'other-artifact', gitRevision: 'old-revision' } });
  assert.deepEqual(result.issues.map(issue => issue.dimension), ['wire', 'client-sdk', 'native-runtime', 'deployment', 'artifact']);
});
