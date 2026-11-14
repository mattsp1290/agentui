import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { ClientCommand, ConversationScope } from '@agentui/contracts';
import type { NativeDispatchObservation } from '@mattsp1290/switchboard';
import { canonicalJson } from '@agentui/contracts';
import { nonempty, object } from './codec.js';
import type { CapturedTarget, CommandResult, HostOutput, Installation, NativeRun, ProviderDriver } from './durable-model.js';
import { CodexRpc } from './codex-rpc.js';

export interface CodexTranscriptEvent {
  readonly kind: 'message-updated';
  readonly messageId: string;
  readonly revision: number;
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly complete: boolean;
}
export interface CodexDriverOptions {
  readonly cwd: string;
  readonly version: string;
  readonly append: (scope: ConversationScope, output: HostOutput<CodexTranscriptEvent>) => void;
  readonly executable?: string;
  readonly args?: readonly string[];
}
interface ActiveTurn {
  readonly scope: ConversationScope;
  readonly threadId: string;
  readonly messages: Map<string, string>;
  revision: number;
  complete: boolean;
  run: NativeRun | null;
}
interface Approval {
  readonly id: string | number;
  readonly pendingId: string;
  readonly turn: ActiveTurn;
  readonly run: NativeRun;
  resolve: (() => void) | null;
}
type Observation = NativeDispatchObservation<CommandResult<CodexTranscriptEvent>>;
const empty = (): HostOutput<CodexTranscriptEvent> => ({ events: [], runs: [], decisions: [] });
const scopeKey = (scope: ConversationScope) => canonicalJson(scope);

export function createCodexDriver(options: CodexDriverOptions): ProviderDriver<CodexTranscriptEvent> & {
  readonly installation: Installation; close(): void;
} {
  const cwd = resolve(options.cwd);
  const installation: Installation = { installationId: 'codex-local-v1', binding: {
    engine: 'codex', nativeVersion: nonempty(options.version), account: 'local', authorizedScope: cwd,
    nativeFormat: 'codex-app-server-v2',
  } };
  const active = new Map<string, ActiveTurn>();
  const busy = new Set<string>();
  const loaded = new Set<string>();
  const approvals = new Map<string, Approval>();
  let closing = false;
  let disconnected = false;
  const rpc = new CodexRpc({ cwd,
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    ...(options.args === undefined ? {} : { args: options.args }),
    onNotification: notification, onRequest: request,
    onClose() {
      disconnected = true;
      for (const turn of active.values()) {
        if (closing) break;
        try { interrupted(turn, 'Codex disconnected. This turn was interrupted. Restart the host to connect again.'); }
        catch { process.emitWarning('Could not store interrupted Codex output', { code: 'AGENTUI_CODEX_STORAGE' }); }
      }
      active.clear(); busy.clear();
    },
  });
  let initialization: Promise<void> | null = null;
  function initialize(): Promise<void> {
    initialization ??= rpc.request('initialize', {
      clientInfo: { name: 'agentui', version: '0.0.0' }, capabilities: { experimentalApi: false },
    }).then(() => rpc.notify('initialized', {}));
    return initialization;
  }
  function publish(turn: ActiveTurn, events: readonly CodexTranscriptEvent[], decisions: HostOutput<CodexTranscriptEvent>['decisions'] = []) {
    if (closing) return;
    options.append(turn.scope, { events, runs: turn.run ? [turn.run] : [], decisions });
  }
  function renderMessage(turn: ActiveTurn) {
    if (!turn.run) return;
    publish(turn, [{ kind: 'message-updated', messageId: `${turn.threadId}:${turn.run.identity.runId}:assistant`,
      role: 'assistant', text: [...turn.messages.values()].join('\n\n'), revision: ++turn.revision, complete: turn.complete }]);
  }
  function message(turn: ActiveTurn, id: string, text: string) {
    if (turn.complete) return;
    turn.messages.set(id, text);
    renderMessage(turn);
  }
  function interrupted(turn: ActiveTurn, text: string) {
    if (turn.complete) return;
    turn.messages.set(`status:${randomUUID()}`, text);
    turn.complete = true;
    renderMessage(turn);
  }
  function status(turn: ActiveTurn, text: string) {
    message(turn, `status:${randomUUID()}`, text);
  }
  function run(turn: ActiveTurn, turnId: string): NativeRun {
    const value: NativeRun = { identity: { conversation: turn.scope, runId: turnId,
      authority: { kind: 'agentui-host', hostId: turn.scope.hostId,
        binding: { namespace: 'codex-app-server', installationId: installation.installationId, opaqueSessionId: turn.threadId } } },
      reference: { kind: 'session', formatVersion: 1, binding: installation.binding, opaque: turn.threadId },
    };
    if (turn.run && turn.run.identity.runId !== turnId) throw new Error('Unexpected Codex turn');
    if (!turn.run) {
      turn.run = value;
      renderMessage(turn);
    }
    return value;
  }
  function notification(method: string, value: unknown): void {
    if (closing || !['turn/started', 'turn/completed', 'item/agentMessage/delta', 'item/completed', 'serverRequest/resolved', 'error'].includes(method)) return;
    const params = object(value);
    if (method === 'serverRequest/resolved') {
      const approval = approvals.get(canonicalJson(params.requestId));
      if (approval && params.threadId === approval.turn.threadId) approval.resolve?.();
      return;
    }
    const turn = active.get(nonempty(params.threadId));
    if (!turn) return;
    if (method === 'turn/started') {
      run(turn, nonempty(object(params.turn).id));
      publish(turn, []);
    } else if (method === 'item/agentMessage/delta') {
      if (turn.run?.identity.runId !== params.turnId) return;
      const id = nonempty(params.itemId);
      if (typeof params.delta !== 'string') throw new Error('Invalid Codex text delta');
      message(turn, id, (turn.messages.get(id) ?? '') + params.delta);
    } else if (method === 'item/completed') {
      if (turn.run?.identity.runId !== params.turnId) return;
      const item = object(params.item);
      if (item.type === 'agentMessage') {
        if (typeof item.text !== 'string') throw new Error('Invalid Codex message');
        message(turn, nonempty(item.id), item.text);
      }
    } else if (method === 'turn/completed') {
      const completed = object(params.turn);
      if (turn.run?.identity.runId !== completed.id) return;
      if (completed.status === 'failed') status(turn, 'Codex could not finish this response. You can send another message.');
      if (completed.status === 'interrupted') status(turn, 'Codex stopped this response.');
      turn.complete = true;
      renderMessage(turn);
      active.delete(turn.threadId); busy.delete(scopeKey(turn.scope));
    } else if (method === 'error' && params.willRetry !== true) {
      status(turn, 'Codex reported an error while responding.');
    }
  }
  function request(id: string | number, method: string, value: unknown): void {
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
      rpc.rejectRequest(id, 'This interaction is not supported by AgentUI yet.');
      return;
    }
    const params = object(value);
    const turn = active.get(nonempty(params.threadId));
    if (!turn?.run || turn.run.identity.runId !== params.turnId) {
      rpc.rejectRequest(id, 'Approval does not belong to an active AgentUI turn.');
      return;
    }
    const pendingId = randomUUID();
    const approval: Approval = { id, pendingId, turn, run: turn.run, resolve: null };
    approvals.set(canonicalJson(id), approval);
    const action = typeof params.command === 'string' ? params.command : 'Allow Codex to change files?';
    const reason = typeof params.reason === 'string' && params.reason ? `\n\n${params.reason}` : '';
    publish(turn, [], [{ visible: { pendingId, runId: turn.run.identity.runId,
      choices: ['accept', 'decline'], prompt: `${action}${reason}` },
      continuation: { processId: rpc.processId, requestId: id, threadId: turn.threadId, turnId: turn.run.identity.runId },
    }]);
  }
  function acknowledged(command: ClientCommand, target: CapturedTarget, output: HostOutput<CodexTranscriptEvent>, nativeId: string): Observation {
    const result: Observation = { kind: 'conclusive', evidence: {
      identity: target.identity, source: 'native-acknowledgement',
      nativeOperation: { namespace: 'codex-app-server', id: nativeId },
      observation: { namespace: 'codex-app-server', schemaVersion: 2,
        data: { processId: rpc.processId, command: command.body.kind, nativeId } },
    }, result: { kind: 'completed', output } };
    return result;
  }
  async function send(command: ClientCommand & { readonly body: { readonly kind: 'send'; readonly text: string } }, target: CapturedTarget): Promise<Observation> {
    const key = scopeKey(command.scope);
    busy.add(key);
    let turn: ActiveTurn | null = null;
    try {
      await initialize();
      let threadId: string;
      if (target.run) {
        threadId = target.run.reference.opaque;
        if (!loaded.has(threadId)) {
          await rpc.request('thread/resume', { threadId, cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' });
          loaded.add(threadId);
        }
      } else {
        const response = object(await rpc.request('thread/start', { cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', ephemeral: false }));
        threadId = nonempty(object(response.thread).id);
        loaded.add(threadId);
      }
      turn = { scope: command.scope, threadId, messages: new Map(), run: null, revision: 0, complete: false };
      active.set(threadId, turn);
      publish(turn, [{ kind: 'message-updated', messageId: `${target.identity.hostOperationId}:user`,
        revision: 1, role: 'user', text: command.body.text, complete: true }]);
      const result = object(await rpc.request('turn/start', { threadId,
        input: [{ type: 'text', text: command.body.text, text_elements: [] }], clientUserMessageId: command.clientCommandId }));
      const nativeRun = run(turn, nonempty(object(result.turn).id));
      return acknowledged(command, target, { events: [], runs: [nativeRun], decisions: [] }, nativeRun.identity.runId);
    } catch (error) {
      if (turn) {
        interrupted(turn, 'Codex could not start this response. Check command recovery before trying again.');
        active.delete(turn.threadId);
      }
      busy.delete(key);
      throw error;
    }
  }
  return {
    source: 'codex', installation,
    capability(command) {
      if (closing || disconnected) return { kind: 'unsupported', reason: 'codex-disconnected' };
      if (command.body.kind === 'send' && busy.has(scopeKey(command.scope))) return { kind: 'unsupported', reason: 'Codex is still responding. Wait for it to finish.' };
      return { kind: 'supported' };
    },
    async dispatch(command, target) {
      if (canonicalJson(target.installation) !== canonicalJson(installation)) throw new Error('Wrong Codex installation');
      switch (command.body.kind) {
        case 'send': return send({ ...command, body: command.body }, target);
        case 'approve': {
          if (!target.decision || !target.run) throw new Error('Approval target is missing');
          const continuation = object(target.decision.continuation);
          const approval = approvals.get(canonicalJson(continuation.requestId));
          if (continuation.processId !== rpc.processId || !approval || approval.pendingId !== target.decision.visible.pendingId ||
            approval.run.identity.runId !== target.run.identity.runId || scopeKey(approval.turn.scope) !== scopeKey(command.scope)) {
            throw new Error('Codex approval expired with its connection');
          }
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const resolved = new Promise<void>((resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Codex did not confirm this approval')), 15_000);
            timeout.unref();
            approval.resolve = resolve;
          });
          try { await Promise.all([rpc.respond(approval.id, { decision: command.body.choiceId }), resolved]); }
          finally { clearTimeout(timeout); approval.resolve = null; }
          approvals.delete(canonicalJson(approval.id));
          return acknowledged(command, target, empty(), `${approval.turn.threadId}:${canonicalJson(approval.id)}`);
        }
        case 'cancel': {
          if (!target.run) throw new Error('Cancel target is missing');
          const threadId = target.run.reference.opaque;
          const turn = active.get(threadId);
          if (!turn || turn.run?.identity.runId !== command.body.runId) throw new Error('Codex turn is no longer active');
          await rpc.request('turn/interrupt', { threadId, turnId: command.body.runId });
          return acknowledged(command, target, empty(), command.body.runId);
        }
      }
    },
    close() {
      if (closing) return;
      try { for (const turn of active.values()) interrupted(turn, 'Codex stopped when the host closed. You can send another message after reconnecting.'); }
      finally { closing = true; rpc.close(); }
    },
  };
}
