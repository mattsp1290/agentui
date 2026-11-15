import { canonicalJson } from '@agentui/contracts';
import { utf8Bytes } from '@agentui/contracts/decode';
import { RECORDED_RUNTIME } from '@agentui/contracts/compatibility';
import type { ClientCommand, Envelope } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import { budgets } from './durable-model.js';
import type { CapturedTarget, CommandResult, HostOutput, Installation, NativeRun, ProviderDriver } from './durable-model.js';
import { openLocalHost } from './local-host.js';
import type { LocalHost, LocalHostOptions } from './local-host.js';
import { createRecordedDriver } from './recorded-driver.js';

export const recordedInstallation: Installation = Object.freeze({ installationId: 'agentui-recorded-v1',
  binding: Object.freeze({ engine: RECORDED_RUNTIME.engine, nativeVersion: RECORDED_RUNTIME.version, account: 'local',
    authorizedScope: 'recorded-conversations', nativeFormat: RECORDED_RUNTIME.format }) });
const UUID_OPERATION_ID = '00000000-0000-0000-0000-000000000000';

export interface RecordedHostOptions {
  readonly path: string;
  readonly backendPath: string;
  readonly hostId: string;
  readonly providers?: LocalHostOptions<TranscriptEvent, Transcript>['providers'];
  readonly progressMs?: number;
}
function update(messageId: string, text: string, revision: number, complete: boolean,
  role: 'user' | 'assistant' = 'assistant'): TranscriptEvent {
  return { kind: 'message-updated', messageId, revision, role, text, complete };
}
function output(events: readonly TranscriptEvent[], runs: readonly NativeRun[] = []): HostOutput<TranscriptEvent> {
  return { events, runs, decisions: [] };
}
function userEvents(command: ClientCommand, operation: string): readonly TranscriptEvent[] {
  return command.body.kind === 'send' ? [update(`${operation}:user`, command.body.text, 1, true, 'user')] : [];
}
function finalResult(command: ClientCommand, target: CapturedTarget): CommandResult<TranscriptEvent> {
  const operation = target.identity.hostOperationId;
  switch (command.body.kind) {
    case 'send': {
      const runId = `${operation}:run`, opaque = `${operation}:session`;
      const run: NativeRun = {
        identity: { conversation: command.scope, runId, authority: { kind: 'agentui-host', hostId: command.scope.hostId,
          binding: { namespace: 'agentui-recorded', installationId: recordedInstallation.installationId, opaqueSessionId: opaque } } },
        reference: { kind: 'session', formatVersion: 1, binding: recordedInstallation.binding, opaque },
      };
      return { kind: 'completed', output: {
        events: [...userEvents(command, operation), update(`${operation}:assistant`,
          'Recorded response complete. Choose whether to approve this recorded run.', 3, true)],
        runs: [run], decisions: [{ visible: { pendingId: `${operation}:approval`, runId, choices: ['approve', 'decline'],
          prompt: 'Approve this recorded run?' }, continuation: { recording: 'approval-v1', runId } }],
      } };
    }
    case 'approve': {
      if (!target.run || !target.decision) throw new Error('Recorded approval target is missing');
      return { kind: 'completed', output: output([update(`${operation}:assistant`,
        `Recorded decision ${command.body.choiceId} acknowledged for run ${target.run.identity.runId}.`, 3, true)], [target.run]) };
    }
    case 'cancel': return { kind: 'rejected', reason: 'recorded-cancel-unavailable' };
  }
}

export function openRecordedHost(options: RecordedHostOptions): LocalHost<TranscriptEvent, Transcript> {
  const requestedProgressMs = options.progressMs ?? 180;
  if (!options.hostId || !Number.isSafeInteger(requestedProgressMs) || requestedProgressMs < 0) {
    throw new Error('Invalid recorded host options');
  }
  const progressMs = Math.min(requestedProgressMs, 2000);
  let closing = false;
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, progressMs));
  const progress = (command: ClientCommand, events: readonly TranscriptEvent[]) => {
    if (closing) return;
    try { host.append(command.scope, output(events)); }
    catch (error) {
      process.emitWarning('Recorded progress could not be stored', { code: 'AGENTUI_RECORDED_PROGRESS',
        detail: error instanceof Error ? error.message : 'Unknown progress failure' });
    }
  };
  const recorded = createRecordedDriver<TranscriptEvent>({ installation: recordedInstallation, backendPath: options.backendPath,
    decodeEvent: transcriptProjection.decodeEvent,
    resolve: async (command, target) => finalResult(command, target),
    async afterAcceptance(command, target) {
      const operation = target.identity.hostOperationId;
      await pause();
      progress(command, [...userEvents(command, operation),
        update(`${operation}:assistant`, 'Recorded response started…', 1, false)]);
      await pause();
      progress(command, [update(`${operation}:assistant`, 'Recorded response in progress…', 2, false)]);
      await pause();
    },
  });
  const limits = budgets();
  const driver: ProviderDriver<TranscriptEvent> = { ...recorded,
    capability(command) {
      for (const event of userEvents(command, UUID_OPERATION_ID)) {
        const envelope: Envelope<TranscriptEvent> = { scope: command.scope, sequence: Number.MAX_SAFE_INTEGER, event: { kind: 'domain', event } };
        if (utf8Bytes(canonicalJson(envelope)) > limits.maxEventBytes) return { kind: 'unsupported', reason: 'message-too-large' };
      }
      return recorded.capability(command);
    },
  };
  const host = openLocalHost({ path: options.path, projection: transcriptProjection, driver,
    ...(options.providers ? { providers: options.providers } : {}),
    authorize: scope => scope.hostId === options.hostId });
  return { ...host,
    close() { closing = true; host.close(); },
    createConversation(scope, installation) {
      if (canonicalJson(installation) !== canonicalJson(recordedInstallation)) throw new Error('Recorded installation required');
      host.createConversation(scope, installation);
    },
  };
}
