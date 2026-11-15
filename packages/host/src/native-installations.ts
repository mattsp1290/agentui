import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { CLAUDE_SDK_RUNTIMES, CODEX_SDK_RUNTIME, PI_RUNTIME } from '@agentui/contracts/compatibility';
import type { ClaudeSdkModel, NativeRuntimeIdentity } from '@agentui/contracts/compatibility';
import type { Installation } from './durable-model.js';
import { nonempty } from './codec.js';

function installed(installationId: string, runtime: NativeRuntimeIdentity, account: string, cwd: string): Installation {
  return { installationId, binding: { engine: runtime.engine, nativeVersion: runtime.version,
    nativeFormat: runtime.format, account, authorizedScope: cwd } };
}
const codexModelPrefix = 'codex-local-model-v1:';
export function codexInstallation(cwd: string, version: string, model?: string): Installation {
  return installed(model === undefined ? 'codex-local-v1' : `${codexModelPrefix}${encodeURIComponent(nonempty(model))}`, { engine: 'codex', version: nonempty(version), format: 'codex-app-server-v2' }, 'local', resolve(cwd));
}
export function codexInstallationModel(installation: Installation): string | null {
  if (installation.binding.engine !== 'codex' || !installation.installationId.startsWith(codexModelPrefix)) return null;
  try { return nonempty(decodeURIComponent(installation.installationId.slice(codexModelPrefix.length))); }
  catch { return null; }
}
export function codexSdkInstallation(cwd: string): Installation {
  return installed('codex-sdk-chatgpt-gpt-6-1-sol-v1', CODEX_SDK_RUNTIME, 'chatgpt:gpt-6.1-sol', realpathSync(cwd));
}
export function claudeSdkInstallation(cwd: string, model: ClaudeSdkModel): Installation {
  return installed(`claude-sdk-api-key-${model}-v1`, CLAUDE_SDK_RUNTIMES[model], `anthropic-api-key:${model}`, realpathSync(cwd));
}
export function piInstallation(cwd: string): Installation {
  return installed('pi-opencode-go-glm-5-3-v1', PI_RUNTIME, 'opencode-go:glm-5.3', realpathSync(cwd));
}
