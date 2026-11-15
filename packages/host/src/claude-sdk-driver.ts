import { realpathSync } from 'node:fs';
import type { ConversationScope } from '@agentui/contracts';
import { CLAUDE_SDK_RUNTIMES } from '@agentui/contracts/compatibility';
import type { ClaudeSdkModel } from '@agentui/contracts/compatibility';
import type { TranscriptEvent } from '@agentui/contracts/conversation';
import { createClaudeRuntime } from '@agentui/switchboard-claude/claude';
import type { HostOutput, Installation } from './durable-model.js';
import { createSdkChatDriver } from './sdk-chat-driver.js';

export interface ClaudeSdkDriverOptions {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly apiKey: string;
  readonly model: ClaudeSdkModel;
  readonly currentRunId: (scope: ConversationScope) => string | null;
  readonly append: (scope: ConversationScope, output: HostOutput<TranscriptEvent>) => void;
  readonly claudePathOverride?: string;
  readonly maxEventBytes?: number;
}
export function createClaudeSdkDriver(options: ClaudeSdkDriverOptions) {
  if (!options.apiKey.trim()) throw new Error('Set AGENTUI_ANTHROPIC_API_KEY in the host environment before starting Claude.');
  const cwd = realpathSync(options.cwd);
  const runtime = createClaudeRuntime({ cwd, sessionDirectory: options.sessionDirectory,
    apiKey: options.apiKey.trim(), model: options.model,
    ...(options.claudePathOverride === undefined ? {} : { claudePathOverride: options.claudePathOverride }),
  });
  const identity = CLAUDE_SDK_RUNTIMES[options.model];
  const installation: Installation = { installationId: `claude-sdk-api-key-${options.model}-v1`, binding: {
    engine: identity.engine, nativeVersion: identity.version,
    account: `anthropic-api-key:${options.model}`, authorizedScope: cwd, nativeFormat: identity.format,
  } };
  return createSdkChatDriver({ runtime, installation, source: 'claude-sdk', displayName: 'Claude',
    currentRunId: options.currentRunId, append: options.append,
    ...(options.maxEventBytes === undefined ? {} : { maxEventBytes: options.maxEventBytes }),
    readinessFailure: 'Claude is unavailable. Check the SDK installation and API key, then restart this host.',
    warningCode: 'AGENTUI_CLAUDE_SDK_STORAGE' });
}
