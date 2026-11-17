import type { createFrontendCoordinator } from './frontend-tools/coordinator.js';
import type { FrontendCoordinatorWriter } from './frontend-tools/coordinator.js';
import type { FrontendObservations, PreparedProviderObservations } from './frontend-observations.js';
import { migrateFrontendObservations } from './sqlite-frontend-observations.js';
import { migrateProviderCreations } from './sqlite-provider-creations.js';
import type { ProviderObservations } from './provider-observations.js';
import type { AguiOriginalRun } from '@agentui/sdk';
import { FrontendSends, FrontendAccessError } from './frontend-sends.js';
import type { FrontendSendActor } from './frontend-sends.js';
import { identifier } from '@agentui/contracts/decode';
import { parseImageId, parseUploadId } from '@agentui/contracts/image';
import type { ImageId, ImageInputCapability, UploadId } from '@agentui/contracts/image';
import { verifyImageUpload } from './image-input.js';
import { hasImage, insertImage, migrateImages, readImage } from './sqlite-images.js';
import { providerCheckpoint, providerDecision, visibleProviderDecision } from './provider-stream.js';
import type { ProviderCheckpoint, ProviderChange, ProviderStreamStore, ProviderDecision } from './provider-stream.js';
import { parseProviderCapture, providerObservation, retainProviderRun, matchProviderCommand, providerRun } from './provider-commands.js';
import type { MatchedProviderCommand, V1Command, ProviderTarget, ProviderRun, ProviderAction } from './provider-commands.js';
import { creationObservation, providerCreation, conversationInstallation } from './provider-creation.js';
import type { ConversationInstallation, ProviderInstallation, ProviderCreation, StoredCreation, CreationObservation } from './provider-creation.js';
import { randomUUID } from 'node:crypto';
import { canonicalJson, CORE_SNAPSHOT_DOCUMENT_JSON_BUDGET, JsonLimitError, foldDocument, parseCommand, parseDecision, parseDocument, parseHostEvent, parseReceipt, parseScope, sameScope } from '@agentui/contracts';
import type { ClientCommand, ConversationDocument, ConversationScope, Envelope, HostEvent, Projection, Receipt, ReceiptState, Snapshot } from '@agentui/contracts';
import { transcriptProjection } from '@agentui/contracts/conversation';
import { migrateTranscriptDatabase } from './transcript-migration.js';
import { CURRENT_DATABASE_FORMAT, openDatabase, readDatabaseFormat } from './sqlite-schema.js';
import { migrateFrontendSends, taggedKeySql, taggedHistorySql } from './sqlite-frontend-sends.js';
import { nonempty, object, integer, copyCanonicalJson } from './codec.js';
import { installation, nativeRun, output, capturedTarget, observation, captureTarget, settlementObservation, nativeObservation } from './native-execution.js';
import { settlement, isQuarantined, OUTPUT_REJECTED, CAPACITY_EXHAUSTED } from './settlement.js';
import type { HostBudgets, HostOutput, Installation, InstallationKind, SendBlock, StoredCommand } from './durable-model.js';
import { scopeKey as key, sendBlock } from './durable-model.js';

type StoreTransaction = { readonly write: boolean };

type AdmissionTarget =
  | { readonly kind: 'provider'; readonly installation: ProviderInstallation }
  | { readonly kind: 'native'; readonly installation: Installation; readonly command: V1Command };
type Observation = NonNullable<StoredCommand['observation']>;
type Admission = { kind: 'owned'; stored: StoredCommand } | { kind: 'existing'; receipt: Receipt } | { kind: 'rejected'; reason: string };
export type ResumePlan<P> = { kind: 'resume'; through: number } | { kind: 'snapshot'; snapshot: Snapshot<P> } | { kind: 'refused' | 'resync'; reason: string };
function json(value: unknown): unknown { return JSON.parse(nonempty(value)); }
class AdmissionError extends Error {}
class OutputApplicationError extends Error {}
export class CapacityError extends Error {}
const QUARANTINE_RECEIPT_GROWTH_BYTES = 128;

export class SqliteStore<E, P> implements ProviderStreamStore {
  readonly db;
  readonly frontendSends: FrontendSends;
  private frontendCoordinator: ReturnType<typeof createFrontendCoordinator> | undefined;
  private activeTransaction: StoreTransaction | undefined;
  onCommit: (() => void) | undefined;
  constructor(path: string, readonly projection: Projection<E, P>, readonly limits: HostBudgets) {
    this.db = openDatabase(path);
    this.frontendSends = new FrontendSends(this.db);
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
      this.db.exec(`CREATE TABLE IF NOT EXISTS provider_creations (
        host TEXT NOT NULL, conversation TEXT NOT NULL, original TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','attempted','observed')), observation TEXT,
        PRIMARY KEY(host, conversation));
        CREATE TABLE IF NOT EXISTS provider_checkpoints (
          host TEXT NOT NULL, conversation TEXT NOT NULL, original TEXT NOT NULL, data TEXT NOT NULL, floor INTEGER NOT NULL,
          PRIMARY KEY(host, conversation), FOREIGN KEY(host, conversation) REFERENCES conversations(host, conversation));
        CREATE TABLE IF NOT EXISTS provider_event_ids (
          host TEXT NOT NULL, conversation TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(host, conversation, id), FOREIGN KEY(host, conversation) REFERENCES provider_checkpoints(host, conversation));`);
      this.transaction(() => {
        const format = readDatabaseFormat(this.db, 2);
        migrateImages(this.db);
        migrateFrontendSends(this.db, format);
        migrateFrontendObservations(this.db, format);
        migrateProviderCreations(this.db, format);
        if (format !== CURRENT_DATABASE_FORMAT) this.db.exec(`PRAGMA user_version=${CURRENT_DATABASE_FORMAT}`);
      });
    } catch (error) { this.db.close(); throw error; }
  }
  hasFrontendObservations(scope: ConversationScope): boolean {
    return !!this.db.prepare(`SELECT 1 FROM commands WHERE host=? AND conversation=?
      AND json_extract(target,'$.operation.observationProtocol')='ag-ui-v1' LIMIT 1`).get(...key(scope));
  }
  uploadImage(scope: ConversationScope, uploader: string, uploadId: UploadId, name: string, bytes: Uint8Array, imageInput: ImageInputCapability) {
    const target = parseScope(scope), owner = identifier(uploader), upload = parseUploadId(uploadId);
    const verified = verifyImageUpload(name, bytes);
    return this.transaction(() => insertImage(this.db, target, owner, upload, verified, imageInput));
  }
  readImage(scope: ConversationScope, imageId: ImageId) {
    return this.transaction(() => readImage(this.db, parseScope(scope), parseImageId(imageId)), false);
  }
  close(): void { this.db.close(); }
  private coordinator(factory: typeof createFrontendCoordinator): ReturnType<typeof createFrontendCoordinator> {
    return this.frontendCoordinator ??= factory(this);
  }
  frontendTools(factory: typeof createFrontendCoordinator, authorized: (scope: ConversationScope) => ConversationScope) {
    return this.coordinator(factory).tools(authorized);
  }
  frontendWriter(transaction: StoreTransaction, scope: ConversationScope, factory: typeof createFrontendCoordinator): FrontendCoordinatorWriter {
    const check = () => {
      if (transaction !== this.activeTransaction || !transaction.write || !this.db.isTransaction) throw new Error('Inactive frontend write transaction');
    };
    check();
    const boundScope = parseScope(scope), coordinator = this.coordinator(factory);
    return {
      progress: key => { check(); return coordinator.progress(boundScope, key); },
      block: key => { check(); coordinator.block(boundScope, key); },
      register: registration => { check(); coordinator.register(boundScope, registration); },
      observe: (key, observation) => { check(); return coordinator.observe(boundScope, key, observation); },
    };
  }
  transaction<T>(work: (transaction: StoreTransaction) => T, write = true): T {
    this.db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    const transaction = Object.freeze({ write });
    this.activeTransaction = transaction;
    let result: T;
    try { result = work(transaction); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.activeTransaction = undefined; }
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
      if (this.creation(scope)) throw new Error('Provider creation already reserved');
      this.insertConversation(scope, installed);
    });
  }
  private insertConversation(scope: ConversationScope, installed: ConversationInstallation): void {
    const existing = this.db.prepare('SELECT installation FROM conversations WHERE host=? AND conversation=?').get(...key(scope));
    if (existing) {
      if (existing.installation !== canonicalJson(installed)) throw new Error('Installation is immutable');
      return;
    }
    const initial = { domain: this.projection.initial(), receipts: {}, decisions: {} };
    const document = this.encodeDocument(scope, initial);
    this.db.prepare('INSERT INTO conversations(host, conversation, installation, head, version, document, bytes) VALUES (?, ?, ?, 0, ?, ?, ?)')
      .run(...key(scope), canonicalJson(installed), this.projection.version, document, Buffer.byteLength(document));
  }
  creation(scope: ConversationScope): StoredCreation | null {
    const row = this.db.prepare('SELECT original, status, observation FROM provider_creations WHERE host=? AND conversation=?').get(...key(scope));
    if (!row) return null;
    const original = providerCreation(json(row.original), scope);
    if (row.status !== 'reserved' && row.status !== 'attempted' && row.status !== 'observed') throw new Error('Invalid creation status');
    const observation = row.observation === null ? null : creationObservation(json(row.observation), original);
    if ((row.status === 'observed') !== (observation !== null)) throw new Error('Invalid creation status');
    return { ...original, status: row.status, observation };
  }
  reserveCreation(original: ProviderCreation): void {
    this.transaction(() => {
      const scope = original.intent.scope;
      if (this.creation(scope) || this.findInstallation(scope)) throw new Error('Creation already reserved');
      const encoded = canonicalJson(providerCreation(original, scope));
      this.db.prepare("INSERT INTO provider_creations(host,conversation,original,status) VALUES(?,?,?,'reserved')").run(...key(scope), encoded);
    });
  }
  attemptCreation(original: ProviderCreation): void {
    this.transaction(() => {
      const row = this.db.prepare('SELECT original, status FROM provider_creations WHERE host=? AND conversation=?').get(...key(original.intent.scope));
      if (row?.original !== canonicalJson(original) || row.status !== 'reserved') throw new Error('Creation intent changed');
      this.db.prepare("UPDATE provider_creations SET status='attempted' WHERE host=? AND conversation=?").run(...key(original.intent.scope));
    });
  }
  settleCreation(original: ProviderCreation, value: CreationObservation): CreationObservation {
    return this.transaction(() => {
      const scope = original.intent.scope, current = this.creation(scope);
      if (!current || canonicalJson({ installation: current.installation, intent: current.intent, credential: current.credential }) !== canonicalJson(original)) {
        throw new Error('Creation intent changed');
      }
      if (current.observation && ['confirmed', 'rejected', 'not-dispatched'].includes(current.observation.kind)) return current.observation;
      const observed = creationObservation(value, original);
      if (current.observation?.kind === 'pending' && observed.kind === 'uncertain') return current.observation;
      if (observed.kind === 'confirmed') this.insertConversation(scope, original.installation);
      this.db.prepare("UPDATE provider_creations SET status='observed', observation=? WHERE host=? AND conversation=?")
        .run(canonicalJson(observed), ...key(scope));
      return observed;
    });
  }
  providerCheckpoint(original: ProviderCreation): ProviderCheckpoint | null {
    const row = this.db.prepare('SELECT original, data FROM provider_checkpoints WHERE host=? AND conversation=?').get(...key(original.intent.scope));
    if (!row) return null;
    if (row.original !== canonicalJson(original)) throw new Error('Provider checkpoint association changed');
    return providerCheckpoint(json(row.data));
  }
  prepareProviderObservations<I extends string>(original: ProviderCreation, event: { readonly id: string; readonly payload: string } | null,
    factory: typeof FrontendObservations, describe: (original: AguiOriginalRun<string>) => AguiOriginalRun<I>, map: (originals: readonly AguiOriginalRun<I>[]) => ProviderObservations):
    { readonly kind: 'duplicate'; readonly checkpoint: ProviderCheckpoint } | { readonly kind: 'prepared'; readonly value: PreparedProviderObservations } {
    if (event) {
      const prior = this.db.prepare('SELECT payload FROM provider_event_ids WHERE host=? AND conversation=? AND id=?').get(...key(original.intent.scope), event.id);
      if (prior) {
        const current = this.providerCheckpoint(original);
        if (prior.payload !== event.payload || !current) throw new Error('Conflicting provider event');
        return { kind: 'duplicate', checkpoint: current };
      }
    }
    return { kind: 'prepared', value: { factory, payload: new factory(this).prepare(original, describe, map) } };
  }
  commitProvider(original: ProviderCreation, expected: number | null,
    event: { readonly id: string; readonly payload: string } | null, render: () => ProviderChange,
    prepared?: PreparedProviderObservations): ProviderCheckpoint {
    if (!prepared && this.hasFrontendObservations(original.intent.scope)) throw new Error('Observation preparation required');
    return this.transaction(transaction => {
      const scope = original.intent.scope, creation = this.creation(scope);
      if (this.projection !== transcriptProjection || creation?.observation?.kind !== 'confirmed' ||
        canonicalJson({ installation: creation.installation, intent: creation.intent, credential: creation.credential }) !== canonicalJson(original)) {
        throw new Error('Provider observation association changed');
      }
      const current = this.providerCheckpoint(original);
      if (event) {
        const prior = this.db.prepare('SELECT payload FROM provider_event_ids WHERE host=? AND conversation=? AND id=?').get(...key(scope), event.id);
        if (prior) {
          if (prior.payload !== event.payload || !current) throw new Error('Conflicting provider event');
          return current;
        }
      }
      if ((current?.revision ?? null) !== expected) throw new Error('Provider checkpoint advanced');
      const change = render();
      if (canonicalJson(this.creation(scope)) !== canonicalJson(creation) || (this.providerCheckpoint(original)?.revision ?? null) !== expected) throw new Error('Provider observation changed during render');
      if (prepared) new prepared.factory(this).commit(original, prepared.payload, transaction);
      for (const run of change.runs) this.writeProviderRun(scope, run);
      const requireRun = (runId: string) => {
        if (!this.db.prepare('SELECT 1 FROM runs WHERE host=? AND conversation=? AND id=?').get(...key(scope), runId)) throw new Error('Provider run is missing');
      };
      let floor = integer(this.db.prepare('SELECT floor FROM provider_checkpoints WHERE host=? AND conversation=?').get(...key(scope))?.floor ?? 0);
      if (change.output.kind === 'snapshot') {
        const snapshot = this.snapshot(scope), decisions = new Map<string, ReturnType<typeof parseDecision>>();
        for (const pending of change.output.decisions) {
          const id = pending.visible.pendingId, data = canonicalJson(pending);
          const prior = this.db.prepare('SELECT data, status FROM pending_decisions WHERE host=? AND conversation=? AND id=?').get(...key(scope), id);
          let retained = pending;
          if (prior && prior.data !== data) {
            const previous = providerDecision(json(prior.data), creation.observation.binding, original.installation);
            if (canonicalJson(previous.reference) !== canonicalJson(pending.reference) ||
              previous.visible.runId !== pending.visible.runId) throw new Error('Provider decision changed');
            if (prior.status === 'open') {
              this.db.prepare('UPDATE pending_decisions SET data=? WHERE host=? AND conversation=? AND id=?').run(data, ...key(scope), id);
            } else retained = previous;
          }
          requireRun(pending.visible.runId);
          if (!prior) this.db.prepare("INSERT INTO pending_decisions(host, conversation, id, run, data, status, operation) VALUES (?, ?, ?, ?, ?, 'open', NULL)")
            .run(...key(scope), id, pending.visible.runId, data);
          if (prior?.status !== 'closed') decisions.set(id, visibleProviderDecision(retained, prior?.status === 'reserved'));
        }
        for (const row of this.db.prepare("SELECT id FROM pending_decisions WHERE host=? AND conversation=? AND status='open'").all(...key(scope))) {
          const id = nonempty(row.id);
          if (!decisions.has(id)) this.db.prepare("UPDATE pending_decisions SET status='closed' WHERE host=? AND conversation=? AND id=?").run(...key(scope), id);
        }
        const transcript = change.output.transcript;
        if (transcript.currentRun) requireRun(transcript.currentRun.runId);
        for (const activity of transcript.activities ?? []) requireRun(activity.runId);
        const document = this.encodeDocument(scope, { ...snapshot.document, domain: this.projection.decodeState(transcript), decisions: Object.fromEntries(decisions) });
        floor = snapshot.cursor + 1;
        if (!Number.isSafeInteger(floor)) throw new Error('Host cursor exhausted');
        this.db.prepare('UPDATE conversations SET head=?, document=?, bytes=? WHERE host=? AND conversation=?')
          .run(floor, document, Buffer.byteLength(document), ...key(scope));
      } else {
        for (const event of change.output.events) {
          if ('runId' in event) requireRun(event.runId);
          if (event.kind === 'command-updated' || event.kind === 'file-change-updated') requireRun(event.activity.runId);
        }
        this.appendEvents(scope, change.output.events.map(event => ({ kind: 'domain', event: this.projection.decodeEvent(event) })));
      }
      const next = providerCheckpoint({ ...change.checkpoint, revision: (current?.revision ?? 0) + 1 });
      const data = canonicalJson(next);
      if (Buffer.byteLength(data) > this.limits.snapshotBytes) throw new CapacityError('Provider state exceeds snapshot budget');
      this.db.prepare('INSERT INTO provider_checkpoints(host, conversation, original, data, floor) VALUES (?, ?, ?, ?, ?) ON CONFLICT(host, conversation) DO UPDATE SET data=excluded.data, floor=excluded.floor')
        .run(...key(scope), canonicalJson(original), data, floor);
      if (event) this.db.prepare('INSERT INTO provider_event_ids(host, conversation, id, payload) VALUES (?, ?, ?, ?)').run(...key(scope), event.id, event.payload);
      return next;
    });
  }
  listConversations(hostId: string, after: string | null, limit: number): readonly ConversationScope[] {
    return this.db.prepare('SELECT host, conversation FROM conversations WHERE host=? AND conversation>? ORDER BY conversation LIMIT ?')
      .all(hostId, after ?? '', limit)
      .map(row => parseScope({ hostId: row.host, conversationId: row.conversation }));
  }
  snapshot(scope: ConversationScope): Snapshot<P> {
    const row = this.conversation(scope), cursor = integer(row.head);
    let document = parseDocument(json(row.document), value => this.projection.decodeState(value), scope, cursor);
    const original = this.creation(scope);
    if (original?.observation?.kind === 'confirmed') {
      const binding = original.observation.binding;
      const decisions = Object.keys(document.decisions).flatMap(id => {
        const pending = this.db.prepare('SELECT data, status FROM pending_decisions WHERE host=? AND conversation=? AND id=?').get(...key(scope), id);
        if (!pending || pending.status === 'closed') return [];
        const parsed = providerDecision(json(pending.data), binding, original.installation);
        return [[id, visibleProviderDecision(parsed, pending.status === 'reserved')]];
      });
      document = { ...document, decisions: Object.fromEntries(decisions) };
    }
    return { scope, projectionVersion: this.projection.version, cursor, document };
  }
  findInstallation(scope: ConversationScope): ConversationInstallation | null {
    const row = this.db.prepare('SELECT installation FROM conversations WHERE host=? AND conversation=?').get(...key(scope));
    return row ? conversationInstallation(json(row.installation)) : null;
  }
  inspect(scope: ConversationScope): { readonly installation: ConversationInstallation; readonly snapshot: Snapshot<P> } {
    return { installation: conversationInstallation(json(this.conversation(scope).installation)), snapshot: this.snapshot(scope) };
  }
  head(scope: ConversationScope): number {
    const row = this.db.prepare('SELECT head, version FROM conversations WHERE host=? AND conversation=?').get(...key(scope));
    if (!row || row.version !== this.projection.version) throw new Error('Unknown or incompatible conversation');
    return integer(row.head);
  }
  command(scope: ConversationScope, id: string): StoredCommand | null {
    const row = this.db.prepare('SELECT intent, target, observation, receipt FROM commands WHERE host=? AND conversation=? AND id=?').get(...key(scope), id);
    if (!row) return null;
    const command = parseCommand(json(row.intent)), rawTarget = json(row.target);
    const capture = object(rawTarget).kind === 'provider' ? parseProviderCapture(rawTarget, scope) : null;
    const target = capture ? capture.target : capturedTarget(rawTarget, scope);
    const parsedReceipt = parseReceipt(json(row.receipt));
    if (!sameScope(command.scope, scope) || command.clientCommandId !== id || parsedReceipt.hostOperationId !== ('kind' in target ? target.operation.operationId : target.identity.hostOperationId)) throw new Error('Corrupt command');
    if (capture) {
      const matched = matchProviderCommand(capture, command);
      return { kind: 'provider', ...matched, receipt: parsedReceipt,
        observation: row.observation === null ? null : providerObservation(json(row.observation), capture) };
    }
    if ('kind' in target || command.version !== 1) throw new Error('Invalid native command target');
    return { command, target, receipt: parsedReceipt,
      observation: row.observation === null ? null : observation(json(row.observation), target) };
  }
  blockingSend(scope: ConversationScope, kind: InstallationKind): { readonly stored: StoredCommand; readonly block: Exclude<SendBlock, 'none'> } | null {
    const rows = this.db.prepare("SELECT id FROM commands WHERE host=? AND conversation=? AND json_extract(intent, '$.body.kind')='send' AND json_extract(receipt, '$.state.kind') IN ('pending','accepted','uncertain') ORDER BY rowid").all(...key(scope));
    for (const row of rows) {
      const stored = this.command(scope, nonempty(row.id));
      const block = stored ? sendBlock(kind, stored) : 'none';
      if (stored && block !== 'none') return { stored, block };
    }
    return null;
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
  private reserveTaggedRun(capture: MatchedProviderCommand, encodedTarget: string): void {
    const { agui: run, command } = capture;
    if (run === null) return;
    if (!this.db.prepare(`SELECT 1 FROM (SELECT ? AS target) WHERE ${taggedKeySql}`)
      .get(encodedTarget, run.threadId, run.runId)) throw new AdmissionError('provider-command-unavailable');
    const parts = [...key(command.scope), run.threadId, run.runId] as const;
    if ((command.version === 2 && this.db.prepare(taggedHistorySql).get(...parts))
      || this.db.prepare('SELECT 1 FROM frontend_send_owners WHERE host=? AND conversation=? AND thread_id=? AND run_id=?')
        .get(...parts)) throw new AdmissionError('frontend-run-reused');
  }
  admit(command: ClientCommand, capability: { readonly kind: 'supported' } | { readonly kind: 'unsupported'; readonly reason: string }, expectedInstallation?: Installation, captureProvider?: (original: StoredCreation, operationId: string, action: ProviderAction) => ProviderTarget, actor?: FrontendSendActor): Admission {
    try { return this.transaction((): Admission => {
      const existing = this.command(command.scope, command.clientCommandId);
      this.frontendSends.admission(command, existing, actor);
      if (existing) return canonicalJson(existing.command) === canonicalJson(command)
        ? { kind: 'existing', receipt: existing.receipt }
        : { kind: 'rejected', reason: 'command-id-conflict' };
      if (Buffer.byteLength(canonicalJson(command)) > this.limits.maxCommandBytes) return { kind: 'rejected', reason: 'command-too-large' };
      if (!this.db.prepare('SELECT 1 FROM conversations WHERE host=? AND conversation=?').get(...key(command.scope))) return { kind: 'rejected', reason: 'unknown-conversation' };
      const scope = command.scope, installed = conversationInstallation(json(this.conversation(scope).installation));
      if (expectedInstallation && canonicalJson(installed) !== canonicalJson(expectedInstallation)) {
        return { kind: 'rejected', reason: 'This conversation belongs to a different agent or workspace. Restart its original host to continue.' };
      }
      let admissionTarget: AdmissionTarget;
      if ('kind' in installed) admissionTarget = { kind: 'provider', installation: installed };
      else if (command.version === 1) admissionTarget = { kind: 'native', installation: installed, command };
      else return { kind: 'rejected', reason: 'frontend-offers-unsupported' };
      if (command.body.kind === 'revoke-permission' && !('kind' in installed)) return { kind: 'rejected', reason: 'permission-management-unsupported' };
      if (capability.kind === 'unsupported') return { kind: 'rejected', reason: capability.reason };
      if ('kind' in installed && !captureProvider) return { kind: 'rejected', reason: 'provider-command-unavailable' };
      const imageId = command.version === 1 && command.body.kind === 'send' ? command.body.imageId : undefined;
      if (imageId !== undefined && !hasImage(this.db, scope, imageId)) return { kind: 'rejected', reason: 'This image is not available in this conversation. Attach it again.' };
      let run = null, pending = null;
      if (command.body.kind === 'approve' && !('kind' in installed)) {
        const row = this.db.prepare('SELECT data, status FROM pending_decisions WHERE host=? AND conversation=? AND id=?')
          .get(...key(scope), command.body.pendingId);
        if (!row || row.status !== 'open') return { kind: 'rejected', reason: 'decision-unavailable' };
        const data = object(json(row.data));
        pending = { visible: parseDecision(data.visible), continuation: copyCanonicalJson(data.continuation) };
        if (!pending.visible.choices.includes(command.body.choiceId)) return { kind: 'rejected', reason: 'invalid-choice' };
      }
      const runId = command.body.kind === 'cancel' ? command.body.runId : pending?.visible.runId;
      if (runId && !('kind' in installed)) {
        const row = this.db.prepare('SELECT data FROM runs WHERE host=? AND conversation=? AND id=?').get(...key(scope), runId);
        if (!row) return { kind: 'rejected', reason: 'unknown-run' };
        run = nativeRun(json(row.data), installed, scope);
      } else if (command.body.kind === 'send') {
        if (this.blockingSend(scope, admissionTarget.kind)) return { kind: 'rejected', reason: 'send-awaiting-confirmation' };
        const row = this.db.prepare('SELECT data FROM runs WHERE host=? AND conversation=? ORDER BY rowid DESC LIMIT 1').get(...key(scope));
        if (row && !('kind' in installed)) run = nativeRun(json(row.data), installed, scope);
      }
      const operation = randomUUID();
      const admitted: Receipt = { scope, clientCommandId: command.clientCommandId, hostOperationId: operation,
        sequence: this.head(scope) + 1, state: { kind: 'pending' } };
      this.appendEvents(scope, [{ kind: 'receipt', receipt: admitted }]);
      let stored: StoredCommand;
      let providerPending: ProviderDecision | null = null;
      if (admissionTarget.kind === 'provider') {
        const providerInstallation = admissionTarget.installation;
        const original = this.creation(scope);
        if (!original || original.observation?.kind !== 'confirmed' || !captureProvider ||
          canonicalJson(original.installation) !== canonicalJson(providerInstallation)) throw new AdmissionError('provider-creation-unavailable');
        let action: ProviderAction;
        if (command.body.kind === 'revoke-permission') action = command.body;
        else if (command.body.kind === 'send') action = { kind: 'send', text: command.body.text,
          ...(command.version === 2 ? { frontend: command.body.frontend } : {}) };
        else {
          if (command.body.kind === 'approve') {
            const row = this.db.prepare('SELECT data, status FROM pending_decisions WHERE host=? AND conversation=? AND id=?').get(...key(scope), command.body.pendingId);
            if (!row || row.status !== 'open') throw new AdmissionError('decision-unavailable');
            providerPending = providerDecision(json(row.data), original.observation.binding, providerInstallation);
          }
          const runId = command.body.kind === 'cancel' ? command.body.runId : providerPending?.visible.runId;
          const row = this.db.prepare('SELECT data FROM runs WHERE host=? AND conversation=? AND id=?').get(...key(scope), runId ?? '');
          if (!row) throw new AdmissionError('unknown-run');
          const saved = object(json(row.data)), run = providerRun(saved.reference, original.observation.binding, providerInstallation);
          if (canonicalJson(saved) !== canonicalJson(run) || run.identity.runId !== runId) throw new AdmissionError('provider-run-mismatch');
          if (command.body.kind === 'cancel') action = { kind: 'cancel', run: run.reference };
          else {
            const choiceId = command.body.choiceId, choice = providerPending?.choices.find(choice => choice.id === choiceId);
            if (!choice || !providerPending) throw new AdmissionError('invalid-choice');
            action = { kind: 'decide', run: run.reference, decision: providerPending.reference, choice: choice.reference };
          }
        }
        let capture: MatchedProviderCommand;
        try { capture = matchProviderCommand(parseProviderCapture(captureProvider(original, operation, action), scope), command); }
        catch { throw new AdmissionError('provider-command-unavailable'); }
        const target = capture.target;
        if (canonicalJson(target.installation) !== canonicalJson(providerInstallation) || canonicalJson(target.credential) !== canonicalJson(original.credential) ||
          canonicalJson(target.operation.binding) !== canonicalJson(original.observation.binding) || target.operation.operationId !== operation) throw new AdmissionError('provider-target-mismatch');
        const encodedTarget = canonicalJson(target);
        if (Buffer.byteLength(encodedTarget) > this.limits.maxCommandBytes) throw new AdmissionError('command-too-large');
        this.reserveTaggedRun(capture, encodedTarget);
        this.frontendSends.admitCapture(capture, actor);
        stored = { kind: 'provider', ...capture, receipt: admitted, observation: null };
      } else {
        stored = { command: admissionTarget.command, target: captureTarget({ installation: admissionTarget.installation, run, decision: pending }, operation), receipt: admitted, observation: null };
      }
      this.db.prepare('INSERT INTO commands(host, conversation, id, operation, intent, target, observation, receipt) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
        .run(...key(scope), command.clientCommandId, operation, canonicalJson(command), canonicalJson(stored.target), canonicalJson(admitted));
      if (imageId !== undefined) this.db.prepare('INSERT INTO command_images(host, conversation, command, image) VALUES (?, ?, ?, ?)')
        .run(...key(scope), command.clientCommandId, imageId);
      if (providerPending) {
        this.db.prepare("UPDATE pending_decisions SET status='reserved', operation=? WHERE host=? AND conversation=? AND id=?")
          .run(operation, ...key(scope), providerPending.visible.pendingId);
        this.appendEvents(scope, [{ kind: 'decision-opened', decision: visibleProviderDecision(providerPending, true) }]);
      }
      if (pending) this.db.prepare("UPDATE pending_decisions SET status='reserved', operation=? WHERE host=? AND conversation=? AND id=?")
        .run(operation, ...key(scope), pending.visible.pendingId);
      return { kind: 'owned', stored };
    }); } catch (error) {
      if (error instanceof AdmissionError || error instanceof FrontendAccessError) return { kind: 'rejected', reason: error.message };
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
  settle(scope: ConversationScope, id: string, value: Observation, observations?: typeof FrontendObservations): Receipt {
    return this.transaction(transaction => {
      const stored = this.command(scope, id);
      if (!stored) throw new Error('Unknown command');
      if ('kind' in stored) {
        if (stored.target.operation.kind === 'send' && stored.target.operation.observationProtocol && !observations) throw new Error('Observation settlement required');
        const transition = settlement(stored.observation, retainProviderRun(providerObservation(value, stored), stored.observation), { quarantined: isQuarantined(stored) });
        let receipt: Receipt;
        switch (transition.kind) {
          case 'keep': receipt = stored.receipt; break;
          case 'conflict': throw new Error(`Conflicting ${transition.reason}`);
          case 'record-evidence': this.writeObservation(stored, transition.observed); receipt = stored.receipt; break;
          case 'apply': receipt = this.applyObservation(stored, transition.observed); break;
        }
        if (observations) new observations(this).materialize(scope, id, transaction);
        return receipt;
      }
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
  private writeProviderRun(scope: ConversationScope, run: ProviderRun): void {
    const encoded = canonicalJson(run), id = run.identity.runId;
    const existing = this.db.prepare('SELECT data FROM runs WHERE host=? AND conversation=? AND id=?').get(...key(scope), id);
    if (existing && existing.data !== encoded) throw new OutputApplicationError('Run reference is immutable');
    if (!existing) this.db.prepare('INSERT INTO runs(host, conversation, id, data) VALUES (?, ?, ?, ?)').run(...key(scope), id, encoded);
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
        case 'pending': state = { kind: 'pending' }; break;
        case 'accepted': state = { kind: 'accepted' }; break;
        case 'conclusive':
          state = observed.result.kind !== 'rejected' ? { kind: 'completed' } : { kind: 'rejected', reason: observed.result.reason };
          if (observed.result.kind === 'completed' && !('kind' in stored)) events.push(...this.writeOutput(scope, observed.result.output, stored.target.installation));
          break;
      }
      if ('kind' in stored && (observed.kind === 'accepted' || observed.kind === 'conclusive') && typeof observed.evidence.source !== 'string') {
        const run = observed.evidence.source.run;
        if (run) this.writeProviderRun(scope, run);
      }
      if ('kind' in stored && stored.target.operation.kind === 'decide' && (observed.kind === 'conclusive' || observed.kind === 'not-dispatched')) {
        const pendingId = stored.target.operation.decision.ref.opaqueId;
        const decisions = this.snapshot(scope).document.decisions;
        const closed = observed.kind === 'conclusive' && observed.result.kind === 'receipt-completed';
        const present = Object.hasOwn(decisions, pendingId) ? decisions[pendingId] : undefined;
        const changed = this.db.prepare('UPDATE pending_decisions SET status=?, operation=NULL WHERE host=? AND conversation=? AND id=? AND operation=?')
          .run(closed || !present ? 'closed' : 'open', ...key(scope), pendingId, stored.receipt.hostOperationId);
        if (changed.changes) {
          if (closed || !present) events.push({ kind: 'decision-closed', pendingId });
          else {
            const { reserved: _reserved, ...released } = present;
            events.push({ kind: 'decision-opened', decision: released });
          }
        }
      }
      const pending = 'kind' in stored ? null : stored.target.decision;
      if (pending && (observed.kind === 'conclusive' || observed.kind === 'not-dispatched')) {
        const resolved = observed.kind === 'conclusive' && observed.result.kind === 'completed';
        this.db.prepare('UPDATE pending_decisions SET status=?, operation=NULL WHERE host=? AND conversation=? AND id=? AND operation=?')
          .run(resolved ? 'closed' : 'open', ...key(scope), pending.visible.pendingId, stored.receipt.hostOperationId);
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
      const floor = integer(this.db.prepare('SELECT floor FROM provider_checkpoints WHERE host=? AND conversation=?').get(...key(scope))?.floor ?? 0);
      if (after === null || after < floor || integer(totals?.count) > this.limits.replayEvents || integer(totals?.bytes) > this.limits.replayBytes) {
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
