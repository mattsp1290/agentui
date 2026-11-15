import type { ClientCompatibility, HostCompatibility, CompatibilityIssue, CompatibilityResult } from '@agentui/contracts/compatibility';
export type { AppliedArtifactIdentity, ClientCompatibility, CompatibilityIssue, CompatibilityResult, HostCompatibility, NativeRuntimeIdentity } from '@agentui/contracts/compatibility';

export function checkCompatibility(client: ClientCompatibility, host: HostCompatibility): CompatibilityResult {
  const issues: CompatibilityIssue[] = [];
  if (!client.supportedWireVersions.includes(host.wireVersion)) {
    issues.push({ dimension: 'wire',
      reason: `Host wire version ${host.wireVersion} is unsupported`,
      action: 'Update the client or connect to a host using a supported wire version.' });
  }
  if (!client.supportedExtensionSdkVersions.includes(host.extensionSdkVersion)) {
    issues.push({ dimension: 'extension-sdk',
      reason: `Host extension SDK contract ${host.extensionSdkVersion} is unsupported`,
      action: 'Install extensions supporting the host SDK contract or update the host extension runtime.' });
  }
  const nativeRuntime = host.nativeRuntime;
  if (nativeRuntime !== null && !client.supportedNativeRuntimes.some(runtime =>
    runtime.engine === nativeRuntime.engine && runtime.version === nativeRuntime.version &&
    runtime.format === nativeRuntime.format)) {
    issues.push({ dimension: 'native-runtime',
      reason: `Native runtime ${nativeRuntime.engine} ${nativeRuntime.version} format ${nativeRuntime.format} is unsupported`,
      action: 'Select a supported native engine, runtime version and session format.' });
  }
  if (host.desiredGitRevision !== host.appliedArtifact.gitRevision) {
    issues.push({ dimension: 'deployment',
      reason: `Desired Git revision ${host.desiredGitRevision} differs from applied revision ${host.appliedArtifact.gitRevision}`,
      action: 'Finish applying the desired deployment before reconnecting.' });
  }
  if (client.expectedArtifactId !== null && client.expectedArtifactId !== host.appliedArtifact.artifactId) {
    issues.push({ dimension: 'artifact',
      reason: `Expected artifact ${client.expectedArtifactId} differs from applied artifact ${host.appliedArtifact.artifactId}`,
      action: 'Apply the expected artifact or explicitly update the client artifact expectation.' });
  }
  return issues.length ? { kind: 'incompatible', issues } : { kind: 'compatible' };
}
