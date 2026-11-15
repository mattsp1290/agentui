import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { PI_RUNTIME } from '@agentui/contracts/compatibility';
import { identifier, record } from '@agentui/contracts/decode';
import { canonicalJson } from '@agentui/contracts';
import type { ClientCommand, ConversationScope } from '@agentui/contracts';
import type { RunOutcome, TranscriptEvent } from '@agentui/contracts/conversation';
import type { NativeDispatchObservation } from '@mattsp1290/switchboard';
import { createPiRuntime } from '@agentui/switchboard-pi/pi';
import type { PiEvent, PiSession, PiTerminal } from '@agentui/switchboard-pi/pi';
import type { CapturedTarget, CommandResult, HostOutput, Installation, NativeRun, ProviderDriver } from './durable-model.js';

export interface PiDriverOptions {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly apiKey: string;
  readonly append: (scope: ConversationScope, output: HostOutput<TranscriptEvent>) => void;
}
interface Turn {
  readonly scope: ConversationScope;
  readonly session: PiSession;
  readonly run: NativeRun;
  readonly rendered: string[];
  text: string;
  revision: number;
  stopCommandId: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  ended: boolean;
  storageFailed: boolean;
}
type Observation = NativeDispatchObservation<CommandResult<TranscriptEvent>>;
const empty = (): HostOutput<TranscriptEvent> => ({ events: [], runs: [], decisions: [] });

function parts(text: string): string[] {
  const result: string[] = [];
  let start = 0, offset = 0, bytes = 0;
  for (const character of text) {
    const cost = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes + cost > 24_000) {
      result.push(text.slice(start, offset));
      start = offset; bytes = 0;
    }
    bytes += cost; offset += character.length;
  }
  result.push(text.slice(start));
  return result;
}

export async function createPiDriver(options: PiDriverOptions): Promise<ProviderDriver<TranscriptEvent> & {
  readonly installation: Installation; close(): Promise<void>;
}> {
  const cwd = realpathSync(options.cwd);
  const runtime = await createPiRuntime({ cwd, sessionDirectory: options.sessionDirectory,
    apiKey: options.apiKey, provider: 'opencode-go', model: 'glm-5.3' });
  const installation: Installation = { installationId: 'pi-opencode-go-glm-5-3-v1', binding: {
    engine: PI_RUNTIME.engine, nativeVersion: PI_RUNTIME.version, account: 'opencode-go:glm-5.3',
    authorizedScope: cwd, nativeFormat: PI_RUNTIME.format,
  } };
  const active = new Map<string, Turn>();
  const busy = new Set<string>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  function publish(turn: Turn, events: readonly TranscriptEvent[]) {
    options.append(turn.scope, { ...empty(), events });
  }
  function render(turn: Turn, complete: boolean) {
    clearTimeout(turn.timer); turn.timer = undefined;
    const text = parts(turn.text);
    for (let index = 0; index < Math.max(text.length, turn.rendered.length); index++) {
      const value = text[index] ?? '';
      if (!complete && turn.rendered[index] === value) continue;
      publish(turn, [{ kind: 'message-updated', messageId: `${turn.run.identity.runId}:assistant:${index}`,
        revision: ++turn.revision, role: 'assistant', text: value, complete }]);
      turn.rendered[index] = value;
    }
  }
  function finish(turn: Turn, terminal: PiTerminal) {
    if (turn.ended) return;
    turn.ended = true;
    clearTimeout(turn.timer); turn.timer = undefined;
    try {
      if (!turn.storageFailed) {
        if (terminal.outcome === 'failed') turn.text += '\n\nPi could not finish this response. You can send another message.';
        render(turn, true);
        const outcome: RunOutcome = closing ? 'connection-lost' : terminal.outcome;
        publish(turn, [{ kind: 'run-ended', runId: turn.run.identity.runId, outcome }]);
      }
    } finally {
      void turn.session.close().then(() => {
        active.delete(canonicalJson(turn.scope));
        busy.delete(canonicalJson(turn.scope));
      }, () => {
        process.emitWarning('Pi session cleanup failed. Restart the host before continuing.', { code: 'AGENTUI_PI_CLEANUP' });
      });
    }
  }
  function outputFailed(turn: Turn) {
    if (turn.storageFailed) return;
    turn.storageFailed = true;
    clearTimeout(turn.timer); turn.timer = undefined;
    try { render(turn, true); } catch {}
    try { publish(turn, [{ kind: 'run-ended', runId: turn.run.identity.runId, outcome: 'failed' }]); }
    catch { process.emitWarning('Could not store Pi output. Start a new conversation.', { code: 'AGENTUI_PI_STORAGE' }); }
    void turn.session.abort().catch(() => {});
  }
  function receive(turn: Turn, event: PiEvent) {
    if (turn.ended || turn.storageFailed) return;
    try {
      if (event.kind === 'ended') { finish(turn, event); return; }
      turn.text = event.text;
      turn.timer ??= setTimeout(() => {
        try { render(turn, false); } catch { outputFailed(turn); }
      }, 150);
      turn.timer.unref();
    } catch { outputFailed(turn); }
  }
  function evidence(command: ClientCommand, target: CapturedTarget, session: PiSession, phase: string): Observation {
    return { kind: 'conclusive', evidence: { identity: target.identity, source: 'native-acknowledgement',
      nativeOperation: { namespace: 'pi-sdk-session', id: session.id },
      observation: { namespace: 'pi-sdk', schemaVersion: 1,
        data: { sessionId: session.id, command: command.body.kind, phase } },
    }, result: { kind: 'completed', output: empty() } };
  }
  async function sessionFor(target: CapturedTarget): Promise<PiSession> {
    const saved = target.run ? record(JSON.parse(target.run.reference.opaque), ['id', 'file']) : null;
    const expectedId = saved ? identifier(saved.id) : null;
    const session = await runtime.open(saved ? { sessionFile: identifier(saved.file) } : {});
    if (expectedId !== null && session.id !== expectedId) {
      await session.close();
      throw new Error('Pi session identity changed');
    }
    return session;
  }
  return {
    source: 'pi', installation,
    capability(command) {
      if (closing) return { kind: 'unsupported', reason: 'Pi is disconnected. Restart the host to connect again.' };
      if (command.body.kind === 'approve') return { kind: 'unsupported', reason: 'This Pi chat has no tools or approvals.' };
      const key = canonicalJson(command.scope);
      if (command.body.kind === 'send' && busy.size >= 32) return { kind: 'unsupported', reason: 'Pi is responding in too many conversations. Wait for a response to finish.' };
      if (command.body.kind === 'send' && busy.has(key)) return { kind: 'unsupported', reason: 'Pi is still responding. Wait for it to finish.' };
      if (command.body.kind === 'cancel') {
        const turn = active.get(key);
        if (!turn || turn.ended || turn.run.identity.runId !== command.body.runId) return { kind: 'unsupported', reason: 'Pi turn is no longer active.' };
        if (turn.stopCommandId) return { kind: 'unsupported', reason: 'Pi is already stopping this response.' };
      }
      return { kind: 'supported' };
    },
    async dispatch(command, target) {
      if (canonicalJson(target.installation) !== canonicalJson(installation)) throw new Error('Wrong Pi installation');
      const key = canonicalJson(command.scope);
      if (command.body.kind === 'send') {
        if (closing || busy.has(key)) throw new Error('Pi is not ready for another response');
        busy.add(key);
        let turn: Turn | undefined;
        try {
          const session = await sessionFor(target);
          if (closing) throw new Error('Pi is closing');
          const runId = randomUUID();
          const opaque = canonicalJson({ id: session.id, file: session.sessionFile });
          const run: NativeRun = { identity: { conversation: command.scope, runId,
            authority: { kind: 'agentui-host', hostId: command.scope.hostId,
              binding: { namespace: 'pi-sdk-session', installationId: installation.installationId, opaqueSessionId: opaque } } },
            reference: { kind: 'session', formatVersion: 1, binding: installation.binding, opaque } };
          turn = { scope: command.scope, session, run, rendered: [], text: '', revision: 0,
            timer: undefined, stopCommandId: null, ended: false, storageFailed: false };
          active.set(key, turn);
          options.append(command.scope, { events: [
            { kind: 'message-updated', messageId: `${target.identity.hostOperationId}:user`, revision: 1,
              role: 'user', text: command.body.text, complete: true },
            { kind: 'run-started', runId, previousRunId: target.run?.identity.runId ?? null },
          ], runs: [run], decisions: [] });
          const current = turn;
          const admitted = await session.prompt(command.body.text, event => receive(current, event));
          void admitted.finished.then(result => {
            try { finish(current, result); } catch { outputFailed(current); }
          }, () => {
            try { finish(current, { kind: 'ended', outcome: 'failed' }); } catch { outputFailed(current); }
          });
          return evidence(command, target, session, 'preflight-started');
        } catch {
          if (turn) {
            try { finish(turn, { kind: 'ended', outcome: 'failed' }); } catch { outputFailed(turn); }
          }
          if (!turn) busy.delete(key);
          throw new Error('Pi could not start this response. Check command recovery before trying again.');
        }
      }
      if (command.body.kind === 'cancel') {
        const turn = active.get(key);
        if (!target.run || !turn || turn.ended || turn.stopCommandId ||
          turn.run.identity.runId !== command.body.runId || target.run.identity.runId !== command.body.runId) {
          throw new Error('Pi turn is no longer available to stop');
        }
        turn.stopCommandId = command.clientCommandId;
        try {
          publish(turn, [{ kind: 'run-stop-requested', runId: command.body.runId, clientCommandId: command.clientCommandId }]);
          await turn.session.abort();
          return evidence(command, target, turn.session, 'abort-idle');
        } catch {
          if (!turn.ended) {
            publish(turn, [{ kind: 'run-stop-rejected', runId: command.body.runId, clientCommandId: command.clientCommandId }]);
            turn.stopCommandId = null;
          }
          throw new Error('Pi could not confirm that this response stopped');
        }
      }
      throw new Error('This Pi chat has no tools or approvals');
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = runtime.close();
      return closePromise;
    },
  };
}
