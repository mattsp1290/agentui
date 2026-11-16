import type { DatabaseSync } from 'node:sqlite';
import { identifier } from '@agentui/contracts/decode';
import type { ClientCommand, OfferedCommand, ConversationScope, FrontendBinding, FrontendBindingRequest } from '@agentui/contracts';
import type { StoredCommand } from './durable-model.js';
import type { FrontendToolProducer } from './frontend-tools/index.js';
import type { ProviderConversationOperations } from './providers.js';
import type { AguiRunKey } from './provider-commands.js';

export interface FrontendSendActor {
  readonly id: string;
  readonly platform: 'desktop';
  authorized(): boolean;
}
export class FrontendAccessError extends Error {}
type Identity = { readonly scope: ConversationScope; readonly id: string };
type Owned = Identity & { readonly actor: FrontendSendActor };
export class FrontendSends {
  constructor(private readonly db: DatabaseSync) {}
  assertActor(actor: FrontendSendActor | undefined): FrontendSendActor {
    if (!actor || actor.platform !== 'desktop' || !actor.authorized()) throw new FrontendAccessError('frontend-owner-unavailable');
    identifier(actor.id);
    return actor;
  }
  private rows({ scope, id }: Identity) {
    return this.db.prepare('SELECT actor_id, platform, state, thread_id, run_id FROM frontend_sends WHERE host=? AND conversation=? AND command_id=?')
      .all(scope.hostId, scope.conversationId, id);
  }
  assertAdmitted(command: OfferedCommand, run: AguiRunKey | null): void {
    const rows = this.rows({ scope: command.scope, id: command.clientCommandId }).filter(row => row.state !== 'tombstone');
    const owner = rows[0];
    if (!owner) throw new FrontendAccessError('frontend-owner-missing');
    if (rows.length !== 1 || owner.platform !== 'desktop' || (owner.state !== 'available' && owner.state !== 'unavailable')) throw new FrontendAccessError('frontend-owner-corrupt');
    identifier(owner.actor_id);
    if (!run || owner.thread_id !== run.threadId || owner.run_id !== run.runId) throw new FrontendAccessError('frontend-owner-corrupt');
  }
  check(input: Identity & { readonly actor: FrontendSendActor | undefined; readonly stored?: StoredCommand }): 'absent' | 'available' | 'unavailable' {
    const actor = this.assertActor(input.actor), rows = this.rows(input);
    for (const row of rows) {
      identifier(row.actor_id);
      if (row.platform !== 'desktop' || !['available', 'unavailable', 'tombstone'].includes(String(row.state)) ||
        (row.thread_id === null) !== (row.run_id === null) || (row.state !== 'tombstone' && row.thread_id === null)) throw new FrontendAccessError('frontend-owner-corrupt');
      if (row.thread_id !== null) { identifier(row.thread_id); identifier(row.run_id); }
    }
    if (rows.filter(row => row.state !== 'tombstone').length > 1) throw new FrontendAccessError('frontend-owner-corrupt');
    const admitted = rows.find(row => row.state !== 'tombstone');
    if (admitted && (admitted.actor_id !== actor.id || admitted.platform !== actor.platform)) throw new FrontendAccessError('frontend-owner-mismatch');
    if (input.stored) {
      if (input.stored.command.version !== 2 || !('kind' in input.stored)) throw new FrontendAccessError('frontend-owner-missing');
      this.assertAdmitted(input.stored.command, input.stored.agui);
    }
    const row = admitted ?? rows.find(row => row.actor_id === actor.id);
    if (!row) return 'absent';
    if (row.platform !== actor.platform || !['available', 'unavailable', 'tombstone'].includes(String(row.state))) throw new FrontendAccessError('frontend-owner-corrupt');
    return row.state === 'available' ? 'available' : 'unavailable';
  }
  admission(command: ClientCommand, existing: StoredCommand | null, actor?: FrontendSendActor): void {
    if (existing) {
      if (existing.command.version === 2) this.check({ scope: command.scope, id: command.clientCommandId, actor, stored: existing });
      return;
    }
    if (command.version !== 2) return;
    if (this.check({ scope: command.scope, id: command.clientCommandId, actor }) === 'unavailable') throw new FrontendAccessError('frontend-closures-unavailable');
  }
  admit(command: OfferedCommand, run: AguiRunKey, actor: FrontendSendActor | undefined): void {
    const owner = this.assertActor(actor);
    if (this.db.prepare('SELECT 1 FROM frontend_sends WHERE host=? AND conversation=? AND thread_id=? AND run_id=?')
      .get(command.scope.hostId, command.scope.conversationId, run.threadId, run.runId)) throw new FrontendAccessError('frontend-run-reused');
    this.db.prepare("INSERT INTO frontend_sends(host,conversation,command_id,actor_id,platform,state,thread_id,run_id) VALUES (?,?,?,?,?,'available',?,?)")
      .run(command.scope.hostId, command.scope.conversationId, command.clientCommandId, owner.id, owner.platform, run.threadId, run.runId);
  }
  unavailable(input: Owned & { readonly stored?: StoredCommand }): void {
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
  readonly command: () => StoredCommand | null;
  readonly transaction: (work: () => void) => void;
  readonly reconcile: () => Promise<unknown>;
  readonly producer: () => Pick<FrontendToolProducer, 'register' | 'cancel'>;
  readonly providers: ProviderConversationOperations | undefined;
}): Promise<FrontendBinding> {
  const { request, actor, owners } = input;
  const identity = { scope: request.scope, id: identifier(request.id), actor };
  const initial = input.command();
  const check = (stored: StoredCommand | null) => owners.check({ ...identity, ...(stored ? { stored } : {}) });
  check(initial);
  if (request.action === 'unavailable') {
    input.transaction(() => {
      const stored = input.command();
      owners.unavailable({ ...identity, ...(stored ? { stored } : {}) });
    });
  } else if (initial && initial.observation?.kind !== 'conclusive' && initial.observation?.kind !== 'not-dispatched') {
    await input.reconcile();
  }
  const stored = input.command(), state = check(stored);
  if (stored?.command.version === 2) {
    if (!('kind' in stored) || !stored.agui) throw new Error('Invalid offered command target');
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
    check(stored);
    if (run) {
      const bound = { kind: 'bound', command: stored.command, hostOperationId: stored.receipt.hostOperationId,
        run: run.identity, threadId: stored.agui.threadId } satisfies FrontendBinding;
      const producer = input.producer();
      producer.register({ identity: bound.run, threadId: bound.threadId, platform: bound.command.body.frontend.platform,
        bindings: bound.command.body.frontend.tools.map(tool => ({ ...tool, name: tool.definition.name })) });
      if (check(stored) === 'unavailable') producer.cancel({ threadId: bound.threadId, runId: bound.run.runId });
      else return bound;
    }
  }
  if (check(stored) === 'unavailable') return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  return { kind: 'pending', id: request.id };
}
