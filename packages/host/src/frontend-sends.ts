import type { DatabaseSync } from 'node:sqlite';
import { identifier } from '@agentui/contracts/decode';
import type { ClientCommand, ConversationScope, FrontendBinding, FrontendBindingRequest } from '@agentui/contracts';
import { isOffered } from './durable-model.js';
import type { StoredCommand, OfferedStoredCommand } from './durable-model.js';
import type { FrontendToolProducer } from './frontend-tools/index.js';
import type { ProviderConversationOperations } from './providers.js';
import type { AguiRunKey, MatchedProviderCommand } from './provider-commands.js';

export interface FrontendSendActor {
  readonly id: string;
  readonly platform: 'desktop';
  authorized(): boolean;
}
export class FrontendAccessError extends Error {}
type Identity = { readonly scope: ConversationScope; readonly id: string };
type AdmittedOwner = { readonly actorId: string; readonly state: 'available' | 'unavailable'; readonly run: AguiRunKey };
type OwnerState = 'absent' | 'available' | 'unavailable';
export class FrontendSends {
  constructor(private readonly db: DatabaseSync) {}
  assertActor(actor: FrontendSendActor | undefined): FrontendSendActor {
    if (!actor || actor.platform !== 'desktop' || !actor.authorized()) throw new FrontendAccessError('frontend-owner-unavailable');
    identifier(actor.id);
    return actor;
  }
  private owner({ scope, id }: Identity): AdmittedOwner | null {
    const row = this.db.prepare('SELECT actor_id,state,thread_id,run_id FROM frontend_send_owners WHERE host=? AND conversation=? AND command_id=?')
      .get(scope.hostId, scope.conversationId, id);
    if (!row) return null;
    if (row.state !== 'available' && row.state !== 'unavailable') throw new FrontendAccessError('frontend-owner-corrupt');
    return { actorId: identifier(row.actor_id), state: row.state,
      run: { threadId: identifier(row.thread_id), runId: identifier(row.run_id) } };
  }
  private admittedOwner(stored: OfferedStoredCommand): AdmittedOwner {
    const owner = this.owner({ scope: stored.command.scope, id: stored.command.clientCommandId });
    if (!owner) throw new FrontendAccessError('frontend-owner-missing');
    if (owner.run.threadId !== stored.agui.threadId || owner.run.runId !== stored.agui.runId) throw new FrontendAccessError('frontend-owner-corrupt');
    return owner;
  }
  ownerState(target: Identity | OfferedStoredCommand, value: FrontendSendActor | undefined): OwnerState {
    const actor = this.assertActor(value);
    const owner = 'command' in target ? this.admittedOwner(target) : this.owner(target);
    if (owner) {
      if (owner.actorId !== actor.id) throw new FrontendAccessError('frontend-owner-mismatch');
      return owner.state;
    }
    const identity = 'command' in target ? { scope: target.command.scope, id: target.command.clientCommandId } : target;
    return this.db.prepare('SELECT 1 FROM frontend_send_tombstones WHERE host=? AND conversation=? AND command_id=? AND actor_id=?')
      .get(identity.scope.hostId, identity.scope.conversationId, identity.id, actor.id) ? 'unavailable' : 'absent';
  }
  assertMayDispatch(stored: OfferedStoredCommand, actor: FrontendSendActor | undefined): void {
    if (this.ownerState(stored, actor) !== 'available') throw new FrontendAccessError('Frontend owner unavailable');
  }
  assertMaySettle(stored: OfferedStoredCommand, actor: FrontendSendActor | undefined): void {
    this.assertActor(actor);
    this.admittedOwner(stored);
  }

  admission(command: ClientCommand, existing: StoredCommand | null, actor?: FrontendSendActor): void {
    if (existing) {
      if (isOffered(existing)) this.ownerState(existing, actor);
      return;
    }
    if (command.version !== 2) return;
    if (this.ownerState({ scope: command.scope, id: command.clientCommandId }, actor) === 'unavailable') throw new FrontendAccessError('frontend-closures-unavailable');
  }
  admitCapture(capture: MatchedProviderCommand, actor?: FrontendSendActor): void {
    const { command, agui: run } = capture;
    if (run === null) return;
    const { scope } = command;
    if (command.version !== 2) return;
    const owner = this.assertActor(actor);
    this.db.prepare("INSERT INTO frontend_send_owners(host,conversation,command_id,actor_id,state,thread_id,run_id) VALUES (?,?,?,?,'available',?,?)")
      .run(scope.hostId, scope.conversationId, command.clientCommandId, owner.id, run.threadId, run.runId);
  }
  markUnavailable(stored: OfferedStoredCommand, actor: FrontendSendActor): void {
    this.ownerState(stored, actor);
    this.db.prepare("UPDATE frontend_send_owners SET state='unavailable' WHERE host=? AND conversation=? AND command_id=? AND actor_id=?")
      .run(stored.command.scope.hostId, stored.command.scope.conversationId, stored.command.clientCommandId, actor.id);
  }
  tombstone(identity: Identity, actor: FrontendSendActor): void {
    this.ownerState(identity, actor);
    this.db.prepare(`INSERT INTO frontend_send_tombstones(host,conversation,command_id,actor_id) VALUES (?,?,?,?)
      ON CONFLICT(host,conversation,command_id,actor_id) DO NOTHING`)
      .run(identity.scope.hostId, identity.scope.conversationId, identity.id, actor.id);
  }
}
export async function recoverFrontendBinding(input: {
  readonly request: FrontendBindingRequest;
  readonly actor: FrontendSendActor;
  readonly owners: FrontendSends;
  readonly command: () => OfferedStoredCommand | null;
  readonly transaction: (work: () => void) => void;
  readonly reconcile: () => Promise<unknown>;
  readonly producer: () => Pick<FrontendToolProducer, 'register' | 'cancel'>;
  readonly providers: ProviderConversationOperations | undefined;
}): Promise<FrontendBinding> {
  const { request, actor, owners } = input;
  const identity = { scope: request.scope, id: identifier(request.id) };
  const initial = input.command();
  const ownerFence = (stored: OfferedStoredCommand | null) => owners.ownerState(stored ?? identity, actor);
  ownerFence(initial);
  if (request.action === 'unavailable') {
    input.transaction(() => {
      const stored = input.command();
      if (stored) owners.markUnavailable(stored, actor);
      else owners.tombstone(identity, actor);
    });
  } else if (initial && initial.observation?.kind !== 'conclusive' && initial.observation?.kind !== 'not-dispatched') {
    await input.reconcile();
  }
  const stored = input.command(), state = ownerFence(stored);
  if (stored) {
    const observation = stored.observation;
    const run = observation && 'evidence' in observation ? observation.evidence.source.run : null;
    if (!run && state !== 'unavailable') {
      if (observation?.kind === 'not-dispatched') return { kind: 'unavailable', id: request.id, reason: 'not-dispatched' };
      if (observation?.kind === 'conclusive' && observation.result.kind === 'rejected') return { kind: 'unavailable', id: request.id, reason: 'provider-rejected' };
    }
    if (state !== 'unavailable') {
      if (!input.providers) throw new Error('Original AG-UI provider unavailable');
      input.providers.assertFrontendInput(stored.target);
    }
    ownerFence(stored);
    if (run) {
      const bound = { kind: 'bound', command: stored.command, hostOperationId: stored.receipt.hostOperationId,
        run: run.identity, threadId: stored.agui.threadId } satisfies FrontendBinding;
      const producer = input.producer();
      producer.register({ identity: bound.run, threadId: bound.threadId, platform: bound.command.body.frontend.platform,
        bindings: bound.command.body.frontend.tools.map(tool => ({ ...tool, name: tool.definition.name })) });
      if (ownerFence(stored) === 'unavailable') producer.cancel({ threadId: bound.threadId, runId: bound.run.runId });
      else return bound;
    }
  }
  if (ownerFence(stored) === 'unavailable') return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  return { kind: 'pending', id: request.id };
}
