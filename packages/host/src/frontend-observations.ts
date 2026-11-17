import { canonicalJson } from '@agentui/contracts';
import type { ConversationScope } from '@agentui/contracts';
import type { AguiOriginalRun } from '@agentui/sdk';
import { isOffered, scopeKey } from './durable-model.js';
import type { OfferedStoredCommand } from './durable-model.js';
import { nonempty } from './codec.js';
import { providerRun } from './provider-commands.js';
import type { ProviderCreation } from './provider-creation.js';
import type { ProviderObservations, RunObservation } from './provider-observations.js';
import type { SqliteStore } from './sqlite-store.js';
import { createFrontendCoordinator, prepareFrontendRegistration } from './frontend-tools/coordinator.js';

type Store = Pick<SqliteStore<unknown, unknown>, 'db' | 'command' | 'frontendSends' | 'frontendWriter' | 'creation'>;
type Transaction = Parameters<Store['frontendWriter']>[0];
export interface PreparedProviderObservations {
  readonly factory: typeof FrontendObservations;
  readonly selection: ReturnType<FrontendObservations['selection']>;
  readonly observations: ProviderObservations;
}
export class FrontendObservations {
  constructor(private readonly store: Store) {}
  private original(stored: OfferedStoredCommand): AguiOriginalRun<string> {
    const operation = stored.target.operation;
    return { operationId: operation.operationId, threadId: stored.agui.threadId,
      run: { binding: operation.binding, ref: { kind: 'run', instance: stored.target.installation.instance, opaqueId: stored.agui.runId } } };
  }
  private match(original: ProviderCreation, evidence: RunObservation) {
    const { db } = this.store, scope = original.intent.scope;
    const row = db.prepare('SELECT conversation,id FROM commands WHERE host=? AND operation=?').get(scope.hostId, evidence.operationId);
    if (!row || row.conversation !== scope.conversationId) throw new Error('Unknown observation original');
    const stored = this.store.command(scope, nonempty(row.id));
    if (!stored || !('kind' in stored) || stored.target.operation.kind !== 'send' || stored.agui === null ||
      stored.target.operation.observationProtocol !== 'ag-ui-v1') throw new Error('Original observation not captured');
    const target = stored.target;
    if (canonicalJson({ installation: target.installation, intent: target.operation.binding.creation, credential: target.credential }) !== canonicalJson(original) ||
      stored.agui.threadId !== evidence.threadId || stored.agui.runId !== evidence.run.identity.runId ||
      canonicalJson(providerRun(evidence.run.reference, target.operation.binding, target.installation)) !== canonicalJson(evidence.run)) throw new Error('Foreign observation original');
    const observation = stored.observation;
    const confirmed = observation && 'evidence' in observation ? observation.evidence.source.run : null;
    if (confirmed && canonicalJson(confirmed) !== canonicalJson(evidence.run)) throw new Error('Conflicting original confirmation');
    if (!isOffered(stored)) return null;
    this.store.frontendSends.observationState(stored);
    return stored;
  }
  selection(original: ProviderCreation) {
    const scope = original.intent.scope, { db } = this.store;
    const selected: OfferedStoredCommand[] = [];
    for (const row of db.prepare(`SELECT id FROM commands WHERE host=? AND conversation=?
      AND json_extract(target,'$.operation.observationProtocol')='ag-ui-v1' ORDER BY id`).all(...scopeKey(scope))) {
      const stored = this.store.command(scope, nonempty(row.id));
      if (!stored || !isOffered(stored)) continue;
      const evidence = this.original(stored);
      this.match(original, { ...evidence, run: providerRun(evidence.run, stored.target.operation.binding, stored.target.installation), kind: 'unavailable' });
      const status = db.prepare('SELECT json_extract(data,\'$.status\') AS status FROM frontend_runs WHERE host=? AND conversation=? AND thread=? AND run=?')
        .get(...scopeKey(scope), stored.agui.threadId, stored.agui.runId)?.status;
      const observation = stored.observation;
      if ((status && status !== 'collecting') || observation?.kind === 'not-dispatched' ||
        (observation?.kind === 'conclusive' && observation.result.kind === 'rejected' && !observation.evidence.source.run)) continue;
      selected.push(stored);
    }
    return { originals: selected.map(stored => this.original(stored)), fingerprint: canonicalJson(selected), selected };
  }
  commit(original: ProviderCreation, prepared: ProviderObservations, selection: ReturnType<FrontendObservations['selection']>, transaction: Transaction): void {
    if (this.selection(original).fingerprint !== selection.fingerprint) throw new Error('Observation originals changed');
    const touched = new Map<string, OfferedStoredCommand>();
    if (prepared.kind !== 'absent') for (const evidence of prepared.runs) {
      const stored = this.match(original, evidence);
      if (!stored) continue;
      const id = stored.command.clientCommandId;
      this.append(stored, evidence, prepared.kind === 'snapshot'); touched.set(id, stored);
    }
    if (prepared.kind !== 'event') for (const stored of selection.selected) {
      const id = stored.command.clientCommandId;
      if (!touched.has(id)) { this.fault(stored, 'history-unavailable'); touched.set(id, stored); }
    }
    for (const stored of touched.values()) this.materialize(stored.command.scope, stored.command.clientCommandId, transaction);
  }
  private fault(stored: OfferedStoredCommand, reason: 'history-unavailable' | 'event-conflict'): void {
    this.store.db.prepare(`INSERT INTO frontend_observation_runs(host,conversation,command_id,fault) VALUES(?,?,?,?)
      ON CONFLICT(host,conversation,command_id) DO UPDATE SET fault=coalesce(fault,excluded.fault)`)
      .run(...scopeKey(stored.command.scope), stored.command.clientCommandId, reason);
  }
  private append(stored: OfferedStoredCommand, evidence: RunObservation, snapshot: boolean): void {
    const { db } = this.store, parts = [...scopeKey(stored.command.scope), stored.command.clientCommandId];
    db.prepare('INSERT INTO frontend_observation_runs(host,conversation,command_id) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(...parts);
    if (evidence.kind === 'unavailable') { this.fault(stored, 'history-unavailable'); return; }
    const rows = db.prepare('SELECT position,data,bytes FROM frontend_observation_events WHERE host=? AND conversation=? AND command_id=? ORDER BY position').all(...parts);
    let bytes = rows.reduce((total, row) => total + Number(row.bytes), 0), length = rows.length;
    if (snapshot && evidence.frames.length < length) this.fault(stored, 'history-unavailable');
    for (const [index, frame] of evidence.frames.entries()) {
      const position = evidence.first + index, prior = rows[position - 1];
      if (prior?.position === position && prior.data === frame.encoded) continue;
      if (prior || position !== length + 1 || position > 4096 || frame.bytes > 64000 || bytes + frame.bytes > 1_000_000) {
        this.fault(stored, 'event-conflict'); return;
      }
      db.prepare('INSERT INTO frontend_observation_events(host,conversation,command_id,position,data,bytes) VALUES(?,?,?,?,?,?)')
        .run(...parts, position, frame.encoded, frame.bytes);
      length++; bytes += frame.bytes;
    }
  }
  materialize(scope: ConversationScope, id: string, transaction: Transaction): void {
    const { db } = this.store, parts = [...scopeKey(scope), id];
    const journal = db.prepare('SELECT fault FROM frontend_observation_runs WHERE host=? AND conversation=? AND command_id=?').get(...parts);
    if (!journal) return;
    const stored = this.store.command(scope, id);
    if (!stored || !isOffered(stored) || stored.target.operation.kind !== 'send' || stored.target.operation.observationProtocol !== 'ag-ui-v1') throw new Error('Missing observation command');
    const creation = this.store.creation(scope), target = stored.target;
    if (creation?.observation?.kind !== 'confirmed' || canonicalJson({ installation: creation.installation, intent: creation.intent, credential: creation.credential }) !==
      canonicalJson({ installation: target.installation, intent: target.operation.binding.creation, credential: target.credential }) || canonicalJson(creation.observation.binding) !== canonicalJson(target.operation.binding)) throw new Error('Original observation association changed');
    const owner = this.store.frontendSends.observationState(stored), observed = stored.observation;
    const run = observed && 'evidence' in observed ? observed.evidence.source.run : null;
    if (!run) return;
    const writer = this.store.frontendWriter(transaction, scope, createFrontendCoordinator), key = { threadId: stored.agui.threadId, runId: stored.agui.runId };
    writer.register(prepareFrontendRegistration(scope, { identity: run.identity, threadId: key.threadId,
      platform: stored.command.body.frontend.platform, bindings: stored.command.body.frontend.tools.map(tool => ({ ...tool, name: tool.definition.name })) }));
    if (owner === 'unavailable') return;
    if (journal.fault !== null) { writer.block(key); return; }
    for (const row of db.prepare('SELECT position,data FROM frontend_observation_events WHERE host=? AND conversation=? AND command_id=? ORDER BY position').all(...parts)) {
      const progress = writer.progress(key), cursor = Number(row.position);
      if (cursor <= progress.cursor) continue;
      if (progress.status !== 'collecting') { if (progress.status === 'ready') writer.block(key); return; }
      const encoded = nonempty(row.data);
      writer.observe(key, { cursor, encoded, input: JSON.parse(encoded) });
    }
  }
}
