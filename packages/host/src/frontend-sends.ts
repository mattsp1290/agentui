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
type Owned = Identity & { readonly actor: FrontendSendActor };
type AdmittedOwner = { readonly actorId: string; readonly state: 'available' | 'unavailable'; readonly run: AguiRunKey };
type OwnerRows = { readonly admitted: AdmittedOwner | null; readonly tombstoneActors: ReadonlySet<string> };
type OwnerState = 'absent' | 'available' | 'unavailable';
type OwnerStateRequest = {
  readonly intent: 'owner-state';
  readonly target: Identity | OfferedStoredCommand;
  readonly actor: FrontendSendActor | undefined;
};
type CommandAuthorityRequest = {
  readonly intent: 'dispatch' | 'private-settler';
  readonly stored: StoredCommand;
  readonly actor: FrontendSendActor | undefined;
};
type AuthorityRequest = OwnerStateRequest | CommandAuthorityRequest;
export class FrontendSends {
  constructor(private readonly db: DatabaseSync) {}
  assertActor(actor: FrontendSendActor | undefined): FrontendSendActor {
    if (!actor || actor.platform !== 'desktop' || !actor.authorized()) throw new FrontendAccessError('frontend-owner-unavailable');
    identifier(actor.id);
    return actor;
  }
  private ownerRows({ scope, id }: Identity): OwnerRows {
    const rows = this.db.prepare('SELECT actor_id, platform, state, thread_id, run_id FROM frontend_sends WHERE host=? AND conversation=? AND command_id=?')
      .all(scope.hostId, scope.conversationId, id);
    let admitted: AdmittedOwner | null = null;
    const tombstoneActors = new Set<string>();
    for (const row of rows) {
      const actorId = identifier(row.actor_id);
      if (row.platform !== 'desktop' || (row.thread_id === null) !== (row.run_id === null)) throw new FrontendAccessError('frontend-owner-corrupt');
      const run = row.thread_id === null ? null : { threadId: identifier(row.thread_id), runId: identifier(row.run_id) };
      if (row.state === 'tombstone') { tombstoneActors.add(actorId); continue; }
      if ((row.state !== 'available' && row.state !== 'unavailable') || run === null || admitted) throw new FrontendAccessError('frontend-owner-corrupt');
      admitted = { actorId, state: row.state, run };
    }
    return { admitted, tombstoneActors };
  }
  private admittedOwner(rows: OwnerRows, stored: OfferedStoredCommand): AdmittedOwner {
    const owner = rows.admitted;
    if (!owner) throw new FrontendAccessError('frontend-owner-missing');
    if (owner.run.threadId !== stored.agui.threadId || owner.run.runId !== stored.agui.runId) throw new FrontendAccessError('frontend-owner-corrupt');
    return owner;
  }
  assertAuthority(input: OwnerStateRequest): OwnerState;
  assertAuthority(input: CommandAuthorityRequest): void;
  assertAuthority(input: AuthorityRequest): OwnerState | void {
    let target: Identity | OfferedStoredCommand;
    if (input.intent === 'owner-state') {
      target = input.target;
    } else {
      if (!isOffered(input.stored)) {
        if (input.intent === 'dispatch' && input.actor) this.assertActor(input.actor);
        else if (input.intent === 'private-settler' && input.actor && !input.actor.authorized()) throw new Error('Unauthorized actor');
        return;
      }
      target = input.stored;
    }
    const identity = 'command' in target
      ? { scope: target.command.scope, id: target.command.clientCommandId }
      : target;
    const actor = this.assertActor(input.actor);
    const rows = this.ownerRows(identity);
    const owner = 'command' in target ? this.admittedOwner(rows, target) : rows.admitted;
    if (input.intent === 'private-settler') return;
    if (owner && owner.actorId !== actor.id) throw new FrontendAccessError('frontend-owner-mismatch');
    const state = owner?.state ?? (rows.tombstoneActors.has(actor.id) ? 'unavailable' : 'absent');
    if (input.intent === 'dispatch' && state !== 'available') throw new Error('Frontend owner unavailable');
    if (input.intent === 'owner-state') return state;
  }

  admission(command: ClientCommand, existing: StoredCommand | null, actor?: FrontendSendActor): void {
    if (existing) {
      if (isOffered(existing)) this.assertAuthority({ intent: 'owner-state', target: existing, actor });
      return;
    }
    if (command.version !== 2) return;
    if (this.assertAuthority({ intent: 'owner-state', target: { scope: command.scope, id: command.clientCommandId }, actor }) === 'unavailable') throw new FrontendAccessError('frontend-closures-unavailable');
  }
  admitCapture(capture: MatchedProviderCommand, actor?: FrontendSendActor): void {
    const { command, agui: run } = capture;
    if (run === null) return;
    const { scope } = command;
    if (command.version !== 2) return;
    const owner = this.assertActor(actor);
    this.db.prepare("INSERT INTO frontend_sends(host,conversation,command_id,actor_id,platform,state,thread_id,run_id) VALUES (?,?,?,?,?,'available',?,?)")
      .run(scope.hostId, scope.conversationId, command.clientCommandId, owner.id, owner.platform, run.threadId, run.runId);
  }
  unavailable(input: Owned & { readonly stored?: OfferedStoredCommand }): void {
    this.assertAuthority({ intent: 'owner-state', target: input.stored ?? input, actor: input.actor });
    if (input.stored) {
      this.db.prepare("UPDATE frontend_sends SET state='unavailable' WHERE host=? AND conversation=? AND command_id=? AND actor_id=? AND state<>'tombstone'")
        .run(input.scope.hostId, input.scope.conversationId, input.id, input.actor.id);
    } else {
      this.db.prepare(`INSERT INTO frontend_sends(host,conversation,command_id,actor_id,platform,state) VALUES (?,?,?,?,?,'tombstone')
        ON CONFLICT(host,conversation,command_id,actor_id) DO NOTHING`)
        .run(input.scope.hostId, input.scope.conversationId, input.id, input.actor.id, input.actor.platform);
    }
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
  const identity = { scope: request.scope, id: identifier(request.id), actor };
  const initial = input.command();
  const ownerFence = (stored: OfferedStoredCommand | null) => owners.assertAuthority({ intent: 'owner-state', target: stored ?? identity, actor });
  ownerFence(initial);
  if (request.action === 'unavailable') {
    input.transaction(() => {
      const stored = input.command();
      owners.unavailable({ ...identity, ...(stored ? { stored } : {}) });
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
