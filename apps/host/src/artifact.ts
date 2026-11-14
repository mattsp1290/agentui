import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { HostCompatibility } from '@agentui/contracts/compatibility';
import { parseArtifactManifest, artifactIdentityText, assertArtifactId } from '@agentui/contracts/artifact';
import type { ArtifactManifest } from '@agentui/contracts/artifact';
import { nonempty } from '@agentui/contracts/decode';

export type { ArtifactManifest } from '@agentui/contracts/artifact';
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function verifyArtifact(directory: string, expectedPlatform: ArtifactManifest['platform'], retain: boolean) {
  const root = realpathSync(directory);
  const manifestPath = join(root, 'artifact.json');
  if (!lstatSync(manifestPath).isFile()) throw new Error('Artifact manifest must be a regular file');
  const manifest = parseArtifactManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  assertArtifactId(manifest, digest(artifactIdentityText(manifest)));
  if (manifest.platform !== expectedPlatform) throw new Error(`Artifact requires a ${expectedPlatform} artifact`);
  const expected = new Map(manifest.assets.map(entry => [entry.path, entry.sha256]));
  const files = new Map<string, Buffer>();
  let total = 0;
  function verify(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name);
      const name = relative(root, absolute).split('\\').join('/');
      if (name === 'artifact.json') continue;
      if (entry.isDirectory()) { verify(absolute); continue; }
      if (!entry.isFile() || !realpathSync(absolute).startsWith(`${root}/`)) throw new Error('Artifact asset escapes installed directory');
      const expectedDigest = expected.get(name);
      if (expectedDigest === undefined) throw new Error('Installed artifact file list mismatch');
      const bytes = readFileSync(absolute);
      if (digest(bytes) !== expectedDigest) throw new Error(`Installed artifact digest mismatch: ${name}`);
      expected.delete(name);
      if (retain) {
        total += bytes.length;
        if (total > 32_000_000) throw new Error('Installed artifact exceeds memory budget');
        files.set(name, bytes);
      }
    }
  }
  verify(root);
  if (expected.size) throw new Error('Installed artifact file list mismatch');
  if (retain) files.set('artifact.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  const frozen: ReadonlyMap<string, Buffer> = files;
  return { manifest, files: frozen };
}
export function readArtifact(directory: string, platform: ArtifactManifest['platform']): ArtifactManifest {
  return verifyArtifact(directory, platform, false).manifest;
}
export function readArtifactBytes(directory: string, platform: ArtifactManifest['platform']) {
  return verifyArtifact(directory, platform, true);
}
export function readInstalledArtifact(directory: string, options: { readonly desiredGitRevision?: string } = {}): { readonly manifest: ArtifactManifest; readonly compatibility: HostCompatibility } {
  const manifest = readArtifact(directory, 'host');
  if (manifest.artifactRuntime.engine !== 'node' || manifest.artifactRuntime.version !== process.versions.node || manifest.artifactRuntime.format !== 'esm') {
    throw new Error('Installed host runtime does not match this Node version');
  }
  return { manifest, compatibility: {
    wireVersion: manifest.wireVersion,
    extensionSdkVersion: manifest.extensionSdkVersion,
    nativeRuntime: manifest.nativeRuntime,
    desiredGitRevision: options.desiredGitRevision === undefined ? manifest.sourceRevision : nonempty(options.desiredGitRevision),
    appliedArtifact: { gitRevision: manifest.sourceRevision, artifactId: manifest.artifactId },
  } };
}
