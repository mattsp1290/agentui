import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ServerArtifactExpectation } from '@agentui/host/customization';

declare const AGENTUI_SERVER_CUSTOMIZATION_ABI: string;

export function serverArtifactExpectation(artifactId: string): ServerArtifactExpectation {
  if (typeof AGENTUI_SERVER_CUSTOMIZATION_ABI !== 'string') throw new Error('Server artifacts require a packaged host');
  return { artifactId, sdkVersion: EXTENSION_SDK_VERSION, nodeVersion: process.versions.node,
    nodeModules: process.versions.modules, abiIdentity: AGENTUI_SERVER_CUSTOMIZATION_ABI };
}
export function serverArtifactSdk(): string { return new URL('./sdk.js', import.meta.url).href; }
