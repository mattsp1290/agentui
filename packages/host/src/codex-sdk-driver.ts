import { realpathSync } from 'node:fs';
import type { ConversationScope } from '@agentui/contracts';
import { CODEX_SDK_RUNTIME } from '@agentui/contracts/compatibility';
import type { TranscriptEvent } from '@agentui/contracts/conversation';
import { createCodexRuntime } from '@agentui/switchboard-codex/codex';
import type { HostOutput, Installation } from './durable-model.js';
import { createSdkChatDriver } from './sdk-chat-driver.js';

export interface CodexSdkDriverOptions {
  readonly cwd: string;
  readonly currentRunId: (scope: ConversationScope) => string | null;
  readonly append: (scope: ConversationScope, output: HostOutput<TranscriptEvent>) => void;
  readonly codexPathOverride?: string;
  readonly codexHome?: string;
  readonly maxEventBytes?: number;
}
export function createCodexSdkDriver(options: CodexSdkDriverOptions) {
  const cwd = realpathSync(options.cwd);
  const runtime = createCodexRuntime({ cwd, model: 'gpt-6.1-sol',
    ...(options.codexPathOverride === undefined ? {} : { codexPathOverride: options.codexPathOverride }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
  });
  const installation: Installation = { installationId: 'codex-sdk-chatgpt-gpt-6-1-sol-v1', binding: {
    engine: CODEX_SDK_RUNTIME.engine, nativeVersion: CODEX_SDK_RUNTIME.version,
    account: 'chatgpt:gpt-6.1-sol', authorizedScope: cwd, nativeFormat: CODEX_SDK_RUNTIME.format,
  } };
  return createSdkChatDriver({ ...options, runtime, installation, source: 'codex-sdk', displayName: 'Codex',
    readinessFailure: 'Codex is unavailable. Check CLI version and ChatGPT login, then restart this host.',
    warningCode: 'AGENTUI_CODEX_SDK_STORAGE' });
}
