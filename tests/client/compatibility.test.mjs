import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCompatibility } from '@agentui/client';
import { SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION, CLAUDE_SDK_RUNTIMES, CODEX_SDK_RUNTIME, PI_RUNTIME, SOLO_CLIENT_COMPATIBILITY } from '@agentui/contracts/compatibility';

const nativeRuntime = { engine: 'recorded', version: '1.0.0', format: 'recorded-v1' };
const client = { supportedWireVersions: [1], supportedExtensionSdkVersions: ['0.2'], supportedNativeRuntimes: [nativeRuntime], expectedArtifactId: 'artifact-a' };
const host = { wireVersion: 1, extensionSdkVersion: '0.2', nativeRuntime, desiredGitRevision: 'revision-a', appliedArtifact: { gitRevision: 'revision-a', artifactId: 'artifact-a' } };

test('compatibility uses declared support independently of application version', () => {
  assert.deepEqual(checkCompatibility(client, host), { kind: 'compatible' });
  assert.deepEqual(checkCompatibility({ ...client, expectedArtifactId: null }, { ...host, appliedArtifact: { ...host.appliedArtifact, artifactId: 'different-build' } }), { kind: 'compatible' });
});

for (const [dimension, change] of [
  ['wire', { wireVersion: 2 }],
  ['extension-sdk', { extensionSdkVersion: '0.3' }],
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
  const result = checkCompatibility(client, { ...host, wireVersion: 2, extensionSdkVersion: 'unknown', nativeRuntime: { ...nativeRuntime, version: 'unknown' }, desiredGitRevision: 'pending-revision', appliedArtifact: { artifactId: 'other-artifact', gitRevision: 'old-revision' } });
  assert.deepEqual(result.issues.map(issue => issue.dimension), ['wire', 'extension-sdk', 'native-runtime', 'deployment', 'artifact']);
});

test('solo clients accept the exact Pi SDK chat runtime and reject other versions or formats', () => {
  const piHost = { ...host, wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION,
    nativeRuntime: { engine: 'pi', version: '1.5.2', format: 'pi-sdk-chat-opencode-go-glm-5.3-v1' } };
  assert.deepEqual(PI_RUNTIME, piHost.nativeRuntime);
  assert.deepEqual(checkCompatibility(SOLO_CLIENT_COMPATIBILITY, piHost), { kind: 'compatible' });
  for (const change of [{ version: '1.5.3' }, { format: 'pi-sdk-chat-v2' }, { engine: 'other' }]) {
    const result = checkCompatibility(SOLO_CLIENT_COMPATIBILITY, { ...piHost,
      nativeRuntime: { ...piHost.nativeRuntime, ...change } });
    assert.equal(result.kind, 'incompatible');
    assert.deepEqual(result.issues.map(issue => issue.dimension), ['native-runtime']);
  }
});

test('solo clients accept the exact Codex SDK subscription runtime and reject changed native identity', () => {
  const sdkHost = { ...host, wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: {
    engine: 'codex-sdk', version: '0.169.0', format: 'codex-sdk-chat-chatgpt-gpt-6.1-sol-v1',
  } };
  assert.deepEqual(CODEX_SDK_RUNTIME, sdkHost.nativeRuntime);
  assert.deepEqual(checkCompatibility(SOLO_CLIENT_COMPATIBILITY, sdkHost), { kind: 'compatible' });
  for (const change of [{ version: '0.170.0' }, { format: 'codex-sdk-v2' }, { engine: 'other' }]) {
    assert.equal(checkCompatibility(SOLO_CLIENT_COMPATIBILITY, { ...sdkHost,
      nativeRuntime: { ...sdkHost.nativeRuntime, ...change } }).kind, 'incompatible');
  }
});

for (const model of ['opus', 'sonnet']) {
  test(`solo clients accept the exact Claude ${model} runtime and reject changed identities`, () => {
    const claudeHost = { ...host, wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: CLAUDE_SDK_RUNTIMES[model] };
    assert.deepEqual(checkCompatibility(SOLO_CLIENT_COMPATIBILITY, claudeHost), { kind: 'compatible' });
    for (const change of [{ version: '0.3.324' }, { format: 'claude-sdk-v2' }, { engine: 'other' }]) {
      const result = checkCompatibility(SOLO_CLIENT_COMPATIBILITY, { ...claudeHost,
        nativeRuntime: { ...claudeHost.nativeRuntime, ...change } });
      assert.equal(result.kind, 'incompatible');
      assert.deepEqual(result.issues.map(issue => issue.dimension), ['native-runtime']);
    }
  });
}

test('current clients refuse pre-presentation SDK artifacts without changing the wire version', () => {
  const current = { ...host, wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: CODEX_SDK_RUNTIME };
  assert.deepEqual(checkCompatibility(SOLO_CLIENT_COMPATIBILITY, current), { kind: 'compatible' });
  const old = checkCompatibility(SOLO_CLIENT_COMPATIBILITY, { ...current, extensionSdkVersion: '0.0.0' });
  assert.equal(old.kind, 'incompatible');
  assert.deepEqual(old.issues.map(issue => issue.dimension), ['extension-sdk']);
});

test('provider observation wire 5 requires matching artifacts and rejects wire 4', () => {
  const current = { ...host, wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: CODEX_SDK_RUNTIME };
  assert.deepEqual(checkCompatibility(SOLO_CLIENT_COMPATIBILITY, current), { kind: 'compatible' });
  assert.equal(checkCompatibility(SOLO_CLIENT_COMPATIBILITY, { ...current, wireVersion: 4 }).kind, 'incompatible');
  assert.equal(checkCompatibility({ ...SOLO_CLIENT_COMPATIBILITY, supportedWireVersions: [4] }, current).kind, 'incompatible');
});


test('extension operations release requires wire 15 and SDK 0.12.0', () => {
  assert.equal(SERVICE_WIRE_VERSION, 15);
  assert.equal(EXTENSION_SDK_VERSION, '0.12.0');
  const current = { ...host, wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: CODEX_SDK_RUNTIME };
  for (const [changes, dimension] of [[{ supportedWireVersions: [14] }, 'wire'], [{ supportedExtensionSdkVersions: ['0.11.0'] }, 'extension-sdk']]) {
    const result = checkCompatibility({ ...SOLO_CLIENT_COMPATIBILITY, ...changes }, current);
    assert.equal(result.kind, 'incompatible');
    assert.deepEqual(result.issues.map(issue => issue.dimension), [dimension]);
  }
});

test('retained output wire eleven explicitly rejects wire ten in both directions', () => {
  const current = { ...host, wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: CODEX_SDK_RUNTIME };
  assert.deepEqual(checkCompatibility(SOLO_CLIENT_COMPATIBILITY, { ...current, wireVersion: 10 }).issues.map(issue => issue.dimension), ['wire']);
  assert.deepEqual(checkCompatibility({ ...SOLO_CLIENT_COMPATIBILITY, supportedWireVersions: [10] }, current).issues.map(issue => issue.dimension), ['wire']);
});
