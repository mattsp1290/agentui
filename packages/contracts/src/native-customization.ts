import { EXTENSION_SDK_VERSION } from './compatibility.js';
import type { NativeRuntimeIdentity } from './compatibility.js';
import { assetInventory, runtimeIdentity, RUNTIME_IDENTITY_FIELDS } from './artifact-data.js';
import type { ArtifactAsset } from './artifact-data.js';
import { hex, nonempty, record } from './decode.js';
import { canonicalJson } from './durable.js';

export interface IosRuntimeIdentity extends NativeRuntimeIdentity {
  readonly reactNativeVersion: string;
  readonly nativeBuildIdentity: string;
}
export interface IosArtifact {
  readonly kind: 'ios';
  readonly delivery: 'embedded-full-native-build';
  readonly sdkVersion: typeof EXTENSION_SDK_VERSION;
  readonly runtime: IosRuntimeIdentity;
  readonly assets: readonly ArtifactAsset[];
  readonly artifactId: string;
}
export type OptionalIosArtifact =
  | { readonly schemaVersion: 1; readonly kind: 'absent' }
  | { readonly schemaVersion: 1; readonly kind: 'present'; readonly artifact: IosArtifact };

const IOS_RUNTIME_FIELDS = [...RUNTIME_IDENTITY_FIELDS, 'reactNativeVersion', 'nativeBuildIdentity'] as const satisfies readonly (keyof IosRuntimeIdentity)[];

function runtime(value: unknown): IosRuntimeIdentity {
  const input = record(value, IOS_RUNTIME_FIELDS);
  return {
    ...runtimeIdentity(input),
    reactNativeVersion: nonempty(input.reactNativeVersion), nativeBuildIdentity: hex(input.nativeBuildIdentity, 64),
  };
}
function artifact(value: unknown): IosArtifact {
  const input = record(value, ['kind', 'delivery', 'sdkVersion', 'runtime', 'assets', 'artifactId']);
  if (input.kind !== 'ios' || input.delivery !== 'embedded-full-native-build' ||
      input.sdkVersion !== EXTENSION_SDK_VERSION) {
    throw new Error('Unsupported iOS artifact');
  }
  const assets = assetInventory(input.assets);
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
  for (const field of IOS_RUNTIME_FIELDS) {
    if (value.runtime[field] !== installed.runtime[field]) throw new Error(`iOS artifact runtime ${field} mismatch`);
  }
}
