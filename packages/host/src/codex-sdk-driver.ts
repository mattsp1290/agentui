import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { canonicalJson } from '@agentui/contracts';
import type { ClientCommand, ConversationScope, Envelope } from '@agentui/contracts';
import { CODEX_SDK_RUNTIME } from '@agentui/contracts/compatibility';
import type { TranscriptEvent } from '@agentui/contracts/conversation';
import type { NativeDispatchObservation } from '@mattsp1290/switchboard';
import { createCodexRuntime } from '@agentui/switchboard-codex/codex';
import type { CodexEvent, CodexTerminal, CodexTurn } from '@agentui/switchboard-codex/codex';
import type { CapturedTarget, CommandResult, HostOutput, Installation, NativeRun, ProviderDriver } from './durable-model.js';
import { budgets } from './durable-model.js';
import { createTranscriptWriter } from './transcript-writer.js';

export interface CodexSdkDriverOptions {
  readonly cwd: string;
  readonly currentRunId: (scope: ConversationScope) => string | null;
  readonly append: (scope: ConversationScope, output: HostOutput<TranscriptEvent>) => void;
  readonly codexPathOverride?: string;
  readonly codexHome?: string;
  readonly maxEventBytes?: number;
}
interface Turn {
  readonly scope: ConversationScope;
  readonly native: CodexTurn;
  readonly run: NativeRun;
  readonly messages: Map<string, string>;
  readonly transcript: ReturnType<typeof createTranscriptWriter>;
  phase: 'admitting' | 'running' | 'ending' | 'ended';
  stopCommandId: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  storageFailed: boolean;
}
type Observation = NativeDispatchObservation<CommandResult<TranscriptEvent>>;
const empty = (): HostOutput<TranscriptEvent> => ({ events: [], runs: [], decisions: [] });
const UUID_OPERATION_ID = '00000000-0000-0000-0000-000000000000';
function userMessage(text: string, operation: string): TranscriptEvent {
  return { kind: 'message-updated', messageId: `${operation}:user`, revision: 1, role: 'user', text, complete: true };
}

export function createCodexSdkDriver(options: CodexSdkDriverOptions): ProviderDriver<TranscriptEvent> & {
  readonly installation: Installation; ready(): Promise<void>; close(): Promise<void>;
} {
  const cwd = realpathSync(options.cwd);
  const limits = budgets(options.maxEventBytes === undefined ? {} : { maxEventBytes: options.maxEventBytes });
  const runtime = createCodexRuntime({ cwd, model: 'gpt-6.1-sol',
    ...(options.codexPathOverride === undefined ? {} : { codexPathOverride: options.codexPathOverride }),
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
  });
  const installation: Installation = { installationId: 'codex-sdk-chatgpt-gpt-6-1-sol-v1', binding: {
    engine: CODEX_SDK_RUNTIME.engine, nativeVersion: CODEX_SDK_RUNTIME.version,
    account: 'chatgpt:gpt-6.1-sol', authorizedScope: cwd, nativeFormat: CODEX_SDK_RUNTIME.format,
  } };
  const active = new Map<string, Turn>();
  const busy = new Set<string>();
  const failedFinalizations = new Set<string>();
  const finalizations = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  function publish(turn: Turn, events: readonly TranscriptEvent[]) {
    options.append(turn.scope, { ...empty(), events });
  }
  function render(turn: Turn, complete: boolean) {
    clearTimeout(turn.timer); turn.timer = undefined;
    if (turn.messages.size === 0) return;
    turn.transcript.write([...turn.messages.values()].join('\n\n'), complete);
  }
  function sealSaved(turn: Turn) {
    if (!turn.transcript.sealSaved()) {
      process.emitWarning('Could not finish stored Codex output. Start a new conversation.', { code: 'AGENTUI_CODEX_SDK_STORAGE' });
    }
  }
  function outputFailed(turn: Turn) {
    if (turn.storageFailed) return;
    turn.storageFailed = true;
    clearTimeout(turn.timer); turn.timer = undefined;
    void turn.native.abort().catch(() => {});
  }
  function finish(turn: Turn, terminal: CodexTerminal) {
    if (turn.phase !== 'running') return;
    turn.phase = 'ending';
    clearTimeout(turn.timer); turn.timer = undefined;
    const finalization = Promise.resolve().then(() => {
      const key = canonicalJson(turn.scope);
      if (terminal.outcome === 'failed' && !turn.storageFailed) {
        turn.messages.set('agentui:failure', 'Codex could not finish this response. You can send another message.');
      }
      try { render(turn, true); }
      catch { outputFailed(turn); try { render(turn, true); } catch { sealSaved(turn); } }
      const outcome = turn.storageFailed ? 'failed'
        : closing && terminal.outcome !== 'completed' ? 'connection-lost' : terminal.outcome;
      try { publish(turn, [{ kind: 'run-ended', runId: turn.run.identity.runId, outcome }]); }
      catch {
        outputFailed(turn);
        try { publish(turn, [{ kind: 'run-ended', runId: turn.run.identity.runId, outcome: 'failed' }]); }
        catch {
          failedFinalizations.add(key);
          process.emitWarning('Could not store the end of this Codex response. Restart the host before continuing.', { code: 'AGENTUI_CODEX_SDK_STORAGE' });
        }
      }
      turn.phase = 'ended';
      active.delete(key); busy.delete(key);
    });
    finalizations.add(finalization);
    void finalization.then(() => finalizations.delete(finalization), () => finalizations.delete(finalization));
  }
  function receive(turn: Turn, event: CodexEvent) {
    if (turn.phase !== 'running') return;
    if (event.kind === 'ended') { finish(turn, event); return; }
    if (turn.storageFailed) return;
    turn.messages.set(event.itemId, event.text);
    turn.timer ??= setTimeout(() => {
      try { render(turn, false); } catch { outputFailed(turn); }
    }, 150);
    turn.timer.unref();
  }
  function evidence(command: ClientCommand, target: CapturedTarget, threadId: string, phase: string): Observation {
    return { kind: 'conclusive', evidence: { identity: target.identity, source: 'native-acknowledgement',
      nativeOperation: { namespace: 'codex-sdk-session', id: threadId },
      observation: { namespace: 'codex-sdk', schemaVersion: 1,
        data: { threadId, command: command.body.kind, phase } },
    }, result: { kind: 'completed', output: empty() } };
  }
  function rejected(command: ClientCommand, target: CapturedTarget, phase: string, reason: string): Observation {
    return { kind: 'conclusive', evidence: { identity: target.identity, source: 'native-acknowledgement',
      nativeOperation: null, observation: { namespace: 'codex-sdk', schemaVersion: 1,
        data: { command: command.body.kind, phase } },
    }, result: { kind: 'rejected', reason } };
  }
  return {
    source: 'codex-sdk', installation,
    ready: () => runtime.checkReady(),
    capability(command) {
      if (closing) return { kind: 'unsupported', reason: 'Codex is disconnected. Restart the host to connect again.' };
      if (command.body.kind === 'approve') return { kind: 'unsupported', reason: 'Interactive approvals are unavailable in this Codex mode.' };
      if (command.body.kind === 'send') {
        if (!command.body.text.trim()) return { kind: 'unsupported', reason: 'invalid-message' };
        const envelope: Envelope<TranscriptEvent> = { scope: command.scope, sequence: Number.MAX_SAFE_INTEGER,
          event: { kind: 'domain', event: userMessage(command.body.text, UUID_OPERATION_ID) } };
        if (Buffer.byteLength(canonicalJson(envelope)) > limits.maxEventBytes) return { kind: 'unsupported', reason: 'message-too-large' };
      }
      const key = canonicalJson(command.scope);
      if (failedFinalizations.has(key)) return { kind: 'unsupported', reason: 'Codex could not save the end of this response. Restart the host before continuing.' };
      if (command.body.kind === 'send' && busy.size >= 32) return { kind: 'unsupported', reason: 'Codex is responding in too many conversations. Wait for a response to finish.' };
      if (command.body.kind === 'send' && busy.has(key)) return { kind: 'unsupported', reason: 'Codex is still responding. Wait for it to finish.' };
      if (command.body.kind === 'cancel') {
        const turn = active.get(key);
        if (!turn || turn.phase !== 'running' || turn.run.identity.runId !== command.body.runId) return { kind: 'unsupported', reason: 'Codex turn is no longer active.' };
        if (turn.stopCommandId) return { kind: 'unsupported', reason: 'Codex is already stopping this response.' };
      }
      return { kind: 'supported' };
    },
    async dispatch(command, target) {
      if (canonicalJson(target.installation) !== canonicalJson(installation)) throw new Error('Wrong Codex SDK installation');
      const key = canonicalJson(command.scope);
      if (command.body.kind === 'send') {
        if (closing || busy.has(key) || failedFinalizations.has(key)) throw new Error('Codex is not ready for another response');
        busy.add(key);
        try { await runtime.checkReady(); }
        catch {
          busy.delete(key);
          return rejected(command, target, 'readiness-rejected', 'Codex is unavailable. Check CLI version and ChatGPT login, then restart this host.');
        }
        let turn: Turn | undefined;
        let native: CodexTurn | undefined;
        const queued: CodexEvent[] = [];
        try {
          native = await runtime.start({ text: command.body.text,
            ...(target.run === null ? {} : { threadId: target.run.reference.opaque }),
            onEvent(event) { if (turn) receive(turn, event); else queued.push(event); },
          });
          if (closing) throw new Error('Codex is closing');
          const runId = randomUUID();
          const run: NativeRun = { identity: { conversation: command.scope, runId,
            authority: { kind: 'agentui-host', hostId: command.scope.hostId,
              binding: { namespace: 'codex-sdk-session', installationId: installation.installationId, opaqueSessionId: native.threadId } } },
            reference: { kind: 'session', formatVersion: 1, binding: installation.binding, opaque: native.threadId } };
          turn = { scope: command.scope, native, run, messages: new Map(),
            transcript: createTranscriptWriter({ messageIdPrefix: `${runId}:assistant`,
              publish: events => options.append(command.scope, { ...empty(), events }) }),
            phase: 'admitting', timer: undefined, stopCommandId: null, storageFailed: false };
          options.append(command.scope, { events: [
            userMessage(command.body.text, target.identity.hostOperationId),
            { kind: 'run-started', runId, previousRunId: options.currentRunId(command.scope) },
          ], runs: [run], decisions: [] });
          turn.phase = 'running';
          active.set(key, turn);
          const current = turn;
          void native.finished.then(terminal => finish(current, terminal), () => finish(current, { kind: 'ended', outcome: 'failed' }));
          for (const event of queued) receive(current, event);
          return evidence(command, target, native.threadId, 'turn-started');
        } catch {
          if (native) await native.abort().catch(() => {});
          if (turn?.phase === 'running') finish(turn, { kind: 'ended', outcome: 'failed' });
          else busy.delete(key);
          throw new Error('Codex could not start this response. Check command recovery before trying again.');
        }
      }
      if (command.body.kind === 'cancel') {
        const turn = active.get(key);
        if (!target.run || !turn || turn.phase !== 'running' || turn.stopCommandId ||
          turn.run.identity.runId !== command.body.runId || target.run.identity.runId !== command.body.runId) {
          throw new Error('Codex turn is no longer available to stop');
        }
        turn.stopCommandId = command.clientCommandId;
        let requested = false;
        try {
          publish(turn, [{ kind: 'run-stop-requested', runId: command.body.runId, clientCommandId: command.clientCommandId }]);
          requested = true;
          await turn.native.abort();
          return evidence(command, target, turn.native.threadId, 'abort-confirmed');
        } catch {
          try {
            if (!requested) return rejected(command, target, 'stop-storage-rejected', 'Codex could not store Stop. Try Stop again.');
            if (requested && turn.phase === 'running') {
              publish(turn, [{ kind: 'run-stop-rejected', runId: command.body.runId, clientCommandId: command.clientCommandId }]);
            }
          } finally {
            turn.stopCommandId = null;
          }
          throw new Error('Codex could not confirm that this response stopped');
        }
      }
      throw new Error('Interactive approvals are unavailable in this Codex mode');
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        try { await runtime.close(); }
        finally { await Promise.all(finalizations); }
      })();
      return closePromise;
    },
  };
}
