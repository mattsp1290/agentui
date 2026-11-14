import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseArtifactManifest, readArtifact, readInstalledArtifact } from '../../apps/host/dist/artifact.js';

const generator = fileURLToPath(new URL('../../scripts/artifact-manifest.mjs', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agentui-artifact-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  put('.gitignore', 'dist/\nweb-dist/\nweb-dist-browser/\n.audit/\nnode_modules/\n');
  put('package.json', '{"name":"artifact-fixture"}');
  put('package-lock.json', '{"lockfileVersion":3}');
  put('apps/host/src/main.ts', 'export const value = 1;\n');
  git('add', '.');
  git('-c', 'user.name=Artifact test', '-c', 'user.email=artifact@example.invalid', 'commit', '-m', 'Initial product source');
  put('apps/host/dist/index.js', 'export const value = 1;\n');
  put('apps/host/dist/nested/code.js.map', '{"version":3}\n');
  put('apps/desktop/web-dist-browser/index.html', '<!doctype html><title>Artifact</title>');
  put('apps/desktop/web-dist-browser/assets/main.js', 'document.title = "Artifact";');
  const build = (platform = 'host') => {
    execFileSync(process.execPath, [generator, platform], { cwd: root, stdio: 'pipe' });
    return JSON.parse(readFileSync(join(root, platform === 'host' ? 'apps/host/dist/artifact.json' : 'apps/desktop/web-dist-browser/artifact.json'), 'utf8'));
  };
  const directory = join(root, 'apps/host/dist');
  return { root, put, git, build, directory };
}

test('actual CLI hashes built files, excludes its manifest, and records applied source separately from desired source', t => {
  const f = fixture(t);
  const first = f.build();
  assert.deepEqual(first.sourceDirty, { kind: 'clean' });
  assert.equal(first.sourceRevision, f.git('rev-parse', 'HEAD'));
  assert.equal(first.wireVersion, 1);
  assert.equal(first.extensionSdkVersion, '0.0.0');
  assert.deepEqual(first.nativeRuntime, { engine: 'agentui-recorded', version: 'recorded-v1', format: 'agentui-recorded-v1' });
  assert.deepEqual(first.artifactRuntime, { engine: 'node', version: process.versions.node, format: 'esm' });
  assert.deepEqual(first.assets.map(asset => asset.path), ['index.js', 'nested/code.js.map']);
  assert.equal(first.assets[0].sha256, createHash('sha256').update(readFileSync(join(f.directory, 'index.js'))).digest('hex'));
  assert.deepEqual(f.build(), first);
  f.put('apps/host/src/main.ts', 'export const value = 2;\n');
  const installed = readInstalledArtifact(f.directory, { desiredGitRevision: 'pending-revision' });
  assert.deepEqual(installed.manifest, first);
  assert.equal(installed.compatibility.appliedArtifact.gitRevision, first.sourceRevision);
  assert.equal(installed.compatibility.desiredGitRevision, 'pending-revision');
  assert.equal(readInstalledArtifact(f.directory).compatibility.desiredGitRevision, first.sourceRevision);
});

test('source identity fingerprints tracked edits, untracked product source, and deletions while excluding secrets and build output', t => {
  const f = fixture(t);
  const clean = f.build();
  f.put('apps/host/src/main.ts', 'export const value = 2;\n');
  const changed = f.build();
  assert.equal(changed.sourceDirty.kind, 'dirty');
  assert.notEqual(changed.artifactId, clean.artifactId);
  f.put('apps/host/src/new.ts', 'export const added = true;\n');
  const untracked = f.build();
  assert.notEqual(untracked.sourceDirty.fingerprint, changed.sourceDirty.fingerprint);
  f.put('.audit/evidence.txt', 'local evidence');
  f.put('apps/host/src/.env.local', 'DO_NOT_HASH=private');
  f.put('apps/host/build/output.js', 'temporary build bytes');
  f.put('node_modules/example/index.js', 'dependency');
  assert.deepEqual(f.build(), untracked);
  rmSync(join(f.root, 'apps/host/src/main.ts'));
  assert.notEqual(f.build().sourceDirty.fingerprint, untracked.sourceDirty.fingerprint);
});

test('lockfile and actual output bytes independently change artifact identity', t => {
  const f = fixture(t);
  const first = f.build();
  f.put('apps/host/dist/index.js', 'export const value = 3;\n');
  const changedAsset = f.build();
  assert.notEqual(changedAsset.artifactId, first.artifactId);
  assert.deepEqual(changedAsset.sourceDirty, { kind: 'clean' });
  f.put('package-lock.json', '{"lockfileVersion":3,"name":"changed"}');
  const changedLock = f.build();
  assert.notEqual(changedLock.lockSha256, changedAsset.lockSha256);
  assert.notEqual(changedLock.artifactId, changedAsset.artifactId);
});

test('credential and secret source modules affect fingerprints while secret file contents remain excluded', t => {
  const f = fixture(t);
  let previous = f.build();
  for (const name of ['credentials.ts', 'secrets.ts']) {
    f.put(`apps/host/src/${name}`, 'export const value = 1;\n');
    const added = f.build();
    assert.notEqual(added.sourceDirty.fingerprint, previous.sourceDirty.fingerprint);
    f.put(`apps/host/src/${name}`, 'export const value = 2;\n');
    previous = f.build();
    assert.notEqual(previous.sourceDirty.fingerprint, added.sourceDirty.fingerprint);
  }
  for (const name of ['.env', '.env.local', 'private.pem', 'private.key', 'private.p12']) {
    f.put(`apps/host/src/${name}`, 'private contents');
    assert.deepEqual(f.build(), previous);
    f.put(`apps/host/src/${name}`, 'changed private contents');
    assert.deepEqual(f.build(), previous);
  }
});

test('installed verification rejects tampered bytes, missing files, extra files, and manifest edits', t => {
  const f = fixture(t);
  const original = f.build();
  f.put('apps/host/dist/index.js', 'tampered');
  assert.throws(() => readInstalledArtifact(f.directory), /digest mismatch/);
  f.build();
  f.put('apps/host/dist/unlisted.js', 'extra');
  assert.throws(() => readInstalledArtifact(f.directory), /file list mismatch/);
  rmSync(join(f.directory, 'unlisted.js'));
  rmSync(join(f.directory, 'nested/code.js.map'));
  assert.throws(() => readInstalledArtifact(f.directory), /file list mismatch/);
  f.build();
  const manifest = JSON.parse(readFileSync(join(f.directory, 'artifact.json'), 'utf8'));
  f.put('apps/host/dist/artifact.json', JSON.stringify({ ...manifest, sourceRevision: 'a'.repeat(40) }));
  assert.throws(() => readInstalledArtifact(f.directory), /identity mismatch/);
  assert.throws(() => parseArtifactManifest({ ...original, assets: [{ path: '../outside', sha256: 'a'.repeat(64) }] }), /asset path/);
  assert.throws(() => parseArtifactManifest({ ...original, assets: [{ path: 'artifact.json', sha256: 'a'.repeat(64) }] }), /asset path/);
});

test('generator and installed verifier reject symlinks instead of reading files outside the artifact', t => {
  const f = fixture(t);
  f.build();
  symlinkSync(join(f.root, 'package.json'), join(f.directory, 'outside.json'));
  assert.throws(() => f.build(), /non-regular file/);
  assert.throws(() => readInstalledArtifact(f.directory), /escapes installed directory/);
});

test('browser development build records its own asset identity and cannot pass as an installed host', t => {
  const f = fixture(t);
  const manifest = f.build('browser-development');
  assert.equal(manifest.platform, 'browser-development');
  assert.equal(parseArtifactManifest(manifest).artifactId, manifest.artifactId);
  assert.deepEqual(manifest.assets.map(asset => asset.path), ['assets/main.js', 'index.html']);
  const directory = join(f.root, 'apps/desktop/web-dist-browser');
  assert.deepEqual(readArtifact(directory, 'browser-development'), manifest);
  assert.throws(() => readInstalledArtifact(directory), /requires a host artifact/);
  f.put('apps/desktop/web-dist-browser/assets/main.js', 'tampered browser code');
  assert.throws(() => readArtifact(directory, 'browser-development'), /digest mismatch/);
});
