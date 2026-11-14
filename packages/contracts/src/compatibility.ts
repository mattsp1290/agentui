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

