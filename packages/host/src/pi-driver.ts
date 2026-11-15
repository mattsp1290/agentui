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
import { messageParts } from './transcript-parts.js';

export interface PiDriverOptions {
  readonly cwd: string;
  readonly sessionDirectory: string;
  readonly apiKey: string;
  readonly currentRunId: (scope: ConversationScope) => string | null;
  readonly append: (scope: ConversationScope, output: HostOutput<TranscriptEvent>) => void;
}
interface Turn {
  readonly scope: ConversationScope;
  readonly session: PiSession;
  readonly run: NativeRun;
  readonly rendered: { text: string; complete: boolean; revision: number }[];
  text: string;
  revision: number;
  stopCommandId: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  ended: boolean;
  storageFailed: boolean;
  registered: boolean;
  admitted: boolean;
}
type Observation = NativeDispatchObservation<CommandResult<TranscriptEvent>>;
const empty = (): HostOutput<TranscriptEvent> => ({ events: [], runs: [], decisions: [] });

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
  const cleanupFailed = new Set<string>();
  const finalizations = new Set<Promise<void>>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  function publish(turn: Turn, events: readonly TranscriptEvent[]) {
    options.append(turn.scope, { ...empty(), events });
  }
  function render(turn: Turn, complete: boolean) {
    clearTimeout(turn.timer); turn.timer = undefined;
    const text = messageParts(turn.text);
    for (let index = 0; index < Math.max(text.length, turn.rendered.length); index++) {
      const value = text[index] ?? '';
      const previous = turn.rendered[index];
      if (previous?.complete || !complete && previous?.text === value) continue;
      const revision = ++turn.revision;
      publish(turn, [{ kind: 'message-updated', messageId: `${turn.run.identity.runId}:assistant:${index}`,
        revision, role: 'assistant', text: value, complete }]);
      turn.rendered[index] = { text: value, complete, revision };
    }
  }
  function sealSaved(turn: Turn) {
    for (const [index, previous] of turn.rendered.entries()) {
      if (previous.complete) continue;
      const revision = previous.revision + 1;
      try {
        publish(turn, [{ kind: 'message-updated', messageId: `${turn.run.identity.runId}:assistant:${index}`,
          revision, role: 'assistant', text: previous.text, complete: true }]);
        turn.rendered[index] = { ...previous, revision, complete: true };
        turn.revision = Math.max(turn.revision, revision);
      } catch {
        process.emitWarning('Could not finish stored Pi output. Start a new conversation.', { code: 'AGENTUI_PI_STORAGE' });
      }
    }
  }
  function registerReference(turn: Turn) {
    if (turn.registered || !turn.admitted) return;
    options.append(turn.scope, { ...empty(), runs: [turn.run] });
    turn.registered = true;
  }
  function finish(turn: Turn, terminal: PiTerminal) {
    if (turn.ended) return;
    turn.ended = true;
    clearTimeout(turn.timer); turn.timer = undefined;
    // Native terminal callbacks must return before close can await the native completion.
    const finalization = Promise.resolve().then(async () => {
      const key = canonicalJson(turn.scope);
      try { registerReference(turn); } catch { outputFailed(turn); }
      try {
        await turn.session.close();
        active.delete(key);
        busy.delete(key);
      } catch {
        cleanupFailed.add(key);
        turn.text += '\n\nPi session cleanup failed. Restart the host before continuing.';
        process.emitWarning('Pi session cleanup failed. Restart the host before continuing.', { code: 'AGENTUI_PI_CLEANUP' });
      }
      try {
        registerReference(turn);
        if (terminal.outcome === 'failed' && !turn.storageFailed && !cleanupFailed.has(key)) {
          turn.text += '\n\nPi could not finish this response. You can send another message.';
        }
        render(turn, true);
      } catch { outputFailed(turn); try { render(turn, true); } catch { sealSaved(turn); } }
      const outcome: RunOutcome = closing && terminal.outcome !== 'completed' ? 'connection-lost'
        : cleanupFailed.has(key) || turn.storageFailed ? 'failed' : terminal.outcome;
      try { publish(turn, [{ kind: 'run-ended', runId: turn.run.identity.runId, outcome }]); }
      catch {
        outputFailed(turn);
        try { publish(turn, [{ kind: 'run-ended', runId: turn.run.identity.runId, outcome: 'failed' }]); }
        catch { process.emitWarning('Could not store Pi output. Start a new conversation.', { code: 'AGENTUI_PI_STORAGE' }); }
      }
    });
    finalizations.add(finalization);
    void finalization.then(() => finalizations.delete(finalization), () => finalizations.delete(finalization));
  }
  function outputFailed(turn: Turn) {
    if (turn.storageFailed) return;
    turn.storageFailed = true;
    clearTimeout(turn.timer); turn.timer = undefined;
    void turn.session.abort().catch(() => {});
    finish(turn, { kind: 'ended', outcome: 'failed' });
  }
  function receive(turn: Turn, event: PiEvent) {
    if (turn.ended || turn.storageFailed) return;
    try {
      registerReference(turn);
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
      if (cleanupFailed.has(key)) return { kind: 'unsupported', reason: 'Pi session cleanup failed. Restart the host before continuing.' };
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
            timer: undefined, stopCommandId: null, ended: false, storageFailed: false, registered: false, admitted: false };
          active.set(key, turn);
          options.append(command.scope, { events: [
            { kind: 'message-updated', messageId: `${target.identity.hostOperationId}:user`, revision: 1,
              role: 'user', text: command.body.text, complete: true },
            { kind: 'run-started', runId, previousRunId: options.currentRunId(command.scope) },
          ], runs: [], decisions: [] });
          const current = turn;
          const admitted = await session.prompt(command.body.text, event => receive(current, event));
          current.admitted = true;
          void admitted.finished.then(result => finish(current, result),
            () => finish(current, { kind: 'ended', outcome: 'failed' }));
          registerReference(current);
          return evidence(command, target, session, 'started-and-journaled');
        } catch {
          if (turn) finish(turn, { kind: 'ended', outcome: 'failed' });
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
      closePromise = (async () => {
        try { await runtime.close(); }
        finally { await Promise.all(finalizations); }
        if (cleanupFailed.size) throw new Error('Pi session cleanup failed. Restart the host before continuing.');
      })();
      return closePromise;
    },
  };
}
