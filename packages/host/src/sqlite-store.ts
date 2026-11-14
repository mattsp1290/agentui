import { randomUUID } from 'node:crypto';
import { canonicalJson, foldDocument, parseCommand, sameScope } from '@agentui/contracts';
import type { ClientCommand, ConversationDocument, ConversationScope, Envelope, HostEvent, Projection, Receipt, ReceiptState, Snapshot } from '@agentui/contracts';
import type { DispatchEvidence, DispatchObservation, NativeDispatchObservation } from '@mattsp1290/switchboard';
import { openDatabase } from './sqlite-schema.js';
import { nonempty, object, decision, installation, integer, nativeRun, output, receipt } from './durable-model.js';
import type { CapturedTarget, CommandResult, HostBudgets, HostOutput, Installation, StoredCommand } from './durable-model.js';

type Admission<E> = { kind: 'owned'; stored: StoredCommand<E> } | { kind: 'existing'; receipt: Receipt } | { kind: 'rejected'; reason: string };
export type ResumePlan<P> = { kind: 'resume'; through: number } | { kind: 'snapshot'; snapshot: Snapshot<P> } | { kind: 'refused'; reason: string };
function json(value: unknown): unknown { return JSON.parse(nonempty(value)); }
function fact(value: DispatchObservation<unknown>): string {
  if (value.kind === 'accepted' || value.kind === 'conclusive') {
    return canonicalJson({ kind: value.kind, identity: value.evidence.identity,
      nativeOperation: value.evidence.nativeOperation,
      result: value.kind === 'conclusive' ? value.result : null });
  }
  return canonicalJson(value);
}
function key(scope: ConversationScope): [string, string] { return [scope.hostId, scope.conversationId]; }

export class SqliteStore<E, P> {
  readonly db;
  constructor(path: string, readonly projection: Projection<E, P>, readonly limits: HostBudgets) {
    this.db = openDatabase(path);
    try {
      if (this.db.prepare('SELECT 1 FROM conversations WHERE version<>? LIMIT 1').get(projection.version)) throw new Error('Incompatible projection');
      if (this.db.prepare('SELECT 1 FROM conversations WHERE NOT json_valid(document) OR NOT json_valid(installation) LIMIT 1').get()) throw new Error('Corrupt stored JSON');
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  private transaction<T>(work: () => T, write = true): T {
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private conversation(scope: ConversationScope) {
    const row = this.db.prepare('SELECT * FROM conversations WHERE host=? AND conversation=?').get(...key(scope));
    if (!row) throw new Error('Unknown conversation');
    if (row.version !== this.projection.version) throw new Error('Incompatible projection');
    return row;
  }
  create(scope: ConversationScope, installed: Installation): void {
    this.transaction(() => {
      const existing = this.db.prepare('SELECT installation FROM conversations WHERE host=? AND conversation=?').get(...key(scope));
      if (existing) {
        if (existing.installation !== canonicalJson(installed)) throw new Error('Installation is immutable');
        return;
      }
      const document = canonicalJson({ domain: this.projection.initial(), receipts: {}, decisions: {} });
      this.db.prepare('INSERT INTO conversations VALUES (?, ?, ?, 0, ?, ?, ?)')
        .run(...key(scope), canonicalJson(installed), this.projection.version, document, Buffer.byteLength(document));
    });
  }
  private decodeDocument(value: unknown): ConversationDocument<P> {
    const input = object(value), receipts = object(input.receipts), decisions = object(input.decisions);
    return { domain: this.projection.decodeState(input.domain),
      receipts: Object.fromEntries(Object.entries(receipts).map(([id, value]) => [id, receipt(value)])),
      decisions: Object.fromEntries(Object.entries(decisions).map(([id, value]) => [id, decision(value)])) };
  }
  snapshot(scope: ConversationScope): Snapshot<P> {
    const row = this.conversation(scope);
    return { scope, projectionVersion: this.projection.version, cursor: integer(row.head), document: this.decodeDocument(json(row.document)) };
  }
  head(scope: ConversationScope): number {
    const row = this.db.prepare('SELECT head, version FROM conversations WHERE host=? AND conversation=?').get(...key(scope));
    if (!row || row.version !== this.projection.version) throw new Error('Unknown or incompatible conversation');
    return integer(row.head);
  }
  private target(value: unknown, scope: ConversationScope): CapturedTarget {
    const input = object(value), installed = installation(input.installation), identity = object(input.identity);
    const run = input.run === null ? null : nativeRun(input.run, installed, scope);
    const storedDecision = input.decision === null ? null : object(input.decision);
    const parsedDecision = storedDecision === null ? null : {
      visible: decision(storedDecision.visible), continuation: JSON.parse(canonicalJson(storedDecision.continuation)),
    };
    const target: CapturedTarget = { installation: installed, run, decision: parsedDecision,
      identity: { hostOperationId: nonempty(identity.hostOperationId), target: run
        ? { kind: 'session', reference: run.reference } : { kind: 'new-session', binding: installed.binding } } };
    if (canonicalJson(identity) !== canonicalJson(target.identity)) throw new Error('Corrupt captured target');
    return target;
  }
  private observation(value: unknown, target: CapturedTarget, scope: ConversationScope): DispatchObservation<CommandResult<E>> {
    const input = object(value);
    if (input.kind === 'outcome-unknown') return { kind: 'outcome-unknown' };
    if (input.kind === 'not-dispatched' && (input.reason === 'aborted' || input.reason === 'intent-failed')) return { kind: input.kind, reason: input.reason };
    if (input.kind !== 'accepted' && input.kind !== 'conclusive') throw new Error('Invalid observation');
    const evidence = object(input.evidence), extension = object(evidence.observation);
    if (canonicalJson(evidence.identity) !== canonicalJson(target.identity)) throw new Error('Evidence identity mismatch');
    if (evidence.source !== 'native-acknowledgement' && evidence.source !== 'authoritative-native-lookup') throw new Error('Invalid evidence source');
    const native = evidence.nativeOperation === null ? null : object(evidence.nativeOperation);
    const parsedEvidence: DispatchEvidence = { identity: target.identity, source: evidence.source,
      nativeOperation: native ? { namespace: nonempty(native.namespace), id: nonempty(native.id) } : null,
      observation: { namespace: nonempty(extension.namespace), schemaVersion: integer(extension.schemaVersion), data: JSON.parse(canonicalJson(extension.data)) },
    };
    if (input.kind === 'accepted') return { kind: 'accepted', evidence: parsedEvidence };
    const result = object(input.result);
    if (result.kind === 'rejected') return { kind: 'conclusive', evidence: parsedEvidence, result: { kind: 'rejected', reason: nonempty(result.reason) } };
    if (result.kind !== 'completed') throw new Error('Invalid command result');
    return { kind: 'conclusive', evidence: parsedEvidence, result: {
      kind: 'completed', output: output(result.output, this.projection, target.installation, scope),
    } };
  }
  command(scope: ConversationScope, id: string): StoredCommand<E> | null {
    const row = this.db.prepare('SELECT * FROM commands WHERE host=? AND conversation=? AND id=?').get(...key(scope), id);
    if (!row) return null;
    const command = parseCommand(json(row.intent)), target = this.target(json(row.target), scope);
    const parsedReceipt = receipt(json(row.receipt));
    if (!sameScope(command.scope, scope) || command.clientCommandId !== id || parsedReceipt.hostOperationId !== target.identity.hostOperationId) throw new Error('Corrupt command');
    return { command, target, receipt: parsedReceipt,
      observation: row.observation === null ? null : this.observation(json(row.observation), target, scope) };
  }
  private appendEvents(scope: ConversationScope, events: readonly HostEvent<E>[]): void {
    const snapshot = this.snapshot(scope);
    let document = snapshot.document, sequence = snapshot.cursor;
    for (const event of events) {
      const envelope: Envelope<E> = { scope, sequence: ++sequence, event };
      const payload = canonicalJson(envelope), bytes = Buffer.byteLength(payload);
      if (bytes > this.limits.maxEventBytes) throw new Error('Event exceeds byte budget');
      document = foldDocument(document, event, this.projection);
      this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?)').run(...key(scope), sequence, payload, bytes);
    }
    const encoded = canonicalJson(document);
    this.db.prepare('UPDATE conversations SET head=?, document=?, bytes=? WHERE host=? AND conversation=?')
      .run(sequence, encoded, Buffer.byteLength(encoded), ...key(scope));
  }
  admit(command: ClientCommand, capability: { readonly kind: 'supported' } | { readonly kind: 'unsupported'; readonly reason: string }): Admission<E> {
    return this.transaction(() => {
      const existing = this.command(command.scope, command.clientCommandId);
      if (existing) return canonicalJson(existing.command) === canonicalJson(command)
        ? { kind: 'existing', receipt: this.exposedReceipt(existing) }
        : { kind: 'rejected', reason: 'command-id-conflict' };
      const scope = command.scope, installed = installation(json(this.conversation(scope).installation));
      if (capability.kind === 'unsupported') return { kind: 'rejected', reason: capability.reason };
      let run = null, pending = null;
      if (command.body.kind === 'approve') {
        const row = this.db.prepare('SELECT * FROM pending_decisions WHERE host=? AND conversation=? AND id=?')
          .get(...key(scope), command.body.pendingId);
        if (!row || row.status !== 'open') return { kind: 'rejected', reason: 'decision-unavailable' };
        const data = object(json(row.data));
        pending = { visible: decision(data.visible), continuation: JSON.parse(canonicalJson(data.continuation)) };
        if (!pending.visible.choices.includes(command.body.choiceId)) return { kind: 'rejected', reason: 'invalid-choice' };
      }
      const runId = command.body.kind === 'cancel' ? command.body.runId : pending?.visible.runId;
      if (runId) {
        const row = this.db.prepare('SELECT data FROM runs WHERE host=? AND conversation=? AND id=?').get(...key(scope), runId);
        if (!row) return { kind: 'rejected', reason: 'unknown-run' };
        run = nativeRun(json(row.data), installed, scope);
      }
      const operation = randomUUID();
      const target: CapturedTarget = { installation: installed, run, decision: pending,
        identity: { hostOperationId: operation, target: run ? { kind: 'session', reference: run.reference }
          : { kind: 'new-session', binding: installed.binding } } };
      const admitted: Receipt = { scope, clientCommandId: command.clientCommandId, hostOperationId: operation,
        sequence: this.head(scope) + 1, state: { kind: 'pending' } };
      this.db.prepare('INSERT INTO commands VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
        .run(...key(scope), command.clientCommandId, operation, canonicalJson(command), canonicalJson(target), canonicalJson(admitted));
      if (pending) this.db.prepare("UPDATE pending_decisions SET status='reserved', operation=? WHERE host=? AND conversation=? AND id=?")
        .run(operation, ...key(scope), pending.visible.pendingId);
      this.appendEvents(scope, [{ kind: 'receipt', receipt: admitted }]);
      return { kind: 'owned', stored: { command, target, receipt: admitted, observation: null } };
    });
  }
  exposedReceipt(stored: StoredCommand<E>): Receipt {
    return stored.observation === null ? { ...stored.receipt, state: { kind: 'uncertain', reason: 'attempt-may-have-entered-provider' } } : stored.receipt;
  }
  verifyIntent(stored: StoredCommand<E>): void {
    const persisted = this.command(stored.command.scope, stored.command.clientCommandId);
    if (!persisted || canonicalJson(persisted.target) !== canonicalJson(stored.target) || canonicalJson(persisted.command) !== canonicalJson(stored.command)) throw new Error('Intent verification failed');
  }
  private writeOutput(scope: ConversationScope, value: HostOutput<E>, installed: Installation): HostEvent<E>[] {
    const parsed = output(value, this.projection, installed, scope);
    for (const run of parsed.runs) {
      const encoded = canonicalJson(run), id = run.identity.runId;
      const existing = this.db.prepare('SELECT data FROM runs WHERE host=? AND conversation=? AND id=?').get(...key(scope), id);
      if (existing && existing.data !== encoded) throw new Error('Run reference is immutable');
      if (!existing) this.db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?)').run(...key(scope), id, encoded);
    }
    for (const pending of parsed.decisions) this.db.prepare("INSERT INTO pending_decisions VALUES (?, ?, ?, ?, ?, 'open', NULL)")
      .run(...key(scope), pending.visible.pendingId, pending.visible.runId, canonicalJson(pending));
    return [...parsed.events.map(event => ({ kind: 'domain', event }) as const),
      ...parsed.decisions.map(pending => ({ kind: 'decision-opened', decision: pending.visible }) as const)];
  }
  append(scope: ConversationScope, value: HostOutput<E>): void {
    this.transaction(() => {
      const installed = installation(json(this.conversation(scope).installation));
      this.appendEvents(scope, this.writeOutput(scope, value, installed));
    });
  }
  settle(scope: ConversationScope, id: string, value: DispatchObservation<CommandResult<E>>): Receipt {
    return this.transaction(() => {
      const stored = this.command(scope, id);
      if (!stored) throw new Error('Unknown command');
      const observed = this.observation(value, stored.target, scope), previous = stored.observation;
      if (previous?.kind === 'conclusive' || previous?.kind === 'not-dispatched') {
        if (observed.kind === previous.kind && fact(observed) !== fact(previous)) throw new Error('Conflicting terminal evidence');
        return stored.receipt;
      }
      if (previous?.kind === 'accepted' && observed.kind === 'outcome-unknown') return stored.receipt;
      if (previous?.kind === 'accepted' && observed.kind === 'not-dispatched') throw new Error('Conflicting acceptance evidence');
      if (previous?.kind === 'accepted' && (observed.kind === 'accepted' || observed.kind === 'conclusive') &&
        canonicalJson(previous.evidence.nativeOperation) !== canonicalJson(observed.evidence.nativeOperation)) throw new Error('Conflicting native operation');
      if (previous && fact(previous) === fact(observed)) return stored.receipt;
      let state: ReceiptState;
      const events: HostEvent<E>[] = [];
      switch (observed.kind) {
        case 'outcome-unknown': state = { kind: 'uncertain', reason: 'provider-outcome-unknown' }; break;
        case 'not-dispatched': state = { kind: 'not-dispatched', reason: observed.reason }; break;
        case 'accepted': state = { kind: 'accepted' }; break;
        case 'conclusive':
          state = observed.result.kind === 'completed' ? { kind: 'completed' } : { kind: 'rejected', reason: observed.result.reason };
          if (observed.result.kind === 'completed') events.push(...this.writeOutput(scope, observed.result.output, stored.target.installation));
          break;
      }
      const pending = stored.target.decision;
      if (pending && (observed.kind === 'conclusive' || observed.kind === 'not-dispatched')) {
        const resolved = observed.kind === 'conclusive' && observed.result.kind === 'completed';
        this.db.prepare('UPDATE pending_decisions SET status=?, operation=NULL WHERE host=? AND conversation=? AND id=? AND operation=?')
          .run(resolved ? 'closed' : 'open', ...key(scope), pending.visible.pendingId, stored.target.identity.hostOperationId);
        if (resolved) events.push({ kind: 'decision-closed', pendingId: pending.visible.pendingId });
      }
      const next: Receipt = { ...stored.receipt, sequence: this.head(scope) + 1, state };
      this.db.prepare('UPDATE commands SET observation=?, receipt=? WHERE host=? AND conversation=? AND id=?')
        .run(canonicalJson(observed), canonicalJson(next), ...key(scope), id);
      this.appendEvents(scope, [{ kind: 'receipt', receipt: next }, ...events]);
      return next;
    });
  }
  recoveryPrevious(stored: StoredCommand<E>): NativeDispatchObservation<CommandResult<E>> {
    return stored.observation === null || stored.observation.kind === 'not-dispatched'
      ? { kind: 'outcome-unknown' } : stored.observation;
  }
  plan(scope: ConversationScope, after: number | null, version: number): ResumePlan<P> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT head, version, bytes FROM conversations WHERE host=? AND conversation=?').get(...key(scope));
      if (!row || row.version !== version || version !== this.projection.version) return { kind: 'refused', reason: 'unknown-scope-or-incompatible-projection' };
      const through = integer(row.head);
      if (after !== null && (!Number.isSafeInteger(after) || after < 0 || after > through)) return { kind: 'refused', reason: 'invalid-cursor-request-snapshot' };
      const totals = this.db.prepare('SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes FROM events WHERE host=? AND conversation=? AND sequence>? AND sequence<=?')
        .get(...key(scope), after ?? through, through);
      if (after === null || integer(totals?.count) > this.limits.replayEvents || integer(totals?.bytes) > this.limits.replayBytes) {
        const wrapperBytes = Buffer.byteLength(canonicalJson({ scope, projectionVersion: version, cursor: through, document: null })) - 4;
        if (integer(row.bytes) + wrapperBytes > this.limits.snapshotBytes) return { kind: 'refused', reason: 'snapshot-overflow' };
        return { kind: 'snapshot', snapshot: this.snapshot(scope) };
      }
      return { kind: 'resume', through };
    }, false);
  }
  page(scope: ConversationScope, after: number, through: number): readonly Envelope<E>[] {
    const metadata = this.db.prepare('SELECT sequence, bytes FROM events WHERE host=? AND conversation=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?')
      .all(...key(scope), after, through, this.limits.pageEvents);
    let bytes = 0;
    const events: Envelope<E>[] = [];
    for (const row of metadata) {
      const size = integer(row.bytes);
      if (size > this.limits.pageBytes) throw new Error('Event exceeds page budget');
      if (bytes + size > this.limits.pageBytes) break;
      bytes += size;
      const payload = this.db.prepare('SELECT payload FROM events WHERE host=? AND conversation=? AND sequence=?').get(...key(scope), integer(row.sequence));
      const input = object(json(payload?.payload)), event = object(input.event);
      let decoded: HostEvent<E>;
      switch (event.kind) {
        case 'domain': decoded = { kind: 'domain', event: this.projection.decodeEvent(event.event) }; break;
        case 'receipt': decoded = { kind: 'receipt', receipt: receipt(event.receipt) }; break;
        case 'decision-opened': decoded = { kind: 'decision-opened', decision: decision(event.decision) }; break;
        case 'decision-closed': decoded = { kind: 'decision-closed', pendingId: nonempty(event.pendingId) }; break;
        default: throw new Error('Corrupt event');
      }
      if (canonicalJson(input.scope) !== canonicalJson(scope) || input.sequence !== row.sequence) throw new Error('Corrupt envelope');
      events.push({ scope, sequence: integer(row.sequence), event: decoded });
    }
    return events;
  }
}
