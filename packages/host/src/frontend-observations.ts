import { createHash } from 'node:crypto';
import { canonicalJson } from '@agentui/contracts';
import type { ConversationScope } from '@agentui/contracts';
import type { AguiOriginalRun } from '@agentui/sdk';
import { isOffered, scopeKey } from './durable-model.js';
import type { OfferedStoredCommand } from './durable-model.js';
import { nonempty } from './codec.js';
import { providerRun } from './provider-commands.js';
import type { ProviderCreation } from './provider-creation.js';
import { observationArray, observationItem, observationHeader, observationFrames } from './provider-observations.js';
import type { ObservationIdentity, ObservationHistory, ObservationFrame, ProviderObservations } from './provider-observations.js';
import type { SqliteStore } from './sqlite-store.js';
import { createFrontendCoordinator, prepareFrontendRegistration } from './frontend-tools/coordinator.js';

type Store = Pick<SqliteStore<unknown, unknown>, 'db' | 'command' | 'frontendSends' | 'frontendWriter' | 'creation'>;
type Transaction = Parameters<Store['frontendWriter']>[0];
type Membership = { readonly commandId: string; readonly commandDigest: string };
type PreparedRun = Membership & (ObservationHistory | { readonly kind: 'ignored' });
type PreparedPayload = { readonly fingerprint: string; readonly supplied: readonly Membership[]; readonly runs: readonly PreparedRun[] } &
  ({ readonly kind: 'snapshot' } | { readonly kind: 'event' } | { readonly kind: 'absent' });
export interface PreparedProviderObservations {
  readonly factory: typeof FrontendObservations;
  readonly payload: PreparedPayload;
}
const encodedBytes = (value: unknown) => Buffer.byteLength(canonicalJson(value));
const digest = (stored: NonNullable<ReturnType<Store['command']>>) => createHash('sha256').update(canonicalJson(stored)).digest('hex');
export class FrontendObservations {
  constructor(private readonly store: Store) {}
  private original(stored: OfferedStoredCommand): AguiOriginalRun<string> {
    const operation = stored.target.operation;
    return { operationId: operation.operationId, threadId: stored.agui.threadId,
      run: { binding: operation.binding, ref: { kind: 'run', instance: stored.target.installation.instance, opaqueId: stored.agui.runId } } };
  }
  private match(original: ProviderCreation, evidence: ObservationIdentity) {
    const { db } = this.store, scope = original.intent.scope;
    const row = db.prepare('SELECT conversation,id FROM commands WHERE host=? AND operation=?').get(scope.hostId, evidence.operationId);
    if (!row || row.conversation !== scope.conversationId) throw new Error('Unknown observation original');
    const stored = this.store.command(scope, nonempty(row.id));
    if (!stored || !('kind' in stored) || stored.target.operation.kind !== 'send' || stored.agui === null) throw new Error('Original observation not captured');
    const target = stored.target;
    if (canonicalJson({ installation: target.installation, intent: target.operation.binding.creation, credential: target.credential }) !== canonicalJson(original) ||
      stored.agui.threadId !== evidence.threadId || stored.agui.runId !== evidence.run.identity.runId ||
      canonicalJson(providerRun(evidence.run.reference, target.operation.binding, target.installation)) !== canonicalJson(evidence.run)) throw new Error('Foreign observation original');
    const observation = stored.observation;
    const confirmed = observation && 'evidence' in observation ? observation.evidence.source.run : null;
    if (confirmed && canonicalJson(confirmed) !== canonicalJson(evidence.run)) throw new Error('Conflicting original confirmation');
    if (stored.target.operation.observationProtocol === 'ag-ui-v1' && isOffered(stored)) this.store.frontendSends.observationState(stored);
    return stored;
  }
  private eligible(original: ProviderCreation, id: string) {
    const stored = this.store.command(original.intent.scope, id);
    if (!stored || !isOffered(stored) || stored.target.operation.kind !== 'send' || stored.target.operation.observationProtocol !== 'ag-ui-v1') return null;
    const evidence = this.original(stored);
    this.match(original, { ...evidence, run: providerRun(evidence.run, stored.target.operation.binding, stored.target.installation) });
    const parts = scopeKey(original.intent.scope), { db } = this.store;
    const status = db.prepare("SELECT json_extract(data,'$.status') AS status FROM frontend_runs WHERE host=? AND conversation=? AND thread=? AND run=?")
      .get(...parts, stored.agui.threadId, stored.agui.runId)?.status;
    const fault = db.prepare('SELECT fault FROM frontend_observation_runs WHERE host=? AND conversation=? AND command_id=?').get(...parts, id)?.fault;
    const observation = stored.observation;
    if (fault || (status && status !== 'collecting') || observation?.kind === 'not-dispatched' ||
      (observation?.kind === 'conclusive' && observation.result.kind === 'rejected' && !observation.evidence.source.run)) return null;
    return stored;
  }
  private *eligibleOriginals(original: ProviderCreation): Generator<OfferedStoredCommand> {
    let after = '';
    for (;;) {
      const rows = this.store.db.prepare('SELECT id FROM commands WHERE host=? AND conversation=? AND id>? ORDER BY id LIMIT 128')
        .all(...scopeKey(original.intent.scope), after);
      if (!rows.length) return;
      for (const row of rows) {
        after = nonempty(row.id);
        const stored = this.eligible(original, after);
        if (stored) yield stored;
      }
    }
  }
  private selection<I extends string = string>(original: ProviderCreation, describe?: (value: AguiOriginalRun<string>) => AguiOriginalRun<I>) {
    const originals: AguiOriginalRun<I>[] = [], supplied: Membership[] = [], fingerprint = createHash('sha256');
    let bytes = 4;
    for (const stored of this.eligibleOriginals(original)) {
      const member = { commandId: stored.command.clientCommandId, commandDigest: digest(stored) };
      fingerprint.update(canonicalJson([member.commandId, member.commandDigest])).update('\n');
      if (!describe || originals.length >= 128) continue;
      const descriptor = describe(this.original(stored));
      const size = encodedBytes({ ...descriptor, kind: 'unavailable' }) + encodedBytes(member) + (originals.length ? 2 : 0);
      if (bytes + size > 128_000) continue;
      originals.push(descriptor); supplied.push(member); bytes += size;
    }
    return { originals, supplied, fingerprint: fingerprint.digest('hex') };
  }
  prepare<I extends string>(original: ProviderCreation, describe: (value: AguiOriginalRun<string>) => AguiOriginalRun<I>, map: (originals: readonly AguiOriginalRun<I>[]) => ProviderObservations): PreparedPayload {
    const selection = this.selection(original, describe), mapped = map(selection.originals);
    selection.originals.length = 0;
    const runs: PreparedRun[] = [], { supplied, fingerprint } = selection;
    const payload: PreparedPayload = { kind: mapped.kind, supplied, fingerprint, runs };
    const correlate = (identity: ObservationIdentity) => {
      const stored = this.match(original, identity);
      return { member: { commandId: stored.command.clientCommandId, commandDigest: digest(stored) },
        observed: stored.target.operation.kind === 'send' && stored.target.operation.observationProtocol === 'ag-ui-v1' && isOffered(stored) };
    };
    if (mapped.kind === 'event') {
      for (const evidence of mapped.runs) {
        const { member, observed } = correlate(evidence);
        runs.push(!observed ? { ...member, kind: 'ignored' } : evidence.kind === 'unavailable'
          ? { ...member, kind: 'unavailable' } : { ...member, kind: 'events', first: evidence.first, frames: evidence.frames });
      }
    } else if (mapped.kind === 'snapshot') {
      const entries = observationArray(mapped.value);
      if (entries.length > 128) throw new Error('Observation mapping exceeds limit');
      const operations = new Set<string>();
      const headers = Array.from({ length: entries.length }, (_, index) => {
        const header = observationHeader(observationItem(entries, index), 'snapshot', mapped.binding, original.installation);
        if (operations.has(header.identity.operationId)) throw new Error('Duplicate snapshot original');
        operations.add(header.identity.operationId);
        const { member, observed } = correlate(header.identity), position = runs.length;
        runs.push({ ...member, kind: observed ? 'unavailable' : 'ignored' });
        return { events: header.events, member, observed, position };
      });
      let bytes = encodedBytes(payload);
      if (bytes > 1_000_000) throw new Error('Observation marker capacity invariant');
      const suppliedIds = new Set(supplied.map(member => member.commandId));
      for (const { events, member, observed, position } of headers) {
        if (events === null) continue;
        const frames: ObservationFrame[] = [];
        const complete = { ...member, kind: 'events', first: 1, frames } as const;
        const marker = runs[position];
        let size = encodedBytes(complete), rawBytes = 0, count = 0;
        const room = bytes - (marker ? encodedBytes(marker) : 0);
        let fits = observed && (suppliedIds.has(member.commandId) || !this.eligible(original, member.commandId)) &&
          events.length <= 4096 && room + size <= 1_000_000;
        for (const frame of observationFrames(events)) {
          rawBytes += frame.bytes;
          size += encodedBytes(frame) + (count++ ? 1 : 0);
          if (frame.bytes > 64_000 || rawBytes > 1_000_000 || room + size > 1_000_000) fits = false;
          if (fits) frames.push(frame); else frames.length = 0;
        }
        if (fits) { runs[position] = complete; bytes = room + size; }
      }
      if (encodedBytes(payload) !== bytes || bytes > 1_000_000) throw new Error('Observation preparation capacity invariant');
    }
    return payload;
  }
  commit(original: ProviderCreation, prepared: PreparedPayload, transaction: Transaction): void {
    if (this.selection(original).fingerprint !== prepared.fingerprint) throw new Error('Observation originals changed');
    const coverage = new Set(prepared.runs.filter(run => run.kind === 'events').map(run => run.commandId));
    if (prepared.kind !== 'event') for (const stored of this.eligibleOriginals(original)) {
      if (!coverage.has(stored.command.clientCommandId)) {
        this.fault(stored, 'history-unavailable');
        this.materialize(stored.command.scope, stored.command.clientCommandId, transaction);
      }
    }
    for (const evidence of prepared.runs) {
      const stored = this.store.command(original.intent.scope, evidence.commandId);
      if (!stored || digest(stored) !== evidence.commandDigest) throw new Error('Observation original changed');
      if (evidence.kind === 'ignored') continue;
      if (!isOffered(stored)) throw new Error('Observation offer changed');
      const identity = this.original(stored);
      this.match(original, { ...identity, run: providerRun(identity.run, stored.target.operation.binding, stored.target.installation) });
      this.append(stored, evidence, prepared.kind === 'snapshot');
      this.materialize(stored.command.scope, stored.command.clientCommandId, transaction);
    }
  }
  private fault(stored: OfferedStoredCommand, reason: 'history-unavailable' | 'event-conflict'): void {
    this.store.db.prepare(`INSERT INTO frontend_observation_runs(host,conversation,command_id,fault) VALUES(?,?,?,?)
      ON CONFLICT(host,conversation,command_id) DO UPDATE SET fault=coalesce(fault,excluded.fault)`)
      .run(...scopeKey(stored.command.scope), stored.command.clientCommandId, reason);
  }
  private append(stored: OfferedStoredCommand, evidence: ObservationHistory, snapshot: boolean): void {
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
