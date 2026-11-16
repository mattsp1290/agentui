import { randomUUID } from 'node:crypto';
import { codexInstallation } from './native-installations.js';
import type { ClientCommand, ConversationScope } from '@agentui/contracts';
import type { NativeDispatchObservation } from '@mattsp1290/switchboard';
import { canonicalJson } from '@agentui/contracts';
import type { RunOutcome, TranscriptEvent } from '@agentui/contracts/conversation';
import type { ImageAttachment, ImageId } from '@agentui/contracts/image';
import { nonempty, object } from './codec.js';
import type { CapturedTarget, CommandResult, HostOutput, Installation, NativeRun, ProviderDriver } from './durable-model.js';
import { CodexRpc, CodexRpcError } from './codex-rpc.js';
import { approvalItem, approvalPrompt, bounded, rememberApprovalItem } from './codex-approval-display.js';
import type { ApprovalDetails } from './codex-approval-display.js';
import { createFileActivity } from './codex-file-activity.js';
import { createCommandActivity } from './codex-command-activity.js';
import { discoverCodexModels } from './codex-models.js';
import type { CodexModel } from './codex-models.js';
import { messageParts } from './transcript-parts.js';

export type CodexTranscriptEvent = TranscriptEvent;
export interface CodexDriverOptions {
  readonly cwd: string;
  readonly version: string;
  readonly append: (scope: ConversationScope, output: HostOutput<CodexTranscriptEvent>) => void;
  readonly executable?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly readImage?: (scope: ConversationScope, imageId: ImageId) => { readonly attachment: ImageAttachment; readonly bytes: Uint8Array };
}
interface ActiveTurn {
  readonly installation: Installation;
  readonly scope: ConversationScope;
  readonly threadId: string;
  readonly previousRunId: string | null;
  readonly messages: Map<string, string>;
  readonly approvalDetails: Map<string, ApprovalDetails>;
  readonly rendered: Extract<TranscriptEvent, { kind: 'message-updated' }>[];
  commands: ReturnType<typeof createCommandActivity> | null;
  files: ReturnType<typeof createFileActivity> | null;
  stopCommandId: string | null;
  timer: ReturnType<typeof setTimeout> | undefined;
  revision: number;
  complete: boolean;
  run: NativeRun | null;
}
interface Approval {
  readonly id: string | number;
  readonly pendingId: string;
  readonly turn: ActiveTurn;
  readonly run: NativeRun;
  waiter: { resolve: () => void; reject: (error: Error) => void } | null;
}
type Observation = NativeDispatchObservation<CommandResult<CodexTranscriptEvent>>;
const empty = (): HostOutput<CodexTranscriptEvent> => ({ events: [], runs: [], decisions: [] });
const scopeKey = (scope: ConversationScope) => canonicalJson(scope);

export interface CodexModelDriver {
  readonly model: CodexModel;
  readonly isDefault: boolean;
  readonly selectable: boolean;
  readonly driver: ProviderDriver<CodexTranscriptEvent>;
}
export interface CodexDriver extends ProviderDriver<CodexTranscriptEvent> {
  models(): Promise<readonly CodexModelDriver[]>;
  close(): void;
}
export function createCodexDriver(options: CodexDriverOptions): CodexDriver {
  const installation = codexInstallation(options.cwd, options.version);
  const cwd = installation.binding.authorizedScope;
  const active = new Map<string, ActiveTurn>();
  const closedTurns = new Map<string, { readonly runId: string; readonly commands: ReturnType<typeof createCommandActivity>; readonly files: ReturnType<typeof createFileActivity> }>();
  const busy = new Set<string>();
  const loaded = new Set<string>();
  const approvals = new Map<string, Approval>();
  let closing = false;
  let disconnected = false;
  const rpc = new CodexRpc({ cwd,
    ...(options.executable === undefined ? {} : { executable: options.executable }),
    ...(options.args === undefined ? {} : { args: options.args }),
    ...(options.env === undefined ? {} : { env: options.env }),
    onNotification: (method, value) => handleCallback(value, () => notification(method, value)),
    onRequest: (id, method, value) => handleCallback(value, () => request(id, method, value)),
    onClose() {
      disconnected = true;
      for (const turn of active.values()) {
        if (closing) break;
        try { interrupted(turn, 'Codex disconnected. This turn was interrupted. Restart the host to connect again.'); }
        catch { outputFailed(turn); }
      }
      active.clear(); closedTurns.clear(); busy.clear();
    },
  });
  let initialization: Promise<void> | null = null;
  function initialize(): Promise<void> {
    initialization ??= rpc.request('initialize', {
      clientInfo: { name: 'agentui', version: '0.0.0' }, capabilities: { experimentalApi: false },
    }).then(() => rpc.notify('initialized', {})).catch(error => { initialization = null; throw error; });
    return initialization;
  }
  function publish(turn: ActiveTurn, events: readonly CodexTranscriptEvent[],
    decisions: HostOutput<CodexTranscriptEvent>['decisions'] = [], runs: readonly NativeRun[] = []) {
    if (closing) return;
    options.append(turn.scope, { events, runs, decisions });
  }
  function renderMessage(turn: ActiveTurn) {
    clearTimeout(turn.timer); turn.timer = undefined;
    if (!turn.run) return;
    turn.commands?.flush();
    turn.files?.flush();
    const parts = messageParts([...turn.messages.values()].join('\n\n'));
    const count = Math.max(parts.length, turn.rendered.length);
    for (let index = 0; index < count; index++) {
      const text = parts[index] ?? '';
      const previous = turn.rendered[index];
      if (previous?.text === text && previous.complete === turn.complete) continue;
      const event: Extract<TranscriptEvent, { kind: 'message-updated' }> = { kind: 'message-updated',
        messageId: `${turn.threadId}:${turn.run.identity.runId}:assistant${index === 0 ? '' : `:${index}`}`,
        role: 'assistant', text, revision: ++turn.revision, complete: turn.complete };
      publish(turn, [event]);
      turn.rendered[index] = event;
    }
  }
  function message(turn: ActiveTurn, id: string, text: string) {
    if (turn.complete) return;
    turn.messages.set(id, text);
    schedule(turn);
  }
  function schedule(turn: ActiveTurn) {
    turn.timer ??= setTimeout(() => {
      try { renderMessage(turn); } catch { outputFailed(turn); }
    }, 150);
    turn.timer.unref();
  }
  function expireApprovals(turn: ActiveTurn) {
    const expiredDecisions: string[] = [];
    for (const [key, approval] of approvals) {
      if (approval.turn !== turn) continue;
      approvals.delete(key);
      approval.waiter?.reject(new Error('Codex approval expired before confirmation'));
      expiredDecisions.push(approval.pendingId);
    }
    if (expiredDecisions.length) options.append(turn.scope, { ...empty(), expiredDecisions });
  }
  function interrupted(turn: ActiveTurn, text: string) {
    expireApprovals(turn);
    if (turn.complete) return;
    turn.messages.set(`status:${randomUUID()}`, text);
    turn.complete = true;
    renderMessage(turn);
    endRun(turn, 'connection-lost');
  }
  function endRun(turn: ActiveTurn, outcome: RunOutcome) {
    if (turn.run) publish(turn, [{ kind: 'run-ended', runId: turn.run.identity.runId, outcome }]);
  }
  function status(turn: ActiveTurn, text: string) {
    message(turn, `status:${randomUUID()}`, text);
  }
  function outputFailed(turn: ActiveTurn) {
    clearTimeout(turn.timer); turn.timer = undefined;
    active.delete(turn.threadId); busy.delete(scopeKey(turn.scope));
    turn.complete = true;
    try { expireApprovals(turn); } catch { /* Storage can also reject expiry while full. */ }
    for (const [index, previous] of turn.rendered.entries()) {
      if (previous.complete) continue;
      const event = { ...previous, revision: ++turn.revision, complete: true };
      try { publish(turn, [event]); turn.rendered[index] = event; } catch { /* Try the remaining stored parts. */ }
    }
    try { endRun(turn, 'failed'); } catch { /* Restart recovery closes an unstorable run. */ }
    try {
      publish(turn, [{ kind: 'message-updated', messageId: `codex-storage:${randomUUID()}`,
        revision: 1, role: 'assistant', complete: true,
        text: 'This response stopped because AgentUI could not store more output. Try a new conversation.' }]);
    } catch { process.emitWarning('Could not store Codex output', { code: 'AGENTUI_CODEX_STORAGE' }); }
    if (turn.run && !disconnected && !closing) {
      void rpc.request('turn/interrupt', { threadId: turn.threadId, turnId: turn.run.identity.runId }).catch(() => {});
    }
  }
  function handleCallback(value: unknown, callback: () => void) {
    try { callback(); }
    catch {
      const threadId = value !== null && typeof value === 'object' && 'threadId' in value ? value.threadId : null;
      const turn = typeof threadId === 'string' ? active.get(threadId) : undefined;
      if (turn) outputFailed(turn);
      else process.emitWarning('Could not handle Codex output', { code: 'AGENTUI_CODEX_OUTPUT' });
    }
  }
  function run(turn: ActiveTurn, turnId: string): NativeRun {
    const value: NativeRun = { identity: { conversation: turn.scope, runId: turnId,
      authority: { kind: 'agentui-host', hostId: turn.scope.hostId,
        binding: { namespace: 'codex-app-server', installationId: turn.installation.installationId, opaqueSessionId: turn.threadId } } },
      reference: { kind: 'session', formatVersion: 1, binding: turn.installation.binding, opaque: turn.threadId },
    };
    if (turn.run && turn.run.identity.runId !== turnId) throw new Error('Unexpected Codex turn');
    if (!turn.run) {
      turn.run = value;
      const scope = turn.scope;
      turn.commands = createCommandActivity(turnId, event => {
        if (!closing) options.append(scope, { events: [event], runs: [], decisions: [] });
      });
      turn.files = createFileActivity(turnId, event => {
        if (!closing) options.append(scope, { events: [event], runs: [], decisions: [] });
      });
      publish(turn, [{ kind: 'run-started', runId: turnId, previousRunId: turn.previousRunId }], [], [value]);
    }
    return value;
  }
  function notification(method: string, value: unknown): void {
    if (closing || !['turn/started', 'turn/completed', 'item/agentMessage/delta', 'item/commandExecution/outputDelta', 'item/fileChange/patchUpdated', 'item/started', 'item/completed', 'serverRequest/resolved', 'error'].includes(method)) return;
    const params = object(value);
    if (method === 'serverRequest/resolved') {
      const approval = approvals.get(canonicalJson(params.requestId));
      if (approval && params.threadId === approval.turn.threadId) {
        approvals.delete(canonicalJson(approval.id));
        if (approval.waiter) approval.waiter.resolve();
        else options.append(approval.turn.scope, { ...empty(), expiredDecisions: [approval.pendingId] });
      }
      return;
    }
    const threadId = nonempty(params.threadId);
    const turn = active.get(threadId);
    if ((!turn || turn.run?.identity.runId !== params.turnId) &&
      (method === 'item/completed' || method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/patchUpdated')) {
      const closed = closedTurns.get(threadId);
      if (closed && closed.runId === params.turnId) {
        try {
          if (method === 'item/fileChange/patchUpdated' || (method === 'item/completed' && object(params.item).type === 'fileChange')) {
            closed.files.observe(method, params); closed.files.flush();
          } else { closed.commands.observe(method, params); closed.commands.flush(); }
        }
        catch { process.emitWarning('Could not retain late Codex activity', { code: 'AGENTUI_CODEX_LATE_OUTPUT' }); }
      }
      return;
    }
    if (!turn) return;
    if (method === 'turn/started') {
      const turnId = nonempty(object(params.turn).id);
      if (turn.complete || turn.previousRunId === turnId || (turn.run && turn.run.identity.runId !== turnId)) return;
      run(turn, turnId);
    } else if (method === 'item/fileChange/patchUpdated') {
      if (turn.run?.identity.runId !== params.turnId) return;
      turn.files?.observe(method, params);
      schedule(turn);
    } else if (method === 'item/commandExecution/outputDelta') {
      if (turn.run?.identity.runId !== params.turnId) return;
      turn.commands?.observe(method, params);
      schedule(turn);
    } else if (method === 'item/agentMessage/delta') {
      if (turn.run?.identity.runId !== params.turnId) return;
      const id = nonempty(params.itemId);
      if (typeof params.delta !== 'string') throw new Error('Invalid Codex text delta');
      message(turn, id, (turn.messages.get(id) ?? '') + params.delta);
    } else if (method === 'item/started' || method === 'item/completed') {
      if (turn.run?.identity.runId !== params.turnId) return;
      const item = object(params.item);
      if (item.type === 'commandExecution') {
        turn.commands?.observe(method, params);
        if (item.status === 'inProgress') schedule(turn);
        else turn.commands?.flush();
      }
      if (item.type === 'fileChange') {
        turn.files?.observe(method, params);
        if (item.status === 'inProgress') schedule(turn);
        else turn.files?.flush();
      }
      const remembered = approvalItem(item);
      if (remembered) rememberApprovalItem(turn.approvalDetails, remembered);
      if (method === 'item/completed' && item.type === 'agentMessage') {
        if (typeof item.text !== 'string') throw new Error('Invalid Codex message');
        message(turn, nonempty(item.id), item.text);
      }
      if (method === 'item/completed') renderMessage(turn);
    } else if (method === 'turn/completed') {
      const completed = object(params.turn);
      if (turn.run?.identity.runId !== completed.id) return;
      if (completed.status === 'failed') status(turn, 'Codex could not finish this response. You can send another message.');
      if (completed.status === 'interrupted') status(turn, 'Codex stopped this response.');
      expireApprovals(turn);
      turn.complete = true;
      renderMessage(turn);
      endRun(turn, completed.status === 'interrupted' ? 'interrupted' : completed.status === 'failed' ? 'failed' : 'completed');
      if (turn.commands && turn.files && turn.run) closedTurns.set(turn.threadId, { runId: turn.run.identity.runId, commands: turn.commands, files: turn.files });
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
    renderMessage(turn);
    const pendingId = randomUUID();
    const approval: Approval = { id, pendingId, turn, run: turn.run, waiter: null };
    approvals.set(canonicalJson(id), approval);
    const details = typeof params.itemId === 'string' ? turn.approvalDetails.get(params.itemId) : undefined;
    const kind = method === 'item/commandExecution/requestApproval' ? 'command' : 'file';
    publish(turn, [], [{ visible: { pendingId, runId: turn.run.identity.runId,
      choices: ['accept', 'decline'], prompt: approvalPrompt(kind, params, details, cwd) },
      continuation: { processId: rpc.processId, requestId: id, threadId: turn.threadId, turnId: turn.run.identity.runId },
    }]);
  }
  function acknowledged(command: ClientCommand, target: CapturedTarget, output: HostOutput<CodexTranscriptEvent>, nativeId: string): Extract<Observation, { readonly kind: 'conclusive' }> {
    const result: Extract<Observation, { readonly kind: 'conclusive' }> = { kind: 'conclusive', evidence: {
      identity: target.identity, source: 'native-acknowledgement',
      nativeOperation: { namespace: 'codex-app-server', id: nativeId },
      observation: { namespace: 'codex-app-server', schemaVersion: 2,
        data: { processId: rpc.processId, command: command.body.kind, nativeId } },
    }, result: { kind: 'completed', output } };
    return result;
  }
  async function send(command: ClientCommand & { readonly body: { readonly kind: 'send'; readonly text: string; readonly imageId?: ImageId } }, target: CapturedTarget, model?: string): ReturnType<ProviderDriver<CodexTranscriptEvent>['dispatch']> {
    const modelSelection = model === undefined ? {} : { model };
    const key = scopeKey(command.scope);
    let image: { readonly attachment: ImageAttachment; readonly item: { readonly type: 'image'; readonly url: string } } | undefined;
    if (command.body.imageId !== undefined) {
      if (!options.readImage) return { kind: 'not-dispatched', reason: 'This model cannot read images.' };
      try {
        const { attachment, bytes } = options.readImage(command.scope, command.body.imageId);
        image = { attachment, item: { type: 'image', url: `data:${attachment.mediaType};base64,${Buffer.from(bytes).toString('base64')}` } };
      } catch { return { kind: 'not-dispatched', reason: 'This image could not be read. Attach it again.' }; }
    }
    const input = [...(command.body.text ? [{ type: 'text', text: command.body.text, text_elements: [] }] : []), ...(image ? [image.item] : [])];
    busy.add(key);
    let turn: ActiveTurn | null = null;
    let method = 'initialize';
    try {
      await initialize();
      let threadId: string;
      if (target.run) {
        threadId = target.run.reference.opaque;
        if (!loaded.has(threadId)) {
          method = 'thread/resume';
          await rpc.request('thread/resume', { threadId, cwd, ...modelSelection, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', excludeTurns: true });
          loaded.add(threadId);
        }
      } else {
        method = 'thread/start';
        const response = object(await rpc.request('thread/start', { cwd, ...modelSelection, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only', ephemeral: false }));
        threadId = nonempty(object(response.thread).id);
        loaded.add(threadId);
      }
      turn = { installation: target.installation, scope: command.scope, threadId, previousRunId: target.run?.identity.runId ?? null, messages: new Map(), approvalDetails: new Map(), rendered: [], timer: undefined, run: null, commands: null, files: null, revision: 0, complete: false, stopCommandId: null };
      active.set(threadId, turn);
      publish(turn, [{ kind: 'message-updated', messageId: `${target.identity.hostOperationId}:user`,
        revision: 1, role: 'user', text: command.body.text, complete: true, ...(image ? { image: image.attachment } : {}) }]);
      method = 'turn/start';
      const result = object(await rpc.request('turn/start', { threadId, ...modelSelection, input, clientUserMessageId: command.clientCommandId }));
      const nativeRun = run(turn, nonempty(object(result.turn).id));
      return acknowledged(command, target, { events: [], runs: [nativeRun], decisions: [] }, nativeRun.identity.runId);
    } catch (error) {
      const rejection = error instanceof CodexRpcError
        ? { reason: `Codex rejected this request: ${bounded(error.message, 1_000)}`, code: error.code } : null;
      try {
        if (!turn?.run) {
          if (!closing) {
            options.append(command.scope, { ...empty(), events: [{ kind: 'message-updated',
              messageId: `${target.identity.hostOperationId}:${rejection ? 'assistant-rejection' : 'assistant-unconfirmed'}`,
              revision: 1, role: 'assistant', complete: true,
              text: rejection?.reason ?? 'Codex did not confirm whether this response started. Check command recovery and any unconfirmed actions before trying again.' }] });
          }
        } else {
          interrupted(turn, rejection?.reason ?? 'Codex could not start this response. Check command recovery before trying again.');
        }
      } catch {
        if (turn) outputFailed(turn);
        else process.emitWarning('Could not store Codex output', { code: 'AGENTUI_CODEX_STORAGE' });
      }
      if (turn) active.delete(turn.threadId);
      busy.delete(key);
      if (!rejection) throw error;
      return { kind: 'conclusive', evidence: {
        identity: target.identity, source: 'native-acknowledgement', nativeOperation: null,
        observation: { namespace: 'codex-app-server', schemaVersion: 2,
          data: { processId: rpc.processId, command: command.body.kind, method, phase: 'native-request-rejected', code: rejection.code } },
      }, result: { kind: 'rejected', reason: rejection.reason } };
    }
  }
  async function dispatch(command: ClientCommand, target: CapturedTarget, expected: Installation, model?: string): ReturnType<ProviderDriver<CodexTranscriptEvent>['dispatch']> {
    if (canonicalJson(target.installation) !== canonicalJson(expected)) throw new Error('Wrong Codex installation');
    if (command.version !== 1) return { kind: 'not-dispatched', reason: 'frontend-offers-unsupported' };
    switch (command.body.kind) {
      case 'revoke-permission': return { kind: 'not-dispatched', reason: 'permission-management-unsupported' };
      case 'send': return send({ ...command, body: command.body }, target, model);
      case 'approve': {
        if (!target.decision || !target.run) throw new Error('Approval target is missing');
        const continuation = object(target.decision.continuation);
        const approval = approvals.get(canonicalJson(continuation.requestId));
        if (continuation.processId !== rpc.processId || !approval || approval.pendingId !== target.decision.visible.pendingId ||
          approval.run.identity.runId !== target.run.identity.runId || scopeKey(approval.turn.scope) !== scopeKey(command.scope)) {
          return { kind: 'not-dispatched', reason: 'Codex approval expired with its connection' };
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const resolved = new Promise<void>((resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Codex did not confirm this approval')), 15_000);
          timeout.unref();
          approval.waiter = { resolve, reject };
        });
        try { await Promise.all([rpc.respond(approval.id, { decision: command.body.choiceId }), resolved]); }
        finally { clearTimeout(timeout); approval.waiter = null; }
        approvals.delete(canonicalJson(approval.id));
        return acknowledged(command, target, empty(), `${approval.turn.threadId}:${canonicalJson(approval.id)}`);
      }
      case 'cancel': {
        if (!target.run) throw new Error('Cancel target is missing');
        const threadId = target.run.reference.opaque;
        const turn = active.get(threadId);
        if (!turn || turn.complete || turn.run?.identity.runId !== command.body.runId ||
          target.run.identity.runId !== command.body.runId || scopeKey(turn.scope) !== scopeKey(command.scope)) {
          return { kind: 'not-dispatched', reason: 'Codex turn is no longer active' };
        }
        if (turn.stopCommandId) return { kind: 'not-dispatched', reason: 'Codex is already stopping this response.' };
        turn.stopCommandId = command.clientCommandId;
        try {
          publish(turn, [{ kind: 'run-stop-requested', runId: command.body.runId, clientCommandId: command.clientCommandId }]);
        } catch (error) { turn.stopCommandId = null; throw error; }
        try {
          await rpc.request('turn/interrupt', { threadId, turnId: command.body.runId });
        } catch (error) {
          if (!(error instanceof CodexRpcError)) throw error;
          if (!turn.complete) {
            publish(turn, [{ kind: 'run-stop-rejected', runId: command.body.runId, clientCommandId: command.clientCommandId }]);
            turn.stopCommandId = null;
          }
          return { ...acknowledged(command, target, empty(), command.body.runId),
            result: { kind: 'rejected', reason: `Codex could not stop this response: ${bounded(error.message, 1_000)}` } };
        }
        return acknowledged(command, target, empty(), command.body.runId);
      }
    }
  }
  let modelDrivers: Promise<readonly CodexModelDriver[]> | undefined;
  const driver: CodexDriver = {
    source: 'codex', installation,
    models() {
      modelDrivers ??= initialize().then(() => discoverCodexModels(params => rpc.request('model/list', params))).then(models => models.map(({ model, isDefault, selectable }) => {
        const selected = codexInstallation(cwd, options.version, model.id);
        return { model, isDefault, selectable, driver: { source: driver.source, installation: selected, capability: driver.capability,
          ...(model.inputModalities?.includes('image') && options.readImage ? { imageInput: true as const } : {}),
          dispatch: (command, target) => dispatch(command, target, selected, model.id) } };
      }));
      return modelDrivers;
    },
    capability(command) {
      if (closing || disconnected) return { kind: 'unsupported', reason: 'Codex is disconnected. Restart the host to connect again.' };
      if (command.body.kind === 'cancel') {
        const runId = command.body.runId;
        const turn = [...active.values()].find(value => value.run?.identity.runId === runId && scopeKey(value.scope) === scopeKey(command.scope));
        if (!turn || turn.complete) return { kind: 'unsupported', reason: 'Codex turn is no longer active' };
        if (turn.stopCommandId) return { kind: 'unsupported', reason: 'Codex is already stopping this response.' };
      }
      if (command.body.kind === 'send' && busy.has(scopeKey(command.scope))) return { kind: 'unsupported', reason: 'Codex is still responding. Wait for it to finish.' };
      return { kind: 'supported' };
    },
    dispatch: (command, target) => dispatch(command, target, installation),
    close() {
      if (closing) return;
      try {
        for (const turn of active.values()) {
          try { interrupted(turn, 'Codex stopped when the host closed. You can send another message after reconnecting.'); }
          catch { outputFailed(turn); }
        }
        active.clear(); closedTurns.clear(); busy.clear();
      }
      finally { closing = true; rpc.close(); }
    },
  };
  return driver;
}
