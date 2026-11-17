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
  readonly nativeRuntime: NativeRuntimeIdentity | null;
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

export const SERVICE_WIRE_VERSION = 11;
export const EXTENSION_SDK_VERSION = '0.9.0';
export const RECORDED_RUNTIME = Object.freeze({ engine: 'agentui-recorded', version: 'recorded-v1', format: 'agentui-recorded-v1' });
export const CODEX_RUNTIME = Object.freeze({ engine: 'codex', version: '0.167.2', format: 'codex-app-server-v2' });
export const CODEX_SDK_MODEL = Object.freeze({ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' });
export const CODEX_SDK_CHAT_LABEL = `Codex · ${CODEX_SDK_MODEL.label} · ChatGPT subscription`;
export const CODEX_SDK_RUNTIME = Object.freeze({ engine: 'codex-sdk', version: '0.169.0', format: 'codex-sdk-chat-chatgpt-gpt-6.1-sol-v1' });
export type ClaudeSdkModel = 'opus' | 'sonnet';
export const CLAUDE_SDK_CHAT_LABELS = Object.freeze({
  opus: 'Claude · Opus · API key',
  sonnet: 'Claude · Sonnet · API key',
});
export const CLAUDE_SDK_RUNTIMES = Object.freeze({
  opus: Object.freeze({ engine: 'claude-sdk', version: '0.3.323', format: 'claude-sdk-chat-api-key-opus-v1' }),
  sonnet: Object.freeze({ engine: 'claude-sdk', version: '0.3.323', format: 'claude-sdk-chat-api-key-sonnet-v1' }),
});
export const PI_CHAT_LABEL = 'Pi · GLM 5.3 · OpenCode Go';
export const PI_RUNTIME = Object.freeze({ engine: 'pi', version: '1.5.2', format: 'pi-sdk-chat-opencode-go-glm-5.3-v1' });
export const RECORDED_CLIENT_COMPATIBILITY: ClientCompatibility = Object.freeze({
  supportedWireVersions: Object.freeze([SERVICE_WIRE_VERSION]),
  supportedExtensionSdkVersions: Object.freeze([EXTENSION_SDK_VERSION]),
  supportedNativeRuntimes: Object.freeze([RECORDED_RUNTIME]), expectedArtifactId: null,
});
export const SOLO_CLIENT_COMPATIBILITY: ClientCompatibility = Object.freeze({
  ...RECORDED_CLIENT_COMPATIBILITY,
  supportedNativeRuntimes: Object.freeze([RECORDED_RUNTIME, CODEX_RUNTIME, CODEX_SDK_RUNTIME, ...Object.values(CLAUDE_SDK_RUNTIMES), PI_RUNTIME]),
});

