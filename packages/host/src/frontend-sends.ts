import type { DatabaseSync } from 'node:sqlite';
import { identifier } from '@agentui/contracts/decode';
import type { ClientCommand, ConversationScope } from '@agentui/contracts';
import { isOffered } from './durable-model.js';
import type { StoredCommand, OfferedStoredCommand } from './durable-model.js';
import type { AguiRunKey, MatchedProviderCommand } from './provider-commands.js';

export interface FrontendSendActor {
  readonly id: string;
  readonly platform: 'desktop';
  authorized(): boolean;
}
export class FrontendAccessError extends Error {}
export function assertFrontendSendActor(actor: FrontendSendActor | undefined): FrontendSendActor {
  if (!actor || actor.platform !== 'desktop' || !actor.authorized()) throw new FrontendAccessError('frontend-owner-unavailable');
  identifier(actor.id);
  return actor;
}
type Identity = { readonly scope: ConversationScope; readonly id: string };
type AdmittedOwner = { readonly actorId: string; readonly state: 'available' | 'unavailable'; readonly run: AguiRunKey };
type OwnerState = 'absent' | 'available' | 'unavailable';
export class FrontendSends {
  constructor(private readonly db: DatabaseSync) {}
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
    const actor = assertFrontendSendActor(value);
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
    assertFrontendSendActor(actor);
    this.admittedOwner(stored);
  }
  authorize(intent: 'dispatch' | 'settle' | 'evidence', stored: StoredCommand, actor?: FrontendSendActor): void {
    if (isOffered(stored)) {
      if (intent === 'dispatch') this.assertMayDispatch(stored, actor);
      else if (intent === 'settle') this.assertMaySettle(stored, actor);
      else this.ownerState(stored, actor);
    } else if (actor) {
      if (intent === 'dispatch') assertFrontendSendActor(actor);
      else if (intent === 'settle' && !actor.authorized()) throw new Error('Unauthorized actor');
    }
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
    const owner = assertFrontendSendActor(actor);
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
