import assert from 'node:assert/strict';
import test from 'node:test';
import { parseServiceResponse } from '@agentui/contracts/service';
import { checkCompatibility } from '@agentui/client';
import { SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION, SOLO_CLIENT_COMPATIBILITY, RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import { manifestPayload, BROWSER_RUNTIME } from '@agentui/contracts/artifact';

const compatibility = { wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION, nativeRuntime: null,
  desiredGitRevision: 'revision', appliedArtifact: { artifactId: 'artifact', gitRevision: 'revision' } };
const metadata = { hostId: 'host', principalId: 'principal', compatibility, agents: [], defaultAgentId: null };
const agent = { kind: 'provider', id: 'provider', label: 'Provider', namespace: 'example', protocolVersion: '1',
  commands: [], availability: { kind: 'unavailable', reason: 'Creation unsupported' } };
const parse = value => parseServiceResponse({ op: 'metadata' }, { ok: true, value });

test('metadata represents empty and unavailable provider catalogs without synthetic native identity', () => {
  for (const value of [metadata, { ...metadata, agents: [agent] },
    { ...metadata, agents: [{ id: 'native', label: 'Native', runtime: RECORDED_RUNTIME, commands: [], availability: agent.availability }], defaultAgentId: 'native' }]) {
    assert.deepEqual(parse(value), { ok: true, value });
  }
  for (const change of [{ defaultAgentId: 'missing' }, { defaultAgentId: '' }, { defaultAgentId: undefined },
    { agents: [{ ...agent, availability: { kind: 'ready' } }] },
    { compatibility: { ...compatibility, nativeRuntime: {} } }, { compatibility: { ...compatibility, nativeRuntime: 'none' } }]) {
    assert.throws(() => parse({ ...metadata, ...change }));
  }
});

test('extension-only compatibility skips native runtime while retaining every other dimension and wire six', () => {
  assert.equal(SERVICE_WIRE_VERSION, 6);
  assert.deepEqual(checkCompatibility(SOLO_CLIENT_COMPATIBILITY, compatibility), { kind: 'compatible' });
  assert.deepEqual(checkCompatibility({ ...SOLO_CLIENT_COMPATIBILITY, supportedWireVersions: [5] }, compatibility).issues.map(issue => issue.dimension), ['wire']);
  const result = checkCompatibility({ ...SOLO_CLIENT_COMPATIBILITY, expectedArtifactId: 'expected' }, {
    ...compatibility, wireVersion: 5, extensionSdkVersion: 'unsupported', desiredGitRevision: 'pending',
  });
  assert.deepEqual(result.issues.map(issue => issue.dimension), ['wire', 'extension-sdk', 'deployment', 'artifact']);
});

test('artifact runtime fields remain concrete after service metadata permits null', () => {
  const payload = { schemaVersion: 1, platform: 'browser-development', sourceRevision: 'a'.repeat(40),
    sourceDirty: { kind: 'clean' }, wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION,
    nativeRuntime: BROWSER_RUNTIME, artifactRuntime: BROWSER_RUNTIME, lockSha256: 'b'.repeat(64), assets: [] };
  for (const field of ['nativeRuntime', 'artifactRuntime']) assert.throws(() => manifestPayload({ ...payload, [field]: null }));
});
