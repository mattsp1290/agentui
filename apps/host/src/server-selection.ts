import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { canonicalJson } from '@agentui/contracts';
import { count, hex, identifier, record } from '@agentui/contracts/decode';
import { parseServerCustomizationArtifact } from '@agentui/host/customization';
import type { ServerExtensionReplacement, ServerExtensionStatus } from '@agentui/host/extensions';
import type { AccessDatabase } from './access-database.js';
import { normalizeGrantPool, publicGrantBinding } from './provider-credentials.js';
import { verifyArtifactPins } from './provider-extensions.js';
import type { BrowserProviderExtension, ProviderExtensionSelection } from './provider-extensions.js';
import { chunkReceipt, SelectionRefusal, REFRESH_SELECTION_PREFIX, RECEIPT_LIMIT, parseAttemptOutcome, parseLiveRequest, parseSelection, parseSelectionCommand } from './selection-protocol.js';
import type { RefreshAdmission, LiveRequest, AttemptOutcome, OperationSummary, SelectionCommand, SelectionQuery, SelectionRuntime, SelectionStatus, ReceiptChunk } from './selection-protocol.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const journalTables = new Map([
  ['service_extension_selection_schema', 'singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, host TEXT NOT NULL'],
  ['service_extension_selections', 'id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE, intent TEXT NOT NULL, receipt TEXT NOT NULL, digest TEXT NOT NULL'],
  ['service_extension_attempts', 'sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, selection TEXT NOT NULL REFERENCES service_extension_selections(id), intent TEXT NOT NULL, outcome TEXT NOT NULL'],
]);
const refreshOwnerTable = 'service_extension_refresh_owner';
const refreshOwnerColumns = 'singleton INTEGER PRIMARY KEY CHECK(singleton=1), host TEXT NOT NULL';
const legacyColumns = 'sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, selection TEXT NOT NULL REFERENCES service_extension_selections(id), outcome TEXT NOT NULL';
type Selection = { readonly id: string; readonly revision: number; readonly command: SelectionCommand; readonly intent: string; readonly receipt: Buffer; readonly receiptDigest: string;
  readonly target: ReturnType<typeof parseSelection>; readonly grantsDigest: string };
type Attempt = { readonly id: string; readonly selection: string; readonly intent: string; readonly origin: LiveRequest | { readonly kind: 'boot' }; outcome: AttemptOutcome };
type StoredAttempt = Pick<Attempt, 'id' | 'selection' | 'intent'> & { readonly sequence: number; readonly outcome: string };
type JournalResult<T> = { readonly namespace: 0 | 1 | 2; readonly value: T };
type LoadedHistory = { readonly selections: Map<string, Selection>; readonly attempts: Attempt[]; readonly byId: Map<string, Attempt>;
  readonly desired: Selection | undefined; readonly unresolved: Attempt[] };
type Running = { readonly kind: 'withheld' | 'uncertain' }
  | { readonly kind: 'acknowledged'; readonly generation: number | null; readonly identity: Extract<SelectionRuntime, { id: string }> };
export type ExtensionStartup = { readonly kind: 'transient'; readonly entries: readonly BrowserProviderExtension[] }
  | { readonly kind: 'durable-artifacts'; readonly entries: readonly (Extract<BrowserProviderExtension, { kind: 'artifact' }>)[] };

export function assertNoSelectionJournal(database: AccessDatabase): void {
  if (database.database.prepare("SELECT 1 FROM sqlite_schema WHERE lower(name) GLOB 'service_extension_*' OR lower(name) GLOB 'host_refresh_*' LIMIT 1").get()) {
    throw new Error('Existing selection journal requires durable artifact ownership');
  }
}

export function assertRefreshSelectionOwner(database: AccessDatabase): void {
  const object = database.database.prepare('SELECT type,sql FROM sqlite_schema WHERE name=?').get(refreshOwnerTable);
  if (object?.type !== 'table' || object.sql !== `CREATE TABLE ${refreshOwnerTable} (${refreshOwnerColumns})`) throw new Error('Invalid refresh selection ownership');
  const owners = database.database.prepare('SELECT * FROM service_extension_refresh_owner').all();
  if (owners.length !== 1 || owners[0]?.singleton !== 1 || owners[0]?.host !== database.hostId) throw new Error('Invalid refresh selection ownership');
}

export async function createServerSelection(deps: { readonly database: AccessDatabase; readonly entries: Extract<ExtensionStartup, { kind: 'durable-artifacts' }>['entries'];
  readonly runtime: () => ServerExtensionStatus; readonly isClosing: () => boolean;
  readonly replace: (selected: ProviderExtensionSelection) => Promise<ServerExtensionReplacement>; readonly stopRuntime: () => void;
  readonly refreshOwnership?: { readonly recover: (commands: readonly SelectionCommand[]) => { readonly kind: 'allow' };
    readonly admit: (command: SelectionCommand) => RefreshAdmission } }) {
  const db = deps.database.database;
  if (deps.refreshOwnership !== undefined) {
    const owner = record(deps.refreshOwnership, ['recover', 'admit']);
    if (typeof owner.recover !== 'function' || typeof owner.admit !== 'function') throw new Error('Invalid refresh ownership');
  }
  const grants = normalizeGrantPool(deps.entries.flatMap(entry => entry.installations));
  const grantsDigest = digest('[' + grants.map(grant => canonicalJson(publicGrantBinding(grant))).sort().join(',') + ']');
  let selections = new Map<string, Selection>(), attempts: Attempt[] = [], byId = new Map<string, Attempt>();
  let desired: Selection | undefined, invalid = false, poisoned = false, busy: Promise<unknown> | undefined, closed = false, booted = false;
  let running: Running = { kind: 'withheld' };
  let refreshOwned = false;
  function transaction<T>(work: () => JournalResult<T>): T {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      if (inspectNamespace() !== result.namespace) throw new Error('Invalid selection journal');
      db.exec('COMMIT'); return result.value;
    }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function decodeSelection(row: Record<string, unknown>): Selection {
    const id = identifier(row.id, 96), revision = count(row.revision), intent = identifier(row.intent, RECEIPT_LIMIT);
    const command = parseSelectionCommand(JSON.parse(intent));
    if (command.id.startsWith(REFRESH_SELECTION_PREFIX) && !deps.refreshOwnership) throw new Error();
    if (command.id !== id || (revision === 0 ? id !== 'startup' || command.expectedRevision !== 0 : command.expectedRevision !== revision - 1) || canonicalJson(command) !== intent) throw new Error();
    const receipt = identifier(row.receipt, RECEIPT_LIMIT), receiptDigest = hex(row.digest, 64);
    if (Buffer.byteLength(receipt) > RECEIPT_LIMIT || digest(receipt) !== receiptDigest) throw new Error();
    const value = record(JSON.parse(receipt), ['version', 'hostId', 'selection', 'grantsDigest', 'manifests']);
    const target = parseSelection(value.selection);
    if (value.version !== 1 || value.hostId !== deps.database.hostId || canonicalJson(target) !== canonicalJson(command.selection) || !Array.isArray(value.manifests)) throw new Error();
    const manifests = value.manifests.map(parseServerCustomizationArtifact);
    if (manifests.length !== target.artifacts.length || manifests.some((manifest, index) => manifest.artifactId !== target.artifacts[index]?.artifactId)) throw new Error();
    if (canonicalJson({ version: 1, hostId: value.hostId, selection: target, grantsDigest: hex(value.grantsDigest, 64), manifests }) !== receipt) throw new Error();
    return { id, revision, command, intent, receipt: Buffer.from(receipt), receiptDigest, target, grantsDigest: hex(value.grantsDigest, 64) };
  }
  function inspectNamespace(): 0 | 1 | 2 {
    const objects = db.prepare("SELECT name, type, sql FROM sqlite_schema WHERE lower(name) GLOB 'service_extension_*'").all();
    if (!objects.length) return 0;
    if (!objects.some(object => object.name === 'service_extension_selection_schema' && object.type === 'table' &&
      object.sql === `CREATE TABLE service_extension_selection_schema (${journalTables.get('service_extension_selection_schema')})`)) throw new Error('Invalid selection journal');
    const schema = db.prepare('SELECT * FROM service_extension_selection_schema').all();
    const version = schema[0]?.version;
    if (schema.length !== 1 || schema[0]?.singleton !== 1 || (version !== 1 && version !== 2) || schema[0]?.host !== deps.database.hostId) throw new Error('Invalid selection journal');
    const tables = new Map(journalTables);
    if (refreshOwned && !objects.some(object => object.name === refreshOwnerTable)) throw new Error('Missing refresh selection ownership');
    if (objects.some(object => object.name === refreshOwnerTable)) {
      if (!deps.refreshOwnership) throw new Error('Refresh ownership requires guarded selection');
      tables.set(refreshOwnerTable, refreshOwnerColumns);
      assertRefreshSelectionOwner(deps.database);
    }
    if (version === 1) { tables.delete('service_extension_attempts'); tables.set('service_extension_boots', legacyColumns); }
    if (objects.length !== tables.size || objects.some(object => {
      if (object.type !== 'table' || typeof object.name !== 'string') return true;
      const definition = tables.get(object.name);
      return definition === undefined || object.sql !== `CREATE TABLE ${object.name} (${definition})`;
    })) throw new Error('Invalid selection journal');
    const extraUnique = db.prepare(`SELECT 1 FROM sqlite_schema AS t, pragma_index_list(t.name) AS i
      WHERE t.type='table' AND lower(t.name) GLOB 'service_extension_*' AND i."unique"=1 AND i.origin='c' LIMIT 1`).get();
    if (extraUnique) throw new Error('Invalid selection journal');
    return version;
  }
  function ownRefresh(): void {
    if (!deps.refreshOwnership) return;
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(refreshOwnerTable)) { refreshOwned = true; return; }
    db.exec(`CREATE TABLE ${refreshOwnerTable} (${refreshOwnerColumns})`);
    if (db.prepare('INSERT INTO service_extension_refresh_owner VALUES(1,?)').run(deps.database.hostId).changes !== 1) throw new Error('Refresh ownership write failed');
    refreshOwned = true;
  }
  function recoverRefresh(commands: readonly SelectionCommand[]): void {
    if (!deps.refreshOwnership) return;
    const result = record(deps.refreshOwnership.recover(commands), ['kind']);
    if ('then' in result || result.kind !== 'allow') throw new Error('Invalid refresh recovery');
  }
  function migrateV1(): void {
    db.exec(`CREATE TABLE service_extension_attempts (${journalTables.get('service_extension_attempts')})`);
    db.exec(`INSERT INTO service_extension_attempts SELECT sequence,id,selection,'{"kind":"boot"}',outcome FROM service_extension_boots`);
    db.exec('DROP TABLE service_extension_boots; UPDATE service_extension_selection_schema SET version=2');
  }
  function assertStoredAttempt(expected: StoredAttempt): void {
    const row = db.prepare('SELECT sequence,selection,intent,outcome FROM service_extension_attempts WHERE id=?').get(expected.id);
    if (row?.sequence !== expected.sequence || row.selection !== expected.selection || row.intent !== expected.intent || row.outcome !== expected.outcome) throw new Error('Selection journal write failed');
  }
  function assertStoredSelection(expected: Selection): void {
    const row = db.prepare('SELECT revision,intent,receipt,digest FROM service_extension_selections WHERE id=?').get(expected.id);
    if (row?.revision !== expected.revision || row.intent !== expected.intent || row.receipt !== expected.receipt.toString() || row.digest !== expected.receiptDigest) throw new Error('Selection journal write failed');
  }
  function isLatestSelection(selection: Selection): boolean {
    const row = db.prepare('SELECT id,revision FROM service_extension_selections ORDER BY revision DESC LIMIT 1').get();
    return row?.id === selection.id && row.revision === selection.revision;
  }
  function verifyWriteTail(selection: Selection, attempt?: StoredAttempt): void {
    assertStoredSelection(selection);
    if (!isLatestSelection(selection)) throw new Error('Selection journal write failed');
    if (attempt) {
      assertStoredAttempt(attempt);
      if (db.prepare('SELECT MAX(sequence) AS sequence FROM service_extension_attempts').get()?.sequence !== attempt.sequence) throw new Error('Selection journal write failed');
    }
  }
  {
    let validatedRecoveryFailure: 'Selection migration failed' | 'Selection recovery failed' | undefined;
    const interrupted: AttemptOutcome = { kind: 'interrupted' };
    try {
      const loaded = transaction<LoadedHistory>(() => {
        const selections = new Map<string, Selection>(), attempts: Attempt[] = [], byId = new Map<string, Attempt>();
        const storedAttempts: StoredAttempt[] = [], unresolved: Attempt[] = [];
        let desired: Selection | undefined;
        const version = inspectNamespace();
        if (!version) return { namespace: 0, value: { selections, attempts, byId, desired, unresolved } };
        for (const row of db.prepare('SELECT * FROM service_extension_selections ORDER BY revision').all()) {
          const selection = decodeSelection(row);
          if (selection.revision !== selections.size || selections.has(selection.id)) throw new Error();
          selections.set(selection.id, selection); desired = selection;
        }
        if (version === 2 && !desired) throw new Error('Invalid selection journal');
        let sequence = 0;
        for (const row of db.prepare(`SELECT * FROM service_extension_${version === 1 ? 'boots' : 'attempts'} ORDER BY sequence`).all()) {
          const id = identifier(row.id), selection = identifier(row.selection, 96), rawOutcome = identifier(row.outcome), outcome = parseAttemptOutcome(JSON.parse(rawOutcome));
          const intent = version === 1 ? '{"kind":"boot"}' : identifier(row.intent);
          const input = record(JSON.parse(intent));
          const origin = input.kind === 'boot' ? { kind: 'boot' as const } : parseLiveRequest(input);
          if (origin.kind === 'boot') record(input, ['kind']);
          if (canonicalJson(origin) !== intent || count(row.sequence) <= sequence || byId.has(id) || !selections.has(selection) || (version === 1 && outcome.kind === 'deferred')) throw new Error();
          sequence = count(row.sequence);
          const previous = attempts.findLast(attempt => attempt.selection === selection);
          if (origin.kind !== 'boot' && (origin.requestId !== id || origin.selectionId !== selection || origin.expectedRevision !== selections.get(selection)?.revision || selections.has(id) ||
            !allowsPredecessor(origin, previous))) throw new Error();
          const attempt: Attempt = { id, selection, intent, origin, outcome };
          attempts.push(attempt); byId.set(id, attempt);
          const unsettled = outcome.kind === 'pending' || outcome.kind === 'applying';
          if (unsettled) unresolved.push(attempt);
          storedAttempts.push({ id, selection, intent, sequence, outcome: unsettled ? canonicalJson(interrupted) : rawOutcome });
        }
        if (!desired) return { namespace: 1, value: { selections, attempts, byId, desired, unresolved } };
        validatedRecoveryFailure = version === 1 ? 'Selection migration failed' : 'Selection recovery failed';
        recoverRefresh([...selections.values()].map(selection => selection.command));
        if (version === 1) migrateV1();
        ownRefresh();
        const outcome = canonicalJson(interrupted), update = db.prepare('UPDATE service_extension_attempts SET outcome=? WHERE id=?');
        for (const attempt of unresolved) {
          if (update.run(outcome, attempt.id).changes !== 1) throw new Error('Selection journal write failed');
        }
        if (db.prepare('SELECT COUNT(*) AS n FROM service_extension_attempts').get()?.n !== storedAttempts.length ||
          db.prepare('SELECT COUNT(*) AS n FROM service_extension_selections').get()?.n !== selections.size) throw new Error('Selection journal write failed');
        for (const attempt of storedAttempts) assertStoredAttempt(attempt);
        for (const selection of selections.values()) assertStoredSelection(selection);
        return { namespace: 2, value: { selections, attempts, byId, desired, unresolved } };
      });
      for (const attempt of loaded.unresolved) attempt.outcome = interrupted;
      ({ selections, attempts, byId, desired } = loaded);
    } catch {
      if (validatedRecoveryFailure) throw new Error(validatedRecoveryFailure);
      invalid = true;
    }
  }
  function allowsPredecessor(origin: Attempt['origin'], previous: Pick<Attempt, 'id' | 'outcome'> | undefined): boolean {
    switch (origin.kind) {
      case 'boot': return previous === undefined || previous.outcome.kind === 'applied' || previous.outcome.kind === 'applied-empty';
      case 'apply': return previous === undefined;
      case 'retry': return previous?.id === origin.afterAttemptId && (previous.outcome.kind === 'deferred' || previous.outcome.kind === 'interrupted' ||
        previous.outcome.kind === 'grant-mismatch' || previous.outcome.kind === 'failed');
    }
  }
  function matchesGeneration(generation: number | null, state: ServerExtensionStatus): boolean {
    return generation === null ? state.kind === 'empty' : state.kind === 'active' && state.generation === generation;
  }
  function available(): void {
    if (invalid || poisoned || closed || deps.isClosing()) throw new SelectionRefusal('unavailable');
  }
  function fatal(reason: 'unavailable' | 'uncertain'): never {
    poisoned = true;
    if (reason === 'uncertain') running = { kind: 'uncertain' };
    deps.stopRuntime();
    throw new SelectionRefusal(reason);
  }
  function authority(selection: Selection): void {
    if (inspectNamespace() !== 2) throw new Error('Invalid selection journal');
    if (!isLatestSelection(selection)) throw new SelectionRefusal('revision-conflict');
    assertStoredSelection(selection);
  }
  function persist(attempt: Attempt, selection: Selection, outcome: AttemptOutcome): void {
    transaction(() => {
      authority(selection);
      const readAttempt = db.prepare('SELECT sequence,selection,intent,outcome FROM service_extension_attempts WHERE id=?');
      const row = readAttempt.get(attempt.id), nextOutcome = canonicalJson(outcome);
      if (row?.selection !== selection.id || row.intent !== attempt.intent || row.outcome !== canonicalJson(attempt.outcome)) throw new Error('Invalid selection attempt');
      const sequence = count(row.sequence);
      if (!sequence) throw new Error('Invalid selection attempt');
      if (db.prepare('UPDATE service_extension_attempts SET outcome=? WHERE id=?').run(nextOutcome, attempt.id).changes !== 1) throw new Error('Selection journal write failed');
      verifyWriteTail(selection, { ...attempt, sequence, outcome: nextOutcome });
      return { namespace: 2, value: undefined };
    });
    attempt.outcome = outcome;
  }
  async function reserve<T>(work: () => Promise<T>): Promise<T> {
    if (busy) throw new SelectionRefusal('busy');
    const task = Promise.resolve().then(work);
    busy = task;
    try { return await task; } finally { busy = undefined; }
  }
  async function prepareSelection(command: SelectionCommand, expectedStoredRevision: number): Promise<Selection> {
    available();
    const manifests = await verifyArtifactPins(command.selection.artifacts, grants).catch(() => { throw new SelectionRefusal('invalid-artifact'); });
    const receipt = canonicalJson({ version: 1, hostId: deps.database.hostId, selection: command.selection, grantsDigest, manifests });
    if (Buffer.byteLength(receipt) > RECEIPT_LIMIT) throw new SelectionRefusal('receipt-too-large');
    return { id: command.id, revision: count(expectedStoredRevision + 1), command, intent: canonicalJson(command), receipt: Buffer.from(receipt),
      receiptDigest: digest(receipt), target: command.selection, grantsDigest };
  }
  function insertSelection(selection: Selection, expectedStoredRevision: number): void {
    transaction(() => {
      available();
      const version = inspectNamespace();
      if (expectedStoredRevision !== -1 && version !== 2) throw new Error('Invalid selection journal');
      const storedRevision = version ? db.prepare('SELECT MAX(revision) AS revision FROM service_extension_selections').get()?.revision ?? -1 : -1;
      if (storedRevision !== expectedStoredRevision) throw new SelectionRefusal('revision-conflict');
      if (expectedStoredRevision === -1) recoverRefresh([]);
      const command = selection.command;
      if (version === 2 && db.prepare('SELECT 1 FROM service_extension_attempts WHERE id=?').get(selection.id)) throw new SelectionRefusal('id-conflict');
      if (expectedStoredRevision === -1) {
        if (version === 2) throw new Error('Invalid selection journal');
        if (!version) {
          for (const [name, columns] of journalTables) db.exec(`CREATE TABLE ${name} (${columns})`);
          db.prepare('INSERT INTO service_extension_selection_schema VALUES(1,2,?)').run(deps.database.hostId);
        } else {
          if (db.prepare('SELECT 1 FROM service_extension_boots LIMIT 1').get()) throw new Error('Invalid selection journal');
          migrateV1();
        }
      }
      ownRefresh();
      const admission = deps.refreshOwnership ? deps.refreshOwnership.admit(command)
        : command.id.startsWith(REFRESH_SELECTION_PREFIX) ? { kind: 'refuse', reason: 'refresh-intent-conflict' } : { kind: 'allow' };
      if (!admission || typeof admission !== 'object' || 'then' in admission) throw new Error('Invalid refresh admission');
      record(admission, admission.kind === 'refuse' ? ['kind', 'reason'] : ['kind']);
      if (admission.kind === 'refuse' && (admission.reason === 'source-superseded' || admission.reason === 'refresh-intent-conflict')) throw new SelectionRefusal(admission.reason);
      if (admission.kind !== 'allow') throw new Error('Invalid refresh admission');
      if (db.prepare('INSERT INTO service_extension_selections VALUES(?,?,?,?,?)').run(selection.id, selection.revision, selection.intent, selection.receipt.toString(), selection.receiptDigest).changes !== 1) throw new Error('Selection journal write failed');
      if (version !== 2 && db.prepare('SELECT COUNT(*) AS n FROM service_extension_attempts').get()?.n !== 0) throw new Error('Selection journal write failed');
      verifyWriteTail(selection);
      return { namespace: 2, value: undefined };
    });
    selections.set(selection.id, selection); desired = selection;
  }
  async function accept(command: SelectionCommand): Promise<OperationSummary> {
    available();
    const intent = canonicalJson(command), existing = selections.get(command.id);
    if (existing) {
      if (existing.intent !== intent) throw new SelectionRefusal('id-conflict');
      return summary(existing);
    }
    if (byId.has(command.id)) throw new SelectionRefusal('id-conflict');
    return reserve(async () => {
      if (command.expectedRevision !== desired?.revision) throw new SelectionRefusal('revision-conflict');
      const selection = await prepareSelection(command, command.expectedRevision);
      try { insertSelection(selection, command.expectedRevision); }
      catch (error) { if (error instanceof SelectionRefusal) throw error; fatal('unavailable'); }
      return summary(selection);
    });
  }
  function summary(selection: Selection, attempt = attempts.findLast(value => value.selection === selection.id)): OperationSummary {
    return { id: selection.id, revision: selection.revision, receiptDigest: selection.receiptDigest, artifacts: selection.target.artifacts.length,
      attemptId: attempt?.id ?? null, outcome: attempt?.outcome ?? { kind: selection === desired ? 'staged' : 'superseded' } };
  }
  if (!invalid && !desired) {
    const selection = await prepareSelection({ id: 'startup', expectedRevision: 0, selection: { version: 1,
      artifacts: deps.entries.map(({ directory, artifactId }) => ({ directory: resolve(directory), artifactId })) } }, -1);
    insertSelection(selection, -1);
  }
  async function execute(selection: Selection, attempt: Attempt): Promise<void> {
    let admission: 'admitted' | 'withheld';
    try {
      admission = transaction<'admitted' | 'withheld'>(() => {
        available(); authority(selection);
        const latest = db.prepare('SELECT id,outcome FROM service_extension_attempts WHERE selection=? ORDER BY sequence DESC LIMIT 1').get(selection.id);
        const previous = latest && { id: identifier(latest.id), outcome: parseAttemptOutcome(JSON.parse(identifier(latest.outcome))) };
        if (!allowsPredecessor(attempt.origin, previous)) {
          if (attempt.origin.kind === 'boot') return { namespace: 2, value: 'withheld' };
          throw new SelectionRefusal('attempt-conflict');
        }
        if (attempt.origin.kind !== 'boot') {
          const state = deps.runtime();
          if (state.kind === 'failed' && state.recovery === 'restart') throw new SelectionRefusal('attempt-conflict');
          if (attempt.origin.kind === 'retry' && previous?.outcome.kind === 'grant-mismatch' && selection.grantsDigest !== grantsDigest) throw new SelectionRefusal('attempt-conflict');
        }
        if (db.prepare('SELECT 1 FROM service_extension_selections WHERE id=?').get(attempt.id)) throw new SelectionRefusal('id-conflict');
        const outcome = canonicalJson(attempt.outcome);
        const inserted = db.prepare('INSERT INTO service_extension_attempts(id,selection,intent,outcome) VALUES(?,?,?,?)').run(attempt.id, selection.id, attempt.intent, outcome);
        const sequence = count(inserted.lastInsertRowid);
        if (inserted.changes !== 1 || !sequence) throw new Error('Selection journal write failed');
        verifyWriteTail(selection, { ...attempt, sequence, outcome });
        return { namespace: 2, value: 'admitted' };
      });
    } catch (error) {
      if (error instanceof SelectionRefusal) throw error;
      fatal('unavailable');
    }
    if (admission === 'withheld') return;
    try {
      attempts.push(attempt); byId.set(attempt.id, attempt);
      if (selection.grantsDigest !== grantsDigest) { persist(attempt, selection, { kind: 'grant-mismatch' }); return; }
      persist(attempt, selection, { kind: 'applying' });
      available(); authority(selection);
    } catch { fatal('unavailable'); }
    try {
      let result: ServerExtensionReplacement;
      try { result = await deps.replace({ kind: 'artifacts', pins: selection.target.artifacts, grants }); }
      catch (error) {
        persist(attempt, selection, { kind: 'failed', failure: 'activation', recovery: 'replace' });
        throw error;
      }
      let outcome: AttemptOutcome, nextRunning: Running;
      switch (result.kind) {
        case 'deferred': outcome = result; nextRunning = running; break;
        case 'failed': outcome = result; nextRunning = { kind: 'withheld' }; break;
        case 'unavailable': outcome = { kind: 'interrupted' }; nextRunning = { kind: 'withheld' }; break;
        case 'replaced':
          if (!deps.isClosing() && !closed && matchesGeneration(result.generation, deps.runtime())) {
            outcome = { kind: result.generation === null ? 'applied-empty' : 'applied' };
            nextRunning = { kind: 'acknowledged', generation: result.generation,
              identity: { kind: outcome.kind === 'applied' ? 'active' : 'applied-empty', id: selection.id, revision: selection.revision, attemptId: attempt.id } };
          } else {
            outcome = { kind: 'interrupted' }; nextRunning = { kind: 'withheld' };
          }
      }
      persist(attempt, selection, outcome);
      running = nextRunning;
    } catch { fatal('uncertain'); }
  }
  async function live(request: LiveRequest): Promise<OperationSummary> {
    available();
    const intent = canonicalJson(request), existing = byId.get(request.requestId);
    if (existing) {
      if (existing.intent !== intent) throw new SelectionRefusal('id-conflict');
      const selection = selections.get(existing.selection);
      if (!selection) throw new SelectionRefusal('unavailable');
      return summary(selection, existing);
    }
    if (selections.has(request.requestId)) throw new SelectionRefusal('id-conflict');
    return reserve(async () => {
      const selection = desired;
      if (!selection || selection.id !== request.selectionId || selection.revision !== request.expectedRevision) throw new SelectionRefusal('revision-conflict');
      const attempt: Attempt = { id: request.requestId, selection: selection.id, intent, origin: request, outcome: { kind: 'pending' } };
      await execute(selection, attempt);
      return summary(selection, attempt);
    });
  }
  async function activate(): Promise<void> {
    if (invalid || !desired || booted) return;
    booted = true;
    const selection = desired;
    let id: string;
    do { id = randomUUID(); } while (selections.has(id) || byId.has(id));
    await reserve(() => execute(selection, { id, selection: selection.id, intent: '{"kind":"boot"}', origin: { kind: 'boot' }, outcome: { kind: 'pending' } }));
  }
  return {
    activate, select: accept, live,
    status(query?: SelectionQuery): SelectionStatus {
      if (invalid || !desired) return { kind: 'journal-invalid' };
      const exact = query?.kind === 'attempt' ? byId.get(query.id) : undefined;
      const selected = query === undefined ? desired : selections.get(query.kind === 'selection' ? query.id : exact?.selection ?? '');
      if (!selected) throw new SelectionRefusal('unknown-operation');
      const last = attempts.findLast(value => value.outcome.kind === 'applied' || value.outcome.kind === 'applied-empty');
      const lastSelection = last && selections.get(last.selection);
      const state = deps.runtime();
      const runtime: SelectionRuntime = running.kind === 'uncertain' ? running : closed || deps.isClosing() ? { kind: 'closed' }
        : running.kind === 'acknowledged' && matchesGeneration(running.generation, state)
          ? running.identity : { kind: 'withheld' };
      return { kind: 'ready', desiredRevision: desired.revision, desired: summary(desired), operation: summary(selected, exact),
        lastApplied: lastSelection && last ? summary(lastSelection, last) : null, runtime };
    },
    receipt(hash: string, offset: number): ReceiptChunk {
      if (invalid) throw new Error('Invalid selection journal');
      const selection = [...selections.values()].find(value => value.receiptDigest === hash);
      if (!selection) throw new SelectionRefusal('unknown-receipt');
      return chunkReceipt(selection.receipt, hash, offset);
    },
    async close() { closed = true; await busy?.catch(() => {}); },
  };
}
export type ServerSelection = Awaited<ReturnType<typeof createServerSelection>>;
