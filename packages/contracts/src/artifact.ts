import { SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION } from './compatibility.js';
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
  readonly wireVersion: typeof SERVICE_WIRE_VERSION;
  readonly extensionSdkVersion: typeof EXTENSION_SDK_VERSION;
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
      input.wireVersion !== SERVICE_WIRE_VERSION || input.extensionSdkVersion !== EXTENSION_SDK_VERSION || !Array.isArray(input.assets)) {
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
export function parseArtifactManifest(value: unknown): ArtifactManifest {
  const input = record(value, [...PAYLOAD_FIELDS, 'artifactId']);
  const { artifactId: rawId, ...rawPayload } = input;
  const payload = manifestPayload(rawPayload), artifactId = hex(rawId, 64);
  return { ...payload, artifactId };
}
export function artifactIdentityText(manifest: ArtifactManifest): string {
  const { artifactId: _, ...payload } = manifest;
  return canonicalJson(payload);
}
export function assertArtifactId(manifest: ArtifactManifest, digest: string): void {
  if (digest !== manifest.artifactId) throw new Error('Artifact manifest identity mismatch');
}
