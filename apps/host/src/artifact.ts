import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { HostCompatibility } from '@agentui/contracts/compatibility';
import { canonicalJson } from '@agentui/contracts';

interface Asset {
  readonly path: string;
  readonly sha256: string;
}
type SourceDirty = { readonly kind: 'clean' } | { readonly kind: 'dirty'; readonly fingerprint: string };
export interface ArtifactManifest {
  readonly schemaVersion: 1;
  readonly platform: 'host' | 'browser-development';
  readonly sourceRevision: string;
  readonly sourceDirty: SourceDirty;
  readonly wireVersion: 1;
  readonly extensionSdkVersion: '0.0.0';
  readonly nativeRuntime: HostCompatibility['nativeRuntime'];
  readonly artifactRuntime: HostCompatibility['nativeRuntime'];
  readonly lockSha256: string;
  readonly assets: readonly Asset[];
  readonly artifactId: string;
}

function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid artifact manifest object');
  const entries = Object.entries(value);
  if (keys !== undefined && (entries.length !== keys.length || entries.some(([key]) => !keys.includes(key)))) {
    throw new Error('Invalid artifact manifest fields');
  }
  return Object.fromEntries(entries);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('Invalid artifact manifest text');
  return value;
}
function sha256(value: unknown): string {
  const hash = text(value);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid artifact manifest SHA256');
  return hash;
}
function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function dirty(value: unknown): SourceDirty {
  const input = object(value);
  if (input.kind === 'clean' && Object.keys(input).length === 1) return { kind: 'clean' };
  if (input.kind === 'dirty' && Object.keys(input).length === 2) return { kind: 'dirty', fingerprint: sha256(input.fingerprint) };
  throw new Error('Invalid artifact source dirty state');
}
function asset(value: unknown): Asset {
  const input = object(value, ['path', 'sha256']);
  const path = text(input.path);
  if (path === 'artifact.json' || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..') || isAbsolute(path)) {
    throw new Error('Invalid artifact asset path');
  }
  return { path, sha256: sha256(input.sha256) };
}

export function parseArtifactManifest(value: unknown): ArtifactManifest {
  const input = object(value, ['schemaVersion', 'platform', 'sourceRevision', 'sourceDirty', 'wireVersion', 'extensionSdkVersion', 'nativeRuntime', 'artifactRuntime', 'lockSha256', 'assets', 'artifactId']);
  const runtime = object(input.nativeRuntime, ['engine', 'version', 'format']);
  const artifactRuntime = object(input.artifactRuntime, ['engine', 'version', 'format']);
  if (input.schemaVersion !== 1 || (input.platform !== 'host' && input.platform !== 'browser-development') ||
      input.wireVersion !== 1 || input.extensionSdkVersion !== '0.0.0' || !Array.isArray(input.assets)) {
    throw new Error('Unsupported artifact manifest');
  }
  const sourceRevision = text(input.sourceRevision);
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sourceRevision)) throw new Error('Invalid artifact source revision');
  const assets = input.assets.map(asset);
  if (assets.length === 0 || assets.some((entry, index) => {
    const previous = assets[index - 1];
    return previous !== undefined && entry.path <= previous.path;
  })) {
    throw new Error('Artifact assets must be nonempty, unique and sorted');
  }
  const payload = {
    schemaVersion: input.schemaVersion,
    platform: input.platform,
    sourceRevision,
    sourceDirty: dirty(input.sourceDirty),
    wireVersion: input.wireVersion,
    extensionSdkVersion: input.extensionSdkVersion,
    nativeRuntime: { engine: text(runtime.engine), version: text(runtime.version), format: text(runtime.format) },
    artifactRuntime: { engine: text(artifactRuntime.engine), version: text(artifactRuntime.version), format: text(artifactRuntime.format) },
    lockSha256: sha256(input.lockSha256),
    assets,
  } satisfies Omit<ArtifactManifest, 'artifactId'>;
  const artifactId = sha256(input.artifactId);
  if (digest(canonicalJson(payload)) !== artifactId) throw new Error('Artifact manifest identity mismatch');
  return { ...payload, artifactId };
}

export function readArtifact(directory: string, expectedPlatform: ArtifactManifest['platform']): ArtifactManifest {
  const root = realpathSync(directory);
  const manifestPath = join(root, 'artifact.json');
  if (!lstatSync(manifestPath).isFile()) throw new Error('Artifact manifest must be a regular file');
  const manifest = parseArtifactManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  if (manifest.platform !== expectedPlatform) throw new Error(`Artifact requires a ${expectedPlatform} artifact`);
  const found: string[] = [];
  function verify(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name);
      const name = relative(root, absolute).split('\\').join('/');
      if (name === 'artifact.json') continue;
      if (entry.isDirectory()) verify(absolute);
      else {
        if (!entry.isFile() || !realpathSync(absolute).startsWith(`${root}/`)) throw new Error('Artifact asset escapes installed directory');
        found.push(name);
      }
    }
  }
  verify(root);
  found.sort();
  if (JSON.stringify(found) !== JSON.stringify(manifest.assets.map(entry => entry.path))) throw new Error('Installed artifact file list mismatch');
  for (const entry of manifest.assets) {
    if (digest(readFileSync(resolve(root, entry.path))) !== entry.sha256) throw new Error(`Installed artifact digest mismatch: ${entry.path}`);
  }
  return manifest;
}

export function readArtifactBytes(directory: string, platform: ArtifactManifest['platform']) {
  const manifest = readArtifact(directory, platform);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (const entry of manifest.assets) {
    const bytes = readFileSync(resolve(directory, entry.path));
    total += bytes.length;
    if (total > 32_000_000 || digest(bytes) !== entry.sha256) throw new Error('Browser artifact changed or exceeds memory budget');
    files.set(entry.path, bytes);
  }
  files.set('artifact.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  const frozen: ReadonlyMap<string, Buffer> = files;
  return { manifest, files: frozen };
}

export function readInstalledArtifact(directory: string, options: { readonly desiredGitRevision?: string } = {}): { readonly manifest: ArtifactManifest; readonly compatibility: HostCompatibility } {
  const manifest = readArtifact(directory, 'host');
  return { manifest, compatibility: {
    wireVersion: manifest.wireVersion,
    extensionSdkVersion: manifest.extensionSdkVersion,
    nativeRuntime: manifest.nativeRuntime,
    desiredGitRevision: options.desiredGitRevision === undefined ? manifest.sourceRevision : text(options.desiredGitRevision),
    appliedArtifact: { gitRevision: manifest.sourceRevision, artifactId: manifest.artifactId },
  } };
}
