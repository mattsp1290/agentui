import { SERVICE_WIRE_VERSION, EXTENSION_SDK_VERSION } from './compatibility.js';
import type { HostCompatibility } from './compatibility.js';
import { assetInventory, runtimeIdentity, RUNTIME_IDENTITY_FIELDS } from './artifact-data.js';
import type { ArtifactAsset } from './artifact-data.js';
import { canonicalJson } from './durable.js';
import { record, hex } from './decode.js';

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
  readonly assets: readonly ArtifactAsset[];
  readonly artifactId: string;
}
export const BROWSER_RUNTIME = { engine: 'browser', version: 'development', format: 'web-assets' } as const;
const PAYLOAD_FIELDS = ['schemaVersion', 'platform', 'sourceRevision', 'sourceDirty', 'wireVersion', 'extensionSdkVersion', 'nativeRuntime', 'artifactRuntime', 'lockSha256', 'assets'];
function dirty(value: unknown): SourceDirty {
  const input = record(value);
  if (input.kind === 'clean') { record(input, ['kind']); return { kind: 'clean' }; }
  if (input.kind === 'dirty') { record(input, ['kind', 'fingerprint']); return { kind: 'dirty', fingerprint: hex(input.fingerprint, 64) }; }
  throw new Error('Invalid artifact source dirty state');
}
export function manifestPayload(value: unknown): Omit<ArtifactManifest, 'artifactId'> {
  const input = record(value, PAYLOAD_FIELDS);
  if (input.schemaVersion !== 1 || (input.platform !== 'host' && input.platform !== 'browser-development') ||
      input.wireVersion !== SERVICE_WIRE_VERSION || input.extensionSdkVersion !== EXTENSION_SDK_VERSION) {
    throw new Error('Unsupported artifact manifest');
  }
  const assets = assetInventory(input.assets, 'artifact.json');
  const nativeRuntime = runtimeIdentity(record(input.nativeRuntime, RUNTIME_IDENTITY_FIELDS));
  const artifactRuntime = runtimeIdentity(record(input.artifactRuntime, RUNTIME_IDENTITY_FIELDS));
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
