import { codexSdkInstallation } from './native-installations.js';
import type { ConversationScope } from '@agentui/contracts';
import type { TranscriptEvent } from '@agentui/contracts/conversation';
import { CODEX_SDK_MODEL } from '@agentui/contracts/compatibility';
import { createCodexRuntime } from '@agentui/switchboard-codex/codex';
import type { HostOutput } from './durable-model.js';
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
  const installation = codexSdkInstallation(options.cwd);
  const cwd = installation.binding.authorizedScope;
  const runtime = createCodexRuntime({ cwd, model: CODEX_SDK_MODEL.id,
    ...(options.codexPathOverride === undefined ? {} : { codexPathOverride: options.codexPathOverride }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
  });
  return createSdkChatDriver({ ...options, runtime, installation, source: 'codex-sdk', displayName: 'Codex',
    readinessFailure: 'Codex is unavailable. Check CLI version and ChatGPT login, then restart this host.',
    warningCode: 'AGENTUI_CODEX_SDK_STORAGE' });
}
