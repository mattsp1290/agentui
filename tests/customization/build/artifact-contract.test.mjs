import assert from 'node:assert/strict';
import test from 'node:test';
import { BROWSER_RUNTIME, parseArtifactManifest } from '@agentui/contracts/artifact';
import { EXTENSION_SDK_VERSION, SERVICE_WIRE_VERSION } from '@agentui/contracts/compatibility';

function fixture(platform) {
  return {
    schemaVersion: 1, platform, sourceRevision: 'a'.repeat(40), sourceDirty: { kind: 'clean' },
    wireVersion: SERVICE_WIRE_VERSION, extensionSdkVersion: EXTENSION_SDK_VERSION,
    nativeRuntime: { ...BROWSER_RUNTIME }, artifactRuntime: { ...BROWSER_RUNTIME },
    lockSha256: 'b'.repeat(64), assets: [{ path: 'main.js', sha256: 'c'.repeat(64) }],
    artifactId: 'd'.repeat(64),
  };
}

for (const platform of ['host', 'browser-development']) {
  test(`${platform} artifact retains copied runtime and portable asset inventory`, () => {
    const input = fixture(platform);
    input.assets = ['assets/artifact.json', 'assets/café.png', 'main.js'].map(path => ({ path, sha256: 'c'.repeat(64) }));
    const parsed = parseArtifactManifest(input);
    assert.deepEqual(parsed, input);
    assert.notEqual(parsed.assets, input.assets);
    assert.notEqual(parsed.assets[0], input.assets[0]);
    assert.notEqual(parsed.nativeRuntime, input.nativeRuntime);
    assert.notEqual(parsed.artifactRuntime, input.artifactRuntime);
  });

  for (const path of ['', '/', '/absolute', '../escape', './main.js', 'a/../main.js',
    'a//main.js', 'a/', 'a\\main.js', 'C:/main.js', 'C:main.js', 'a:b',
    'main\0.js', 'main\n.js', 'main\t.js', 'main\u007f.js', 'assets/cafe\u0301.png', 'artifact.json']) {
    test(`${platform} artifact rejects invalid path ${JSON.stringify(path)}`, () => {
      const input = fixture(platform);
      input.assets[0].path = path;
      assert.throws(() => parseArtifactManifest(input));
    });
  }

  for (const [label, assets] of [
    ['empty', []], ['non-array', {}], ['sparse', Array(1)],
    ['trailing hole', [{ path: 'a.js', sha256: 'c'.repeat(64) }].concat(Array(1))],
    ['duplicate', ['a.js', 'a.js'].map(path => ({ path, sha256: 'c'.repeat(64) }))],
    ['unsorted', ['b.js', 'a.js'].map(path => ({ path, sha256: 'c'.repeat(64) }))],
    ['invalid digest', [{ path: 'a.js', sha256: 'bad' }]],
    ['unknown asset field', [{ path: 'a.js', sha256: 'c'.repeat(64), extra: true }]],
  ]) {
    test(`${platform} artifact rejects ${label} inventory`, () => {
      assert.throws(() => parseArtifactManifest({ ...fixture(platform), assets }));
    });
  }

  for (const runtime of ['nativeRuntime', 'artifactRuntime']) {
    for (const field of ['engine', 'version', 'format']) {
      test(`${platform} artifact rejects empty ${runtime} ${field}`, () => {
        const input = fixture(platform);
        input[runtime][field] = '';
        assert.throws(() => parseArtifactManifest(input));
      });
    }
    test(`${platform} artifact rejects unknown ${runtime} field`, () => {
      const input = fixture(platform);
      input[runtime].extra = true;
      assert.throws(() => parseArtifactManifest(input));
    });
  }
}
