import type { DatabaseSync } from 'node:sqlite';
import { identifier } from '@agentui/contracts/decode';
import type { ClientCommand, ConversationScope, FrontendBinding, FrontendBindingRequest } from '@agentui/contracts';
import { isOffered } from './durable-model.js';
import type { StoredCommand, OfferedStoredCommand } from './durable-model.js';
import type { FrontendToolProducer } from './frontend-tools/index.js';
import type { ProviderConversationOperations } from './providers.js';
import { TAGGED_SEND_KEY_SQL } from './provider-commands.js';
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
  assertAdmitted(stored: OfferedStoredCommand): void {
    this.admittedOwner(this.ownerRows({ scope: stored.command.scope, id: stored.command.clientCommandId }), stored);
  }
  check(input: Identity & { readonly actor: FrontendSendActor | undefined; readonly stored?: OfferedStoredCommand }): 'absent' | 'available' | 'unavailable' {
    const actor = this.assertActor(input.actor), rows = this.ownerRows(input);
    const owner = input.stored ? this.admittedOwner(rows, input.stored) : rows.admitted;
    if (owner && owner.actorId !== actor.id) throw new FrontendAccessError('frontend-owner-mismatch');
    return owner?.state ?? (rows.tombstoneActors.has(actor.id) ? 'unavailable' : 'absent');
  }
  admission(command: ClientCommand, existing: StoredCommand | null, actor?: FrontendSendActor): void {
    if (existing) {
      if (isOffered(existing)) this.check({ scope: command.scope, id: command.clientCommandId, actor, stored: existing });
      return;
    }
    if (command.version !== 2) return;
    if (this.check({ scope: command.scope, id: command.clientCommandId, actor }) === 'unavailable') throw new FrontendAccessError('frontend-closures-unavailable');
  }
  admitCapture(capture: MatchedProviderCommand, actor?: FrontendSendActor): void {
    const { command, agui: run } = capture;
    if (run === null) return;
    const { scope } = command;
    if (this.db.prepare('SELECT 1 FROM frontend_sends WHERE host=? AND conversation=? AND thread_id=? AND run_id=?')
      .get(scope.hostId, scope.conversationId, run.threadId, run.runId)) throw new FrontendAccessError('frontend-run-reused');
    if (command.version !== 2) return;
    if (this.db.prepare(`SELECT 1 FROM commands WHERE host=? AND conversation=? AND ${TAGGED_SEND_KEY_SQL} LIMIT 1`)
      .get(scope.hostId, scope.conversationId, run.threadId, run.runId)) throw new FrontendAccessError('frontend-run-reused');
    const owner = this.assertActor(actor);
    this.db.prepare("INSERT INTO frontend_sends(host,conversation,command_id,actor_id,platform,state,thread_id,run_id) VALUES (?,?,?,?,?,'available',?,?)")
      .run(scope.hostId, scope.conversationId, command.clientCommandId, owner.id, owner.platform, run.threadId, run.runId);
  }
  unavailable(input: Owned & { readonly stored?: OfferedStoredCommand }): void {
    this.check(input);
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
  const ownerFence = (stored: OfferedStoredCommand | null) => owners.check({ ...identity, ...(stored ? { stored } : {}) });
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
