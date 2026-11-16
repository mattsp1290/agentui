import type { DatabaseSync } from 'node:sqlite';
import { identifier } from '@agentui/contracts/decode';
import type { ClientCommand, OfferedCommand, ConversationScope, FrontendBinding, FrontendBindingRequest } from '@agentui/contracts';
import type { StoredCommand } from './durable-model.js';
import type { FrontendToolProducer } from './frontend-tools/index.js';
import type { ProviderConversationOperations } from './providers.js';
import { matchOfferInput } from './agui-input.js';

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
    return this.db.prepare('SELECT actor_id, platform, state FROM frontend_sends WHERE host=? AND conversation=? AND command_id=?')
      .all(scope.hostId, scope.conversationId, id);
  }
  assertAdmitted(command: OfferedCommand): void {
    const rows = this.rows({ scope: command.scope, id: command.clientCommandId }).filter(row => row.state !== 'tombstone');
    const owner = rows[0];
    if (!owner) throw new FrontendAccessError('frontend-owner-missing');
    if (rows.length !== 1 || owner.platform !== 'desktop' || (owner.state !== 'available' && owner.state !== 'unavailable')) throw new FrontendAccessError('frontend-owner-corrupt');
    identifier(owner.actor_id);
  }
  check(input: Identity & { readonly actor: FrontendSendActor | undefined; readonly command?: ClientCommand }): 'absent' | 'available' | 'unavailable' {
    const actor = this.assertActor(input.actor), rows = this.rows(input);
    const admitted = rows.find(row => row.state !== 'tombstone');
    if (admitted && (admitted.actor_id !== actor.id || admitted.platform !== actor.platform)) throw new FrontendAccessError('frontend-owner-mismatch');
    if (input.command && (input.command.version !== 2 || !admitted)) throw new FrontendAccessError('frontend-owner-missing');
    const row = admitted ?? rows.find(row => row.actor_id === actor.id);
    if (!row) return 'absent';
    if (row.platform !== actor.platform || !['available', 'unavailable', 'tombstone'].includes(String(row.state))) throw new FrontendAccessError('frontend-owner-corrupt');
    return row.state === 'available' ? 'available' : 'unavailable';
  }
  admission(command: ClientCommand, existing: StoredCommand | null, actor?: FrontendSendActor): void {
    if (existing?.command.version === 2) this.check({ scope: command.scope, id: command.clientCommandId, actor, command: existing.command });
    if (command.version !== 2) return;
    if (this.check({ scope: command.scope, id: command.clientCommandId, actor }) === 'unavailable') throw new FrontendAccessError('frontend-closures-unavailable');
  }
  admit(command: ClientCommand, actor?: FrontendSendActor): void {
    if (command.version !== 2) return;
    const owner = this.assertActor(actor);
    this.db.prepare("INSERT INTO frontend_sends(host,conversation,command_id,actor_id,platform,state) VALUES (?,?,?,?,?,'available')")
      .run(command.scope.hostId, command.scope.conversationId, command.clientCommandId, owner.id, owner.platform);
  }
  unavailable(input: Owned & { readonly command?: ClientCommand }): void {
    this.check(input);
    this.db.prepare(`INSERT INTO frontend_sends(host,conversation,command_id,actor_id,platform,state) VALUES (?,?,?,?,?,?)
      ON CONFLICT(host,conversation,command_id,actor_id) DO UPDATE SET state=CASE WHEN state='tombstone' THEN state ELSE 'unavailable' END`)
      .run(input.scope.hostId, input.scope.conversationId, input.id, input.actor.id, input.actor.platform, input.command ? 'unavailable' : 'tombstone');
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
  let stored = input.command();
  const check = () => owners.check({ ...identity, ...(stored ? { command: stored.command } : {}) });
  let state = check();
  if (request.action === 'unavailable') {
    input.transaction(() => {
      stored = input.command();
      owners.unavailable({ ...identity, ...(stored ? { command: stored.command } : {}) });
    });
    state = 'unavailable';
  } else if (stored && stored.observation?.kind !== 'conclusive' && stored.observation?.kind !== 'not-dispatched') {
    await input.reconcile();
    stored = input.command();
    state = check();
  }
  let bound: Extract<FrontendBinding, { kind: 'bound' }> | undefined;
  if (stored?.command.version === 2 && 'kind' in stored && stored.target.operation.kind === 'send') {
    const actual = matchOfferInput(stored.target.operation.request, stored.command.body.frontend);
    const observation = stored.observation;
    const run = observation && 'evidence' in observation ? observation.evidence.source.run : null;
    if (run) {
      if (run.identity.runId !== actual.runId) throw new Error('Frontend run mismatch');
      bound = { kind: 'bound', command: stored.command, hostOperationId: stored.receipt.hostOperationId, run: run.identity, threadId: actual.threadId };
    }
    if (!run && state !== 'unavailable') {
      if (observation?.kind === 'not-dispatched') return { kind: 'unavailable', id: request.id, reason: 'not-dispatched' };
      if (observation?.kind === 'conclusive' && observation.result.kind === 'rejected') return { kind: 'unavailable', id: request.id, reason: 'provider-rejected' };
    }
    if (state !== 'unavailable') {
      if (!input.providers) throw new Error('Original AG-UI provider unavailable');
      input.providers.frontendInput(stored.target);
      state = check();
    }
  }
  if (bound) {
    check();
    const producer = input.producer();
    producer.register({ identity: bound.run, threadId: bound.threadId, platform: bound.command.body.frontend.platform,
      bindings: bound.command.body.frontend.tools.map(tool => ({ ...tool, name: tool.definition.name })) });
    state = check();
    if (state === 'unavailable') producer.cancel({ threadId: bound.threadId, runId: bound.run.runId });
    else return bound;
  }
  if (check() === 'unavailable') return { kind: 'unavailable', id: request.id, reason: 'closures-unavailable' };
  return { kind: 'pending', id: request.id };
}
