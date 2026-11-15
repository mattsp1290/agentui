import { EXTENSION_SDK_VERSION } from './compatibility.js';
import { hex, nonempty, record } from './decode.js';
import { canonicalJson } from './durable.js';

export interface IosRuntimeIdentity {
  readonly engine: string;
  readonly version: string;
  readonly format: string;
  readonly reactNativeVersion: string;
  readonly nativeBuildIdentity: string;
}
export interface IosArtifact {
  readonly kind: 'ios';
  readonly delivery: 'embedded-full-native-build';
  readonly sdkVersion: typeof EXTENSION_SDK_VERSION;
  readonly runtime: IosRuntimeIdentity;
  readonly assets: readonly { readonly path: string; readonly sha256: string }[];
  readonly artifactId: string;
}
export type OptionalIosArtifact =
  | { readonly schemaVersion: 1; readonly kind: 'absent' }
  | { readonly schemaVersion: 1; readonly kind: 'present'; readonly artifact: IosArtifact };

function runtime(value: unknown): IosRuntimeIdentity {
  const input = record(value, ['engine', 'version', 'format', 'reactNativeVersion', 'nativeBuildIdentity']);
  return {
    engine: nonempty(input.engine), version: nonempty(input.version), format: nonempty(input.format),
    reactNativeVersion: nonempty(input.reactNativeVersion), nativeBuildIdentity: hex(input.nativeBuildIdentity, 64),
  };
}
function asset(value: unknown): IosArtifact['assets'][number] {
  const input = record(value, ['path', 'sha256']);
  const path = nonempty(input.path);
  if (path !== path.normalize('NFC') || path.startsWith('/') || path.includes('\\') || path.includes(':') ||
      [...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
      path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid iOS artifact asset path');
  }
  return { path, sha256: hex(input.sha256, 64) };
}
function artifact(value: unknown): IosArtifact {
  const input = record(value, ['kind', 'delivery', 'sdkVersion', 'runtime', 'assets', 'artifactId']);
  if (input.kind !== 'ios' || input.delivery !== 'embedded-full-native-build' ||
      input.sdkVersion !== EXTENSION_SDK_VERSION || !Array.isArray(input.assets)) {
    throw new Error('Unsupported iOS artifact');
  }
  const assets = Array.from(input.assets, asset);
  if (assets.length === 0 || assets.some((entry, index) => {
    const previous = assets[index - 1];
    return previous !== undefined && entry.path <= previous.path;
  })) throw new Error('iOS artifact assets must be nonempty, unique and sorted');
  return {
    kind: input.kind, delivery: input.delivery, sdkVersion: input.sdkVersion,
    runtime: runtime(input.runtime), assets, artifactId: hex(input.artifactId, 64),
  };
}
export function parseOptionalIosArtifact(value: unknown): OptionalIosArtifact {
  const input = record(value);
  if (input.schemaVersion !== 1) throw new Error('Unsupported optional iOS artifact version');
  if (input.kind === 'absent') {
    record(input, ['schemaVersion', 'kind']);
    return { schemaVersion: input.schemaVersion, kind: input.kind };
  }
  if (input.kind === 'present') {
    record(input, ['schemaVersion', 'kind', 'artifact']);
    return { schemaVersion: input.schemaVersion, kind: input.kind, artifact: artifact(input.artifact) };
  }
  throw new Error('Invalid optional iOS artifact kind');
}
export function iosArtifactIdentityText(value: IosArtifact): string {
  const { artifactId: _, ...payload } = value;
  return canonicalJson({ schemaVersion: 1, ...payload });
}
export function assertIosArtifactId(value: IosArtifact, digest: string): void {
  if (digest !== value.artifactId) throw new Error('iOS artifact identity mismatch');
}
export function assertIosRuntime(value: IosArtifact, installed: {
  readonly sdkVersion: string;
  readonly runtime: IosRuntimeIdentity;
}): void {
  if (value.sdkVersion !== installed.sdkVersion) throw new Error('iOS artifact SDK version mismatch');
  for (const field of ['engine', 'version', 'format', 'reactNativeVersion', 'nativeBuildIdentity'] satisfies readonly (keyof IosRuntimeIdentity)[]) {
    if (value.runtime[field] !== installed.runtime[field]) throw new Error(`iOS artifact runtime ${field} mismatch`);
  }
}
