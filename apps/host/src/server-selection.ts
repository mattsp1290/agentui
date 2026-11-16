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
import { SelectionRefusal, RECEIPT_LIMIT, parseAttemptOutcome, parseLiveRequest, parseSelection, parseSelectionCommand } from './selection-protocol.js';
import type { LiveRequest, AttemptOutcome, OperationSummary, SelectionCommand, SelectionQuery, SelectionRuntime, SelectionStatus, ReceiptChunk } from './selection-protocol.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const journalTables = new Map([
  ['service_extension_selection_schema', 'singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, host TEXT NOT NULL'],
  ['service_extension_selections', 'id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE, intent TEXT NOT NULL, receipt TEXT NOT NULL, digest TEXT NOT NULL'],
  ['service_extension_attempts', 'sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, selection TEXT NOT NULL REFERENCES service_extension_selections(id), intent TEXT NOT NULL, outcome TEXT NOT NULL'],
]);
const legacyColumns = 'sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, selection TEXT NOT NULL REFERENCES service_extension_selections(id), outcome TEXT NOT NULL';
type Selection = { readonly id: string; readonly revision: number; readonly intent: string; readonly receipt: Buffer; readonly receiptDigest: string;
  readonly target: ReturnType<typeof parseSelection>; readonly grantsDigest: string };
type Attempt = { readonly id: string; readonly selection: string; readonly intent: string; readonly origin: LiveRequest | { readonly kind: 'boot' }; outcome: AttemptOutcome };
export type ExtensionStartup = { readonly kind: 'transient'; readonly entries: readonly BrowserProviderExtension[] }
  | { readonly kind: 'durable-artifacts'; readonly entries: readonly (Extract<BrowserProviderExtension, { kind: 'artifact' }>)[] };

export function assertNoSelectionJournal(database: AccessDatabase): void {
  if (database.database.prepare("SELECT 1 FROM sqlite_schema WHERE lower(name) GLOB 'service_extension_*' LIMIT 1").get()) {
    throw new Error('Existing selection journal requires durable artifact ownership');
  }
}

export async function createServerSelection(deps: { readonly database: AccessDatabase; readonly entries: Extract<ExtensionStartup, { kind: 'durable-artifacts' }>['entries'];
  readonly runtime: () => ServerExtensionStatus; readonly isClosing: () => boolean;
  readonly replace: (selected: ProviderExtensionSelection) => Promise<ServerExtensionReplacement>; readonly stopRuntime: () => void }) {
  const db = deps.database.database;
  const grants = normalizeGrantPool(deps.entries.flatMap(entry => entry.installations));
  const grantsDigest = digest('[' + grants.map(grant => canonicalJson(publicGrantBinding(grant))).sort().join(',') + ']');
  const selections = new Map<string, Selection>(), attempts: Attempt[] = [], byId = new Map<string, Attempt>();
  let desired: Selection | undefined, invalid = false, poisoned = false, busy: Promise<unknown> | undefined, closed = false, booted = false;
  let running: SelectionRuntime = { kind: 'withheld' };
  function transaction<T>(work: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const value = work(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function decodeSelection(row: Record<string, unknown>): Selection {
    const id = identifier(row.id, 96), revision = count(row.revision), intent = identifier(row.intent, RECEIPT_LIMIT);
    const command = parseSelectionCommand(JSON.parse(intent));
    if (command.id !== id || (revision === 0 ? id !== 'startup' || command.expectedRevision !== 0 : command.expectedRevision !== revision - 1) || canonicalJson(command) !== intent) throw new Error();
    const receipt = identifier(row.receipt, RECEIPT_LIMIT), receiptDigest = hex(row.digest, 64);
    if (Buffer.byteLength(receipt) > RECEIPT_LIMIT || digest(receipt) !== receiptDigest) throw new Error();
    const value = record(JSON.parse(receipt), ['version', 'hostId', 'selection', 'grantsDigest', 'manifests']);
    const target = parseSelection(value.selection);
    if (value.version !== 1 || value.hostId !== deps.database.hostId || canonicalJson(target) !== canonicalJson(command.selection) || !Array.isArray(value.manifests)) throw new Error();
    const manifests = value.manifests.map(parseServerCustomizationArtifact);
    if (manifests.length !== target.artifacts.length || manifests.some((manifest, index) => manifest.artifactId !== target.artifacts[index]?.artifactId)) throw new Error();
    if (canonicalJson({ version: 1, hostId: value.hostId, selection: target, grantsDigest: hex(value.grantsDigest, 64), manifests }) !== receipt) throw new Error();
    return { id, revision, intent, receipt: Buffer.from(receipt), receiptDigest, target, grantsDigest: hex(value.grantsDigest, 64) };
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
  function upgrade(version: 1 | 2): void {
    if (version === 1) {
      db.exec(`CREATE TABLE service_extension_attempts (${journalTables.get('service_extension_attempts')})`);
      db.exec(`INSERT INTO service_extension_attempts SELECT sequence,id,selection,'{"kind":"boot"}',outcome FROM service_extension_boots`);
      db.exec('DROP TABLE service_extension_boots; UPDATE service_extension_selection_schema SET version=2');
    }
    db.exec(`UPDATE service_extension_attempts SET outcome='{"kind":"interrupted"}' WHERE json_extract(outcome,'$.kind') IN ('pending','applying')`);
  }
  let migrating = false;
  try {
    transaction(() => {
      const version = inspectNamespace();
      if (!version) return;
      for (const row of db.prepare('SELECT * FROM service_extension_selections ORDER BY revision').all()) {
        const selection = decodeSelection(row);
        if (selection.revision !== selections.size || selections.has(selection.id)) throw new Error();
        selections.set(selection.id, selection); desired = selection;
      }
      if (version === 2 && !desired) throw new Error('Invalid selection journal');
      let sequence = 0;
      for (const row of db.prepare(`SELECT * FROM service_extension_${version === 1 ? 'boots' : 'attempts'} ORDER BY sequence`).all()) {
        const id = identifier(row.id), selection = identifier(row.selection, 96), outcome = parseAttemptOutcome(JSON.parse(identifier(row.outcome)));
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
      }
      if (desired) { migrating = true; upgrade(version); }
    });
    for (const attempt of attempts) if (attempt.outcome.kind === 'pending' || attempt.outcome.kind === 'applying') attempt.outcome = { kind: 'interrupted' };
  } catch {
    if (migrating) throw new Error('Selection migration failed');
    invalid = true;
  }
  function retryable(outcome: AttemptOutcome): boolean {
    return outcome.kind === 'deferred' || outcome.kind === 'interrupted' || outcome.kind === 'grant-mismatch' || outcome.kind === 'failed';
  }
  function allowsPredecessor(request: LiveRequest, previous: Pick<Attempt, 'id' | 'outcome'> | undefined): boolean {
    return request.kind === 'apply' ? previous === undefined : previous?.id === request.afterAttemptId && retryable(previous.outcome);
  }
  function available(): void {
    if (invalid || poisoned || closed || deps.isClosing()) throw new SelectionRefusal('unavailable');
  }
  function fatal(effect: boolean): never {
    poisoned = true;
    if (effect) running = { kind: 'uncertain' };
    deps.stopRuntime();
    throw new SelectionRefusal(effect ? 'uncertain' : 'unavailable');
  }
  function authority(selection: Selection): void {
    if (inspectNamespace() !== 2) throw new Error('Invalid selection journal');
    const row = db.prepare('SELECT id,revision FROM service_extension_selections ORDER BY revision DESC LIMIT 1').get();
    if (row?.id !== selection.id || row.revision !== selection.revision) throw new SelectionRefusal('revision-conflict');
  }
  function persist(attempt: Attempt, selection: Selection, outcome: AttemptOutcome): void {
    transaction(() => {
      authority(selection);
      const row = db.prepare('SELECT selection,intent,outcome FROM service_extension_attempts WHERE id=?').get(attempt.id);
      if (row?.selection !== selection.id || row.intent !== attempt.intent || row.outcome !== canonicalJson(attempt.outcome)) throw new Error('Invalid selection attempt');
      if (db.prepare('UPDATE service_extension_attempts SET outcome=? WHERE id=?').run(canonicalJson(outcome), attempt.id).changes !== 1) throw new Error('Selection journal write failed');
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
    const manifests = await verifyArtifactPins(command.selection.artifacts, grants);
    const receipt = canonicalJson({ version: 1, hostId: deps.database.hostId, selection: command.selection, grantsDigest, manifests });
    if (Buffer.byteLength(receipt) > RECEIPT_LIMIT) throw new SelectionRefusal('receipt-too-large');
    return { id: command.id, revision: count(expectedStoredRevision + 1), intent: canonicalJson(command), receipt: Buffer.from(receipt),
      receiptDigest: digest(receipt), target: command.selection, grantsDigest };
  }
  function insertSelection(selection: Selection, expectedStoredRevision: number): void {
    transaction(() => {
      available();
      const version = inspectNamespace();
      if (expectedStoredRevision !== -1 && version !== 2) throw new Error('Invalid selection journal');
      const storedRevision = version ? db.prepare('SELECT MAX(revision) AS revision FROM service_extension_selections').get()?.revision ?? -1 : -1;
      if (storedRevision !== expectedStoredRevision) throw new SelectionRefusal('revision-conflict');
      if (expectedStoredRevision === -1) {
        if (version === 2) throw new Error('Invalid selection journal');
        if (!version) {
          for (const [name, columns] of journalTables) db.exec(`CREATE TABLE ${name} (${columns})`);
          db.prepare('INSERT INTO service_extension_selection_schema VALUES(1,2,?)').run(deps.database.hostId);
        } else {
          if (db.prepare('SELECT 1 FROM service_extension_boots LIMIT 1').get()) throw new Error('Invalid selection journal');
          upgrade(version);
        }
      }
      if (db.prepare('INSERT INTO service_extension_selections VALUES(?,?,?,?,?)').run(selection.id, selection.revision, selection.intent, selection.receipt.toString(), selection.receiptDigest).changes !== 1) throw new Error('Selection journal write failed');
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
      catch (error) { if (error instanceof SelectionRefusal) throw error; fatal(false); }
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
  async function execute(selection: Selection, attempt: Attempt): Promise<OperationSummary> {
    let effect = false;
    try {
      transaction(() => {
        available(); authority(selection);
        const latest = db.prepare('SELECT id,outcome FROM service_extension_attempts WHERE selection=? ORDER BY sequence DESC LIMIT 1').get(selection.id);
        const previous = latest && { id: identifier(latest.id), outcome: parseAttemptOutcome(JSON.parse(identifier(latest.outcome))) };
        if (attempt.origin.kind !== 'boot' && !allowsPredecessor(attempt.origin, previous)) throw new SelectionRefusal('attempt-conflict');
        if (db.prepare('SELECT 1 FROM service_extension_selections WHERE id=?').get(attempt.id)) throw new SelectionRefusal('id-conflict');
        db.prepare('INSERT INTO service_extension_attempts(id,selection,intent,outcome) VALUES(?,?,?,?)').run(attempt.id, selection.id, attempt.intent, canonicalJson(attempt.outcome));
      });
      attempts.push(attempt); byId.set(attempt.id, attempt);
      if (selection.grantsDigest !== grantsDigest) { persist(attempt, selection, { kind: 'grant-mismatch' }); return summary(selection, attempt); }
      persist(attempt, selection, { kind: 'applying' });
      available(); authority(selection);
      effect = true;
      let result: ServerExtensionReplacement;
      try { result = await deps.replace({ kind: 'artifacts', pins: selection.target.artifacts, grants }); }
      catch {
        persist(attempt, selection, { kind: 'failed', failure: 'discovery', recovery: 'replace' });
        throw new Error('Selection observation failed');
      }
      const status = deps.runtime();
      const outcome: AttemptOutcome = result.kind === 'failed' || result.kind === 'deferred' ? result : result.kind === 'replaced' && !deps.isClosing() && !closed &&
        (result.generation === null ? status.kind === 'empty' : status.kind === 'active' && status.generation === result.generation)
        ? { kind: result.generation === null ? 'applied-empty' : 'applied' } : { kind: 'interrupted' };
      persist(attempt, selection, outcome);
      if (outcome.kind !== 'deferred') running = { kind: 'withheld' };
      if (outcome.kind === 'applied' || outcome.kind === 'applied-empty') running = { kind: outcome.kind === 'applied' ? 'active' : 'applied-empty', id: selection.id, revision: selection.revision, attemptId: attempt.id };
      return summary(selection, attempt);
    } catch (error) {
      if (!effect && error instanceof SelectionRefusal && !byId.has(attempt.id)) throw error;
      return fatal(effect);
    }
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
      const previous = attempts.findLast(value => value.selection === selection.id), state = deps.runtime();
      if (!allowsPredecessor(request, previous)) throw new SelectionRefusal('attempt-conflict');
      if (state.kind === 'failed' && state.recovery === 'restart') throw new SelectionRefusal('attempt-conflict');
      if (request.kind === 'retry' && previous?.outcome.kind === 'grant-mismatch' && selection.grantsDigest !== grantsDigest) throw new SelectionRefusal('attempt-conflict');
      return execute(selection, { id: request.requestId, selection: selection.id, intent, origin: request, outcome: { kind: 'pending' } });
    });
  }
  async function activate(): Promise<void> {
    if (invalid || !desired || booted) return;
    booted = true;
    const selection = desired, previous = attempts.findLast(value => value.selection === selection.id);
    if (previous && previous.outcome.kind !== 'applied' && previous.outcome.kind !== 'applied-empty') return;
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
      const runtime = running.kind === 'uncertain' ? running : closed || deps.isClosing() ? { kind: 'closed' as const } : state.kind === 'active' || state.kind === 'empty' ? running : { kind: 'withheld' as const };
      return { kind: 'ready', desiredRevision: desired.revision, desired: summary(desired), operation: summary(selected, exact),
        lastApplied: lastSelection && last ? summary(lastSelection, last) : null, runtime };
    },
    receipt(hash: string, offset: number): ReceiptChunk {
      if (invalid) throw new Error('Invalid selection journal');
      const selection = [...selections.values()].find(value => value.receiptDigest === hash);
      if (!selection) throw new SelectionRefusal('unknown-receipt');
      const bytes = selection.receipt, next = Math.min(bytes.length, offset + 8192);
      if (offset >= bytes.length) throw new SelectionRefusal('invalid-offset');
      return { digest: hash, offset, next, total: bytes.length, base64: bytes.subarray(offset, next).toString('base64') };
    },
    async close() { closed = true; await busy?.catch(() => {}); },
  };
}
export type ServerSelection = Awaited<ReturnType<typeof createServerSelection>>;
