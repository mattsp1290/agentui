export interface NativeRuntimeIdentity {
  readonly engine: string;
  readonly version: string;
  readonly format: string;
}
export interface AppliedArtifactIdentity {
  readonly artifactId: string;
  readonly gitRevision: string;
}
export interface HostCompatibility {
  readonly wireVersion: number;
  readonly extensionSdkVersion: string;
  readonly nativeRuntime: NativeRuntimeIdentity;
  readonly desiredGitRevision: string;
  readonly appliedArtifact: AppliedArtifactIdentity;
}
export interface ClientCompatibility {
  readonly supportedWireVersions: readonly number[];
  readonly supportedExtensionSdkVersions: readonly string[];
  readonly supportedNativeRuntimes: readonly NativeRuntimeIdentity[];
  readonly expectedArtifactId: string | null;
}
export interface CompatibilityIssue {
  readonly dimension: 'wire' | 'extension-sdk' | 'native-runtime' | 'deployment' | 'artifact';
  readonly reason: string;
  readonly action: string;
}
export type CompatibilityResult =
  | { readonly kind: 'compatible' }
  | { readonly kind: 'incompatible'; readonly issues: readonly CompatibilityIssue[] };

export const SERVICE_WIRE_VERSION = 1;
export const EXTENSION_SDK_VERSION = '0.0.0';
export const RECORDED_RUNTIME = Object.freeze({ engine: 'agentui-recorded', version: 'recorded-v1', format: 'agentui-recorded-v1' });
export const RECORDED_CLIENT_COMPATIBILITY: ClientCompatibility = Object.freeze({
  supportedWireVersions: Object.freeze([SERVICE_WIRE_VERSION]),
  supportedExtensionSdkVersions: Object.freeze([EXTENSION_SDK_VERSION]),
  supportedNativeRuntimes: Object.freeze([RECORDED_RUNTIME]), expectedArtifactId: null,
});

