import { randomUUID } from 'node:crypto';
import { canonicalJson, CORE_SNAPSHOT_DOCUMENT_JSON_BUDGET, JsonLimitError, foldDocument, parseCommand, parseDecision, parseDocument, parseHostEvent, parseReceipt, parseScope, sameScope } from '@agentui/contracts';
import type { ClientCommand, ConversationDocument, ConversationScope, Envelope, HostEvent, Projection, Receipt, ReceiptState, Snapshot } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { migrateTranscriptDatabase } from './transcript-migration.js';
import { openDatabase } from './sqlite-schema.js';
import { nonempty, object, integer, cloneJson } from './codec.js';
import { installation, nativeRun, output, capturedTarget, observation, captureTarget, settlementObservation, nativeObservation } from './native-execution.js';
import { settlement, isQuarantined, OUTPUT_REJECTED, CAPACITY_EXHAUSTED } from './settlement.js';
import type { HostBudgets, HostOutput, Installation, StoredCommand } from './durable-model.js';
import { scopeKey as key } from './durable-model.js';

type Observation = NonNullable<StoredCommand['observation']>;
type Admission = { kind: 'owned'; stored: StoredCommand } | { kind: 'existing'; receipt: Receipt } | { kind: 'rejected'; reason: string };
export type ResumePlan<P> = { kind: 'resume'; through: number } | { kind: 'snapshot'; snapshot: Snapshot<P> } | { kind: 'refused' | 'resync'; reason: string };
function json(value: unknown): unknown { return JSON.parse(nonempty(value)); }
class OutputApplicationError extends Error {}
export class CapacityError extends Error {}
const QUARANTINE_RECEIPT_GROWTH_BYTES = 128;

export class SqliteStore<E, P> {
  readonly db;
  onCommit: (() => void) | undefined;
  constructor(path: string, readonly projection: Projection<E, P>, readonly limits: HostBudgets) {
    this.db = openDatabase(path);
    try {
      this.transaction(() => {
        const configured = canonicalJson({ maxEventBytes: limits.maxEventBytes, maxCommandBytes: limits.maxCommandBytes, snapshotBytes: limits.snapshotBytes });
        const persisted = this.db.prepare('SELECT value FROM host_limits WHERE id=1').get();
        if (persisted && persisted.value !== configured) throw new Error('Incompatible persistent host budgets');
        if (!persisted) this.db.prepare('INSERT INTO host_limits(id, value) VALUES (1, ?)').run(configured);
      });
      if (this.db.prepare('SELECT 1 FROM conversations WHERE NOT json_valid(document) OR NOT json_valid(installation) LIMIT 1').get()) throw new Error('Corrupt stored JSON');
      if (projection === transcriptProjection) migrateTranscriptDatabase(this.db);
      if (this.db.prepare('SELECT 1 FROM conversations WHERE version<>? LIMIT 1').get(projection.version)) throw new Error('Incompatible projection');
    } catch (error) { this.db.close(); throw error; }
  }
  close(): void { this.db.close(); }
  transaction<T>(work: () => T, write = true): T {
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    let result: T;
    try { result = work(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (write) this.onCommit?.();
    return result;
  }
  private conversation(scope: ConversationScope) {
    const row = this.db.prepare('SELECT installation, head, version, document, bytes FROM conversations WHERE host=? AND conversation=?').get(...key(scope));
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
      const initial = { domain: this.projection.initial(), receipts: {}, decisions: {} };
      const document = this.encodeDocument(scope, initial);
      this.db.prepare('INSERT INTO conversations(host, conversation, installation, head, version, document, bytes) VALUES (?, ?, ?, 0, ?, ?, ?)')
        .run(...key(scope), canonicalJson(installed), this.projection.version, document, Buffer.byteLength(document));
    });
  }
  listConversations(hostId: string, after: string | null, limit: number): readonly ConversationScope[] {
    return this.db.prepare('SELECT host, conversation FROM conversations WHERE host=? AND conversation>? ORDER BY conversation LIMIT ?')
      .all(hostId, after ?? '', limit)
      .map(row => parseScope({ hostId: row.host, conversationId: row.conversation }));
  }
  snapshot(scope: ConversationScope): Snapshot<P> {
    const row = this.conversation(scope), cursor = integer(row.head);
    const document = parseDocument(json(row.document), value => this.projection.decodeState(value), scope, cursor);
    return { scope, projectionVersion: this.projection.version, cursor, document };
  }
  findInstallation(scope: ConversationScope): Installation | null {
    const row = this.db.prepare('SELECT installation FROM conversations WHERE host=? AND conversation=?').get(...key(scope));
    return row ? installation(json(row.installation)) : null;
  }
  inspect(scope: ConversationScope): { readonly installation: Installation; readonly snapshot: Snapshot<P> } {
    return { installation: installation(json(this.conversation(scope).installation)), snapshot: this.snapshot(scope) };
  }
  head(scope: ConversationScope): number {
    const row = this.db.prepare('SELECT head, version FROM conversations WHERE host=? AND conversation=?').get(...key(scope));
    if (!row || row.version !== this.projection.version) throw new Error('Unknown or incompatible conversation');
    return integer(row.head);
  }
  command(scope: ConversationScope, id: string): StoredCommand | null {
    const row = this.db.prepare('SELECT intent, target, observation, receipt FROM commands WHERE host=? AND conversation=? AND id=?').get(...key(scope), id);
    if (!row) return null;
    const command = parseCommand(json(row.intent)), target = capturedTarget(json(row.target), scope);
    const parsedReceipt = parseReceipt(json(row.receipt));
    if (!sameScope(command.scope, scope) || command.clientCommandId !== id || parsedReceipt.hostOperationId !== target.identity.hostOperationId) throw new Error('Corrupt command');
    return { command, target, receipt: parsedReceipt,
      observation: row.observation === null ? null : observation(json(row.observation), target) };
  }
  private snapshotOverheadBytes(scope: ConversationScope): number {
    return Buffer.byteLength(canonicalJson({ scope, projectionVersion: this.projection.version,
      cursor: Number.MAX_SAFE_INTEGER, document: null })) - 4;
  }
  private encodeDocument(scope: ConversationScope, document: ConversationDocument<P>): string {
    const reserve = Object.values(document.receipts).filter(value =>
      value.state.kind === 'pending' || value.state.kind === 'accepted').length * QUARANTINE_RECEIPT_GROWTH_BYTES +
      (this.projection.reserveBytes?.(document.domain) ?? 0);
    let encoded: string;
    try { encoded = canonicalJson(document, CORE_SNAPSHOT_DOCUMENT_JSON_BUDGET); }
    catch (error) {
      if (error instanceof JsonLimitError) throw new CapacityError('Document exceeds snapshot structural budget');
      throw error;
    }
    if (Buffer.byteLength(encoded) + this.snapshotOverheadBytes(scope) + reserve > this.limits.snapshotBytes) {
      throw new CapacityError('Document exceeds snapshot budget');
    }
    return encoded;
  }
  private appendEvents(scope: ConversationScope, events: readonly HostEvent<E>[]): void {
    const snapshot = this.snapshot(scope);
    let document = snapshot.document, sequence = snapshot.cursor;
    for (const event of events) {
      const envelope: Envelope<E> = { scope, sequence: ++sequence, event };
      const payload = canonicalJson(envelope), bytes = Buffer.byteLength(payload);
      const reserve = event.kind === 'receipt' && event.receipt.state.kind === 'pending' ? QUARANTINE_RECEIPT_GROWTH_BYTES : 0;
      if (bytes + reserve > this.limits.maxEventBytes) throw new OutputApplicationError('Event exceeds byte budget');
      try { document = foldDocument(document, event, this.projection); }
      catch (error) { throw new OutputApplicationError('Projection rejected output', { cause: error }); }
      this.db.prepare('INSERT INTO events(host, conversation, sequence, payload, bytes) VALUES (?, ?, ?, ?, ?)').run(...key(scope), sequence, payload, bytes);
    }
    const encoded = this.encodeDocument(scope, document);
    this.db.prepare('UPDATE conversations SET head=?, document=?, bytes=? WHERE host=? AND conversation=?')
      .run(sequence, encoded, Buffer.byteLength(encoded), ...key(scope));
  }
  admit(command: ClientCommand, capability: { readonly kind: 'supported' } | { readonly kind: 'unsupported'; readonly reason: string }, expectedInstallation?: Installation): Admission {
    try { return this.transaction((): Admission => {
      const existing = this.command(command.scope, command.clientCommandId);
      if (existing) return canonicalJson(existing.command) === canonicalJson(command)
        ? { kind: 'existing', receipt: existing.receipt }
        : { kind: 'rejected', reason: 'command-id-conflict' };
      if (Buffer.byteLength(canonicalJson(command)) > this.limits.maxCommandBytes) return { kind: 'rejected', reason: 'command-too-large' };
      if (!this.db.prepare('SELECT 1 FROM conversations WHERE host=? AND conversation=?').get(...key(command.scope))) return { kind: 'rejected', reason: 'unknown-conversation' };
      const scope = command.scope, installed = installation(json(this.conversation(scope).installation));
      if (expectedInstallation && canonicalJson(installed) !== canonicalJson(expectedInstallation)) {
        return { kind: 'rejected', reason: 'This conversation belongs to a different agent or workspace. Restart its original host to continue.' };
      }
      if (capability.kind === 'unsupported') return { kind: 'rejected', reason: capability.reason };
      let run = null, pending = null;
      if (command.body.kind === 'approve') {
        const row = this.db.prepare('SELECT data, status FROM pending_decisions WHERE host=? AND conversation=? AND id=?')
          .get(...key(scope), command.body.pendingId);
        if (!row || row.status !== 'open') return { kind: 'rejected', reason: 'decision-unavailable' };
        const data = object(json(row.data));
        pending = { visible: parseDecision(data.visible), continuation: cloneJson(data.continuation) };
        if (!pending.visible.choices.includes(command.body.choiceId)) return { kind: 'rejected', reason: 'invalid-choice' };
      }
      const runId = command.body.kind === 'cancel' ? command.body.runId : pending?.visible.runId;
      if (runId) {
        const row = this.db.prepare('SELECT data FROM runs WHERE host=? AND conversation=? AND id=?').get(...key(scope), runId);
        if (!row) return { kind: 'rejected', reason: 'unknown-run' };
        run = nativeRun(json(row.data), installed, scope);
      } else if (command.body.kind === 'send') {
        const outstanding = this.db.prepare("SELECT 1 FROM commands WHERE host=? AND conversation=? AND json_extract(intent, '$.body.kind')='send' AND json_extract(receipt, '$.state.kind') IN ('pending','accepted') LIMIT 1").get(...key(scope));
        if (outstanding) return { kind: 'rejected', reason: 'send-awaiting-confirmation' };
        const row = this.db.prepare('SELECT data FROM runs WHERE host=? AND conversation=? ORDER BY rowid DESC LIMIT 1').get(...key(scope));
        if (row) run = nativeRun(json(row.data), installed, scope);
      }
      const operation = randomUUID();
      const target = captureTarget({ installation: installed, run, decision: pending }, operation);
      const admitted: Receipt = { scope, clientCommandId: command.clientCommandId, hostOperationId: operation,
        sequence: this.head(scope) + 1, state: { kind: 'pending' } };
      this.db.prepare('INSERT INTO commands(host, conversation, id, operation, intent, target, observation, receipt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
        .run(...key(scope), command.clientCommandId, operation, canonicalJson(command), canonicalJson(target), canonicalJson(admitted));
      if (pending) this.db.prepare("UPDATE pending_decisions SET status='reserved', operation=? WHERE host=? AND conversation=? AND id=?")
        .run(operation, ...key(scope), pending.visible.pendingId);
      this.appendEvents(scope, [{ kind: 'receipt', receipt: admitted }]);
      return { kind: 'owned', stored: { command, target, receipt: admitted, observation: null } };
    }); } catch (error) {
      if (error instanceof CapacityError) return { kind: 'rejected', reason: 'conversation-capacity' };
      throw error;
    }
  }
  verifyIntent(stored: StoredCommand): void {
    const persisted = this.command(stored.command.scope, stored.command.clientCommandId);
    if (!persisted || canonicalJson(persisted.target) !== canonicalJson(stored.target) || canonicalJson(persisted.command) !== canonicalJson(stored.command)) throw new Error('Intent verification failed');
  }
  private writeOutput(scope: ConversationScope, value: unknown, installed: Installation): HostEvent<E>[] {
    let parsed: HostOutput<E>;
    try { parsed = output(value, this.projection, installed, scope); }
    catch (error) { throw new OutputApplicationError('Invalid provider output', { cause: error }); }
    for (const run of parsed.runs) {
      const encoded = canonicalJson(run), id = run.identity.runId;
      const existing = this.db.prepare('SELECT data FROM runs WHERE host=? AND conversation=? AND id=?').get(...key(scope), id);
      if (existing && existing.data !== encoded) throw new OutputApplicationError('Run reference is immutable');
      if (!existing) this.db.prepare('INSERT INTO runs(host, conversation, id, data) VALUES (?, ?, ?, ?)').run(...key(scope), id, encoded);
    }
    for (const pending of parsed.decisions) {
      if (this.db.prepare('SELECT 1 FROM pending_decisions WHERE host=? AND conversation=? AND id=?').get(...key(scope), pending.visible.pendingId)) throw new OutputApplicationError('Decision id already exists');
      if (!this.db.prepare('SELECT 1 FROM runs WHERE host=? AND conversation=? AND id=?').get(...key(scope), pending.visible.runId)) throw new OutputApplicationError('Decision run is missing');
      this.db.prepare("INSERT INTO pending_decisions(host, conversation, id, run, data, status, operation) VALUES (?, ?, ?, ?, ?, 'open', NULL)")
      .run(...key(scope), pending.visible.pendingId, pending.visible.runId, canonicalJson(pending));
    }
    const expired: HostEvent<E>[] = [];
    for (const pendingId of parsed.expiredDecisions ?? []) {
      const changed = this.db.prepare("UPDATE pending_decisions SET status='closed', operation=NULL WHERE host=? AND conversation=? AND id=? AND status<>'closed'")
        .run(...key(scope), pendingId);
      if (changed.changes) expired.push({ kind: 'decision-closed', pendingId });
    }
    return [...parsed.events.map(event => ({ kind: 'domain', event }) as const),
      ...parsed.decisions.map(pending => ({ kind: 'decision-opened', decision: pending.visible }) as const), ...expired];
  }
  append(scope: ConversationScope, value: HostOutput<E>): void {
    this.transaction(() => {
      const installed = installation(json(this.conversation(scope).installation));
      this.appendEvents(scope, this.writeOutput(scope, value, installed));
    });
  }
  settle(scope: ConversationScope, id: string, value: Observation): Receipt {
    return this.transaction(() => {
      const stored = this.command(scope, id);
      if (!stored) throw new Error('Unknown command');
      const transition = settlement(stored.observation === null ? null : settlementObservation(stored.observation),
        settlementObservation(observation(value, stored.target)), { quarantined: isQuarantined(stored) });
      switch (transition.kind) {
        case 'keep': return stored.receipt;
        case 'conflict': throw new Error(`Conflicting ${transition.reason}`);
        case 'record-evidence':
          this.writeObservation(stored, nativeObservation(transition.observed));
          return stored.receipt;
        case 'apply': return this.applyObservation(stored, nativeObservation(transition.observed));
      }
    });
  }
  private writeObservation(stored: StoredCommand, observed: Observation, next = stored.receipt): void {
    this.db.prepare('UPDATE commands SET observation=?, receipt=? WHERE host=? AND conversation=? AND id=?')
      .run(canonicalJson(observed), canonicalJson(next), ...key(stored.command.scope), stored.command.clientCommandId);
  }
  private quarantine(stored: StoredCommand, observed: Observation, error: OutputApplicationError | CapacityError): Receipt {
    const scope = stored.command.scope;
    const reason = error instanceof CapacityError && observed.kind !== 'conclusive' ? CAPACITY_EXHAUSTED : OUTPUT_REJECTED;
    const current = stored.receipt.state;
    if (current.kind === 'uncertain' && current.reason === reason) {
      this.writeObservation(stored, observed);
      return stored.receipt;
    }
    const next: Receipt = { ...stored.receipt, sequence: this.head(scope) + 1, state: { kind: 'uncertain', reason } };
    this.writeObservation(stored, observed, next);
    this.appendEvents(scope, [{ kind: 'receipt', receipt: next }]);
    return next;
  }
  private applyObservation(stored: StoredCommand, observed: Observation): Receipt {
    const scope = stored.command.scope;
    this.db.exec('SAVEPOINT output_application');
    try {
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
      this.writeObservation(stored, observed, next);
      this.appendEvents(scope, [{ kind: 'receipt', receipt: next }, ...events]);
      this.db.exec('RELEASE output_application');
      return next;
    } catch (error) {
      this.db.exec('ROLLBACK TO output_application; RELEASE output_application');
      if (!(error instanceof OutputApplicationError) && !(error instanceof CapacityError)) throw error;
      return this.quarantine(stored, observed, error);
    }
  }
  plan(scope: ConversationScope, after: number | null, version: number): ResumePlan<P> {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT head, version, bytes FROM conversations WHERE host=? AND conversation=?').get(...key(scope));
      if (!row || row.version !== version || version !== this.projection.version) return { kind: 'refused', reason: 'Unknown conversation or incompatible projection. Update the app and host together.' };
      const through = integer(row.head);
      if (after !== null && (!Number.isSafeInteger(after) || after < 0)) return { kind: 'refused', reason: 'invalid-cursor-request-snapshot' };
      if (after !== null && after > through) return { kind: 'resync', reason: 'cursor-ahead-request-snapshot' };
      const totals = this.db.prepare('SELECT count(*) AS count, coalesce(sum(bytes),0) AS bytes FROM events WHERE host=? AND conversation=? AND sequence>? AND sequence<=?')
        .get(...key(scope), after ?? through, through);
      if (after === null || integer(totals?.count) > this.limits.replayEvents || integer(totals?.bytes) > this.limits.replayBytes) {
        const wrapperBytes = this.snapshotOverheadBytes(scope);
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
      const input = object(json(payload?.payload));
      if (!sameScope(parseScope(input.scope), scope) || input.sequence !== row.sequence) throw new Error('Corrupt envelope');
      const sequence = integer(row.sequence);
      events.push({ scope, sequence, event: parseHostEvent(input.event, scope, sequence, this.projection) });
    }
    return events;
  }
}
