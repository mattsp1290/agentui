import type { HostCompatibility } from './compatibility.js';
import { canonicalJson } from './durable.js';
import { record, nonempty, hex } from './decode.js';

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
export const BROWSER_RUNTIME = { engine: 'browser', version: 'development', format: 'web-assets' } as const;
const PAYLOAD_FIELDS = ['schemaVersion', 'platform', 'sourceRevision', 'sourceDirty', 'wireVersion', 'extensionSdkVersion', 'nativeRuntime', 'artifactRuntime', 'lockSha256', 'assets'];
function runtime(value: unknown): HostCompatibility['nativeRuntime'] {
  const input = record(value, ['engine', 'version', 'format']);
  return { engine: nonempty(input.engine), version: nonempty(input.version), format: nonempty(input.format) };
}
function dirty(value: unknown): SourceDirty {
  const input = record(value);
  if (input.kind === 'clean') { record(input, ['kind']); return { kind: 'clean' }; }
  if (input.kind === 'dirty') { record(input, ['kind', 'fingerprint']); return { kind: 'dirty', fingerprint: hex(input.fingerprint, 64) }; }
  throw new Error('Invalid artifact source dirty state');
}
function asset(value: unknown): Asset {
  const input = record(value, ['path', 'sha256']);
  const path = nonempty(input.path);
  if (path === 'artifact.json' || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid artifact asset path');
  }
  return { path, sha256: hex(input.sha256, 64) };
}
export function manifestPayload(value: unknown): Omit<ArtifactManifest, 'artifactId'> {
  const input = record(value, PAYLOAD_FIELDS);
  if (input.schemaVersion !== 1 || (input.platform !== 'host' && input.platform !== 'browser-development') ||
      input.wireVersion !== 1 || input.extensionSdkVersion !== '0.0.0' || !Array.isArray(input.assets)) {
    throw new Error('Unsupported artifact manifest');
  }
  const assets = input.assets.map(asset);
  if (assets.length === 0 || assets.some((entry, index) => {
    const previous = assets[index - 1];
    return previous !== undefined && entry.path <= previous.path;
  })) throw new Error('Artifact assets must be nonempty, unique and sorted');
  const nativeRuntime = runtime(input.nativeRuntime), artifactRuntime = runtime(input.artifactRuntime);
  if (input.platform === 'browser-development' && [nativeRuntime, artifactRuntime].some(value =>
    value.engine !== BROWSER_RUNTIME.engine || value.version !== BROWSER_RUNTIME.version || value.format !== BROWSER_RUNTIME.format)) {
    throw new Error('Unexpected browser runtime');
  }
  return {
    schemaVersion: input.schemaVersion, platform: input.platform, sourceRevision: hex(input.sourceRevision, 40, 64),
    sourceDirty: dirty(input.sourceDirty), wireVersion: input.wireVersion, extensionSdkVersion: input.extensionSdkVersion,
    nativeRuntime, artifactRuntime, lockSha256: hex(input.lockSha256, 64), assets,
  };
}
export function parseArtifactManifest(value: unknown, digest: (text: string) => string): ArtifactManifest;
export function parseArtifactManifest(value: unknown, digest: (text: string) => Promise<string>): Promise<ArtifactManifest>;
export function parseArtifactManifest(value: unknown, digest: (text: string) => string | Promise<string>): ArtifactManifest | Promise<ArtifactManifest> {
  const input = record(value, [...PAYLOAD_FIELDS, 'artifactId']);
  const { artifactId: rawId, ...rawPayload } = input;
  const payload = manifestPayload(rawPayload), artifactId = hex(rawId, 64);
  const verified = (computed: string): ArtifactManifest => {
    if (computed !== artifactId) throw new Error('Artifact manifest identity mismatch');
    return { ...payload, artifactId };
  };
  const computed = digest(canonicalJson(payload));
  return typeof computed === 'string' ? verified(computed) : computed.then(verified);
}
