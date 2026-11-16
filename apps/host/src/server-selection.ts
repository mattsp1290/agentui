import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { canonicalJson } from '@agentui/contracts';
import { count, hex, identifier, record } from '@agentui/contracts/decode';
import { parseServerCustomizationArtifact } from '@agentui/host/customization';
import type { ServerExtensionReplacement, ServerExtensionStatus } from '@agentui/host/extensions';
import type { AccessDatabase } from './access-database.js';
import { normalizeProviderInstallations } from './provider-credentials.js';
import { prepareProviderExtensions } from './provider-extensions.js';
import type { BrowserProviderExtension } from './provider-extensions.js';
import { RECEIPT_LIMIT, parseBootOutcome, parseSelection, parseSelectionCommand } from './selection-protocol.js';
import type { ArtifactPin, BootOutcome, OperationSummary, SelectionCommand, SelectionRuntime, SelectionStatus, ReceiptChunk } from './selection-protocol.js';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
type Selection = { readonly id: string; readonly revision: number; readonly intent: string; readonly receipt: Buffer; readonly receiptDigest: string;
  readonly target: ReturnType<typeof parseSelection>; readonly grantsDigest: string };
export class SelectionRefusal extends Error {
  constructor(reason: 'unavailable' | 'id-conflict' | 'revision-conflict' | 'busy' | 'receipt-too-large' | 'unknown-operation' | 'unknown-receipt' | 'invalid-offset') { super(`Selection ${reason}`); }
}
type Boot = { readonly id: string; readonly selection: string; outcome: BootOutcome };
export type ExtensionStartup = { readonly kind: 'transient'; readonly entries: readonly BrowserProviderExtension[] }
  | { readonly kind: 'durable-artifacts'; readonly entries: readonly (Extract<BrowserProviderExtension, { kind: 'artifact' }>)[] };

export async function createServerSelection(deps: { readonly database: AccessDatabase; readonly entries: Extract<ExtensionStartup, { kind: 'durable-artifacts' }>['entries'];
  readonly replace: (entries: readonly BrowserProviderExtension[]) => Promise<ServerExtensionReplacement>;
  readonly runtime: () => ServerExtensionStatus; readonly isClosing: () => boolean }) {
  const db = deps.database.database, bootId = randomUUID();
  const grants = deps.entries.flatMap(entry => entry.installations);
  const normalized = [...new Set(grants.map(grant => grant.instance.namespace))].flatMap(namespace =>
    normalizeProviderInstallations(namespace, grants.filter(grant => grant.instance.namespace === namespace)));
  const grantsDigest = digest(canonicalJson(normalized.map(grant => ({ id: grant.id, instance: grant.instance, service: grant.service,
    expectedAuthority: grant.expectedAuthority, authentication: grant.authentication.kind === 'secret'
      ? { kind: 'secret', revision: grant.authentication.revision } : { kind: 'unauthenticated' } })).sort((a, b) => canonicalJson(a) < canonicalJson(b) ? -1 : canonicalJson(a) > canonicalJson(b) ? 1 : 0)));
  const selections = new Map<string, Selection>(), boots: Boot[] = [];
  let desired: Selection | undefined, invalid = false, busy: Promise<unknown> | undefined, closed = false;
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
  function persistBoot(boot: Boot, outcome: BootOutcome) {
    if (db.prepare('UPDATE service_extension_boots SET outcome=? WHERE id=?').run(canonicalJson(outcome), boot.id).changes !== 1) throw new Error('Selection journal write failed');
    boot.outcome = outcome;
  }
  try {
    transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS service_extension_selection_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, host TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS service_extension_selections (id TEXT PRIMARY KEY, revision INTEGER NOT NULL UNIQUE, intent TEXT NOT NULL, receipt TEXT NOT NULL, digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS service_extension_boots (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, selection TEXT NOT NULL REFERENCES service_extension_selections(id), outcome TEXT NOT NULL);`);
      db.prepare('INSERT OR IGNORE INTO service_extension_selection_schema VALUES(1,1,?)').run(deps.database.hostId);
      const schema = db.prepare('SELECT * FROM service_extension_selection_schema').all();
      if (schema.length !== 1 || schema[0]?.version !== 1 || schema[0]?.host !== deps.database.hostId) throw new Error();
      for (const row of db.prepare('SELECT * FROM service_extension_selections ORDER BY revision').all()) {
        const selection = decodeSelection(row);
        if (selection.revision !== selections.size) throw new Error();
        selections.set(selection.id, selection); desired = selection;
      }
      for (const row of db.prepare('SELECT * FROM service_extension_boots ORDER BY sequence').all()) {
        const boot = { id: identifier(row.id), selection: identifier(row.selection, 96), outcome: parseBootOutcome(JSON.parse(identifier(row.outcome))) };
        if (!selections.has(boot.selection)) throw new Error();
        boots.push(boot);
        if (boot.outcome.kind === 'pending' || boot.outcome.kind === 'applying') persistBoot(boot, { kind: 'interrupted' });
      }
    });
  } catch { invalid = true; }
  async function preflight(pins: readonly ArtifactPin[], classify?: (failure: 'load' | 'authorization') => void) {
    const entries = pins.map(pin => ({ ...pin, kind: 'artifact' as const, installations: [] }));
    return prepareProviderExtensions(entries, classify, normalized);
  }
  async function accept(command: SelectionCommand, initial = false): Promise<OperationSummary> {
    if (invalid || closed || deps.isClosing()) throw new SelectionRefusal('unavailable');
    const intent = canonicalJson(command), existing = selections.get(command.id);
    if (existing) {
      if (existing.intent !== intent) throw new SelectionRefusal('id-conflict');
      return summary(existing);
    }
    if (busy) throw new SelectionRefusal('busy');
    if (!initial && command.expectedRevision !== desired?.revision) throw new SelectionRefusal('revision-conflict');
    const work = Promise.resolve().then(async () => {
      const prepared = await preflight(command.selection.artifacts);
      const receipt = canonicalJson({ version: 1, hostId: deps.database.hostId, selection: command.selection, grantsDigest,
        manifests: prepared.map(item => item.verified.manifest) });
      if (Buffer.byteLength(receipt) > RECEIPT_LIMIT) throw new SelectionRefusal('receipt-too-large');
      const revision = initial ? 0 : count(command.expectedRevision + 1);
      const selection: Selection = { id: command.id, revision, intent, receipt: Buffer.from(receipt), receiptDigest: digest(receipt), target: command.selection, grantsDigest };
      transaction(() => {
        if (closed || deps.isClosing()) throw new SelectionRefusal('unavailable');
        const storedRevision = db.prepare('SELECT MAX(revision) AS revision FROM service_extension_selections').get()?.revision ?? -1;
        if (storedRevision !== (initial ? -1 : command.expectedRevision)) throw new SelectionRefusal('revision-conflict');
        if (db.prepare('INSERT INTO service_extension_selections VALUES(?,?,?,?,?)').run(selection.id, revision, intent, receipt, selection.receiptDigest).changes !== 1) throw new Error('Selection journal write failed');
      });
      selections.set(selection.id, selection); desired = selection;
      return summary(selection);
    });
    busy = work;
    try { return await work; } finally { busy = undefined; }
  }
  function summary(selection: Selection, attempt = boots.findLast(boot => boot.selection === selection.id)): OperationSummary {
    return { id: selection.id, revision: selection.revision, receiptDigest: selection.receiptDigest, artifacts: selection.target.artifacts.length,
      bootId: attempt?.id ?? null, outcome: attempt?.outcome ?? { kind: selection === desired ? 'staged' : 'superseded' } };
  }
  if (!invalid && !desired) await accept({ id: 'startup', expectedRevision: 0, selection: { version: 1,
    artifacts: deps.entries.map(({ directory, artifactId }) => ({ directory: resolve(directory), artifactId })) } }, true);
  async function activate(): Promise<void> {
    if (invalid || !desired) return;
    const selection = desired, previous = boots.findLast(boot => boot.selection === selection.id);
    if (previous && previous.outcome.kind !== 'applied' && previous.outcome.kind !== 'applied-empty') return;
    const boot: Boot = { id: bootId, selection: selection.id, outcome: { kind: 'pending' } };
    if (db.prepare('INSERT INTO service_extension_boots(id,selection,outcome) VALUES(?,?,?)').run(boot.id, boot.selection, canonicalJson(boot.outcome)).changes !== 1) throw new Error('Selection journal write failed');
    boots.push(boot);
    if (selection.grantsDigest !== grantsDigest) { persistBoot(boot, { kind: 'grant-mismatch' }); return; }
    persistBoot(boot, { kind: 'applying' });
    let failure: 'load' | 'authorization' = 'load';
    let prepared;
    try { prepared = await preflight(selection.target.artifacts, value => { failure = value; }); }
    catch { persistBoot(boot, { kind: 'failed', failure, recovery: 'replace' }); return; }
    const entries = prepared.map(({ directory, verified, installations }): BrowserProviderExtension => ({
      kind: 'artifact', directory, artifactId: verified.manifest.artifactId, installations }));
    let result: ServerExtensionReplacement;
    try { result = await deps.replace(entries); }
    catch {
      persistBoot(boot, { kind: 'failed', failure: 'discovery', recovery: 'replace' });
      throw new Error('Selection observation failed');
    }
    const status = deps.runtime();
    const outcome: BootOutcome = result.kind === 'failed' ? result : result.kind === 'replaced' && !deps.isClosing() &&
      (result.generation === null ? status.kind === 'empty' : status.kind === 'active' && status.generation === result.generation)
      ? { kind: result.generation === null ? 'applied-empty' : 'applied' } : { kind: 'interrupted' };
    try { persistBoot(boot, outcome); }
    catch { running = { kind: 'uncertain' }; throw new Error('Selection persistence failed'); }
    if (outcome.kind === 'applied' || outcome.kind === 'applied-empty') running = { kind: outcome.kind === 'applied' ? 'active' : 'applied-empty', id: selection.id, revision: selection.revision, bootId };
  }
  return {
    activate, select: (command: SelectionCommand) => accept(command),
    status(id?: string): SelectionStatus {
      if (invalid || !desired) return { kind: 'journal-invalid' };
      const selected = id === undefined ? desired : selections.get(id);
      if (!selected) throw new SelectionRefusal('unknown-operation');
      const last = boots.findLast(boot => boot.outcome.kind === 'applied' || boot.outcome.kind === 'applied-empty');
      const lastSelection = last && selections.get(last.selection);
      const state = deps.runtime();
      const runtime = closed || deps.isClosing() ? { kind: 'closed' as const } : state.kind === 'active' || state.kind === 'empty' ? running : { kind: 'withheld' as const };
      return { kind: 'ready', desiredRevision: desired.revision, desired: summary(desired), operation: summary(selected),
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
