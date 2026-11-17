import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson, JsonLimitError } from '@agentui/contracts';
import { count, hex, identifier, record } from '@agentui/contracts/decode';
import { parseGitExtensionReference, parseServerCustomizationArtifact, readServerCustomizationArtifact } from '@agentui/host/customization';
import type { GitExtensionReference, ServerCustomizationArtifact } from '@agentui/host/customization';
import type { AccessDatabase } from './access-database.js';
import { serverArtifactExpectation } from './server-artifact-runtime.js';
import { assertRefreshSelectionOwner, createServerSelection } from './server-selection.js';
import { REFRESH_SELECTION_PREFIX, SelectionRefusal, parseSelection, parseSelectionCommand, operationId, RECEIPT_LIMIT } from './selection-protocol.js';
import type { OperationSummary, RefreshAdmission, SelectionCommand, SelectionStatus } from './selection-protocol.js';

export type RefreshRequest = Readonly<{ id: string; reference: GitExtensionReference; expectedSelectionRevision: number }>;
type ReadyToolchain = Readonly<{ kind: 'ready'; node: string; entrySha256: string; lockSha256: string; builder: ServerCustomizationArtifact['builder'] }>;
type Toolchain = ReadyToolchain | { readonly kind: 'unavailable' };
export type RefreshBuildCommand = Readonly<{ id: string; requestId: string; source: GitExtensionReference; directory: string; toolchain: Toolchain }>;
export type RefreshBuildFailure = 'unavailable' | 'source' | 'build' | 'qualification' | 'publication' | 'incompatible' | 'resource-limit';
type Pin = SelectionCommand['selection']['artifacts'][number];
export type RefreshBuildResult = { readonly kind: 'failed'; readonly failure: RefreshBuildFailure }
  | { readonly kind: 'built'; readonly pin: Pin; readonly manifest: ServerCustomizationArtifact };
export type RefreshBuilder = { readonly kind: 'unavailable' } | { readonly kind: 'ready'; readonly identity: ReadyToolchain;
  run(command: RefreshBuildCommand): Promise<RefreshBuildResult>; close(): Promise<void> };
const promotionRefusals = ['source-superseded', 'refresh-intent-conflict', 'revision-conflict', 'busy', 'id-conflict', 'receipt-too-large', 'invalid-artifact'] as const;
type PromotionRefusal = typeof promotionRefusals[number];
type Promotion = { readonly kind: 'unconfirmed'; readonly command: SelectionCommand }
  | { readonly kind: 'refused'; readonly command: SelectionCommand; readonly reason: PromotionRefusal };
type Job = Readonly<{ request: RefreshRequest; ordinal: number }> & (
  { readonly build: { readonly kind: 'building' | 'interrupted'; readonly command: RefreshBuildCommand }
    | { readonly kind: 'failed'; readonly command: RefreshBuildCommand; readonly failure: RefreshBuildFailure }; readonly promotion: { readonly kind: 'not-built' } }
  | { readonly build: { readonly kind: 'built'; readonly command: RefreshBuildCommand; readonly pin: Pin; readonly manifest: ServerCustomizationArtifact };
    readonly promotion: Promotion });
type JobSummary = Pick<Job, 'request' | 'ordinal'> & (
  { readonly build: Exclude<Job['build'], { kind: 'built' }>; readonly promotion: { readonly kind: 'not-built' } }
  | { readonly build: Omit<Extract<Job['build'], { kind: 'built' }>, 'manifest'> & { readonly provenance: Pick<ServerCustomizationArtifact, 'root' | 'builder' | 'runtime' | 'sdkVersion'> };
    readonly promotion: Promotion | { readonly kind: 'selected'; readonly command: SelectionCommand; readonly operation: OperationSummary } });
export type RefreshReceipt = Readonly<{ job: JobSummary; latestRequestId: string; selectionStatus: SelectionStatus }>;
export class RefreshRefusal extends Error {
  constructor(readonly reason: 'busy' | 'id-conflict' | 'unknown-request' | 'not-built' | 'unavailable') { super(`Refresh ${reason}`); }
}
const tables = new Map([
  ['host_refresh_schema', 'singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, host TEXT NOT NULL, root TEXT NOT NULL'],
  ['host_refresh_jobs', 'ordinal INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, body TEXT NOT NULL'],
]);
const failures: readonly RefreshBuildFailure[] = ['unavailable', 'source', 'build', 'qualification', 'publication', 'incompatible', 'resource-limit'];
function failure(value: unknown): RefreshBuildFailure {
  for (const candidate of failures) if (candidate === value) return candidate;
  throw new Error('Invalid refresh failure');
}
function promotionRefusal(value: unknown): PromotionRefusal | undefined {
  return promotionRefusals.find(reason => reason === value);
}
function absolute(value: unknown): string {
  const path = identifier(value, 4096);
  if (!isAbsolute(path) || path.includes('\0') || resolve(path) !== path) throw new Error('Invalid refresh directory');
  return path;
}
export function parseRefreshRequest(value: unknown): RefreshRequest {
  const input = record(value, ['id', 'reference', 'expectedSelectionRevision']);
  if (Buffer.byteLength(canonicalJson(input)) > 4096) throw new Error('Invalid refresh request');
  const reference = parseGitExtensionReference(input.reference);
  const repository = reference.repository.startsWith('file:') ? pathToFileURL(resolve(fileURLToPath(reference.repository))).href
    : !reference.repository.includes(':') || isAbsolute(reference.repository) ? resolve(reference.repository) : reference.repository;
  const request = { id: operationId(input.id), reference: { ...reference, repository }, expectedSelectionRevision: count(input.expectedSelectionRevision) };
  if (Buffer.byteLength(canonicalJson(request)) > 4096) throw new Error('Invalid refresh request');
  return request;
}
function toolchain(value: unknown): Toolchain {
  const input = record(value);
  if (input.kind === 'unavailable') { record(input, ['kind']); return { kind: 'unavailable' }; }
  record(input, ['kind', 'node', 'entrySha256', 'lockSha256', 'builder']);
  if (input.kind !== 'ready') throw new Error('Invalid refresh toolchain');
  const builder = record(input.builder, ['identity', 'esbuildVersion']);
  return { kind: 'ready', node: absolute(input.node), entrySha256: hex(input.entrySha256, 64), lockSha256: hex(input.lockSha256, 64),
    builder: { identity: hex(builder.identity, 64), esbuildVersion: identifier(builder.esbuildVersion, 128) } };
}
function buildCommand(value: unknown): RefreshBuildCommand {
  const input = record(value, ['id', 'requestId', 'source', 'directory', 'toolchain']);
  return { id: operationId(input.id), requestId: operationId(input.requestId), source: parseGitExtensionReference(input.source),
    directory: absolute(input.directory), toolchain: toolchain(input.toolchain) };
}
function commandFor(command: RefreshBuildCommand, request: RefreshRequest, pin: Pin): SelectionCommand {
  return { id: REFRESH_SELECTION_PREFIX + command.id, expectedRevision: request.expectedSelectionRevision, selection: { version: 1, artifacts: [pin] } };
}
function assertBuild(command: RefreshBuildCommand, request: RefreshRequest, pin: Pin, manifest: ServerCustomizationArtifact): void {
  const root = manifest.packages[0];
  if (command.toolchain.kind !== 'ready' || pin.directory !== command.directory || pin.artifactId !== manifest.artifactId ||
    root?.identity !== manifest.root || root.commit !== request.reference.commit || root.subdirectory !== (request.reference.subdirectory ?? '') ||
    canonicalJson(manifest.builder) !== canonicalJson(command.toolchain.builder)) throw new Error('Invalid refresh artifact');
}
function parseJob(value: unknown, root: string): Job {
  const input = record(value, ['request', 'ordinal', 'build', 'promotion']);
  const request = parseRefreshRequest(input.request), ordinal = count(input.ordinal), build = record(input.build), promotion = record(input.promotion);
  const command = buildCommand(build.command);
  if (!ordinal || command.requestId !== request.id || canonicalJson(command.source) !== canonicalJson(request.reference) ||
    command.directory !== join(root, command.id) || command.id.length > 80) throw new Error('Invalid refresh attempt');
  if (build.kind === 'built') {
    record(build, ['kind', 'command', 'pin', 'manifest']);
    const manifest = parseServerCustomizationArtifact(build.manifest), pin = parseSelection({ version: 1, artifacts: [build.pin] }).artifacts[0];
    if (!pin) throw new Error('Invalid refresh artifact');
    assertBuild(command, request, pin, manifest);
    const saved = parseSelectionCommand(promotion.command);
    if (canonicalJson(saved) !== canonicalJson(commandFor(command, request, pin))) throw new Error('Invalid refresh promotion');
    let parsed: Promotion;
    if (promotion.kind === 'unconfirmed') { record(promotion, ['kind', 'command']); parsed = { kind: 'unconfirmed', command: saved }; }
    else {
      record(promotion, ['kind', 'command', 'reason']);
      const reason = promotionRefusal(promotion.reason);
      if (promotion.kind !== 'refused' || !reason) throw new Error('Invalid refresh promotion');
      parsed = { kind: 'refused', command: saved, reason };
    }
    return { request, ordinal, build: { kind: 'built', command, pin, manifest }, promotion: parsed };
  }
  record(promotion, ['kind']);
  if (promotion.kind !== 'not-built') throw new Error('Invalid refresh promotion');
  if (build.kind === 'failed') {
    record(build, ['kind', 'command', 'failure']);
    return { request, ordinal, build: { kind: 'failed', command, failure: failure(build.failure) }, promotion: { kind: 'not-built' } };
  }
  record(build, ['kind', 'command']);
  if (build.kind !== 'building' && build.kind !== 'interrupted') throw new Error('Invalid refresh build');
  return { request, ordinal, build: { kind: build.kind, command }, promotion: { kind: 'not-built' } };
}

export async function createRefreshController(deps: { readonly database: AccessDatabase; readonly artifactRoot: string; readonly builder: RefreshBuilder;
  readonly selection: Omit<Parameters<typeof createServerSelection>[0], 'database' | 'refreshOwnership'> }) {
  const db = deps.database.database, builder = deps.builder;
  let acquiredSelection: Awaited<ReturnType<typeof createServerSelection>> | undefined;
  try {
    const configuredRoot = absolute(deps.artifactRoot);
    await mkdir(configuredRoot, { recursive: true, mode: 0o700 });
    const root = await realpath(configuredRoot);
    const identity = toolchain(builder.kind === 'ready' ? builder.identity : { kind: 'unavailable' });
    let jobs: Job[] = [], owned = false, closed = false, broken = false;
    let closePromise: Promise<void> | undefined;
    const active = new Map<string, Promise<RefreshReceipt>>();
    function unavailable(): never {
      if (!broken) { broken = true; deps.selection.stopRuntime(); }
      throw new RefreshRefusal('unavailable');
    }
    function available(): void { if (closed || broken || deps.selection.isClosing()) throw new RefreshRefusal('unavailable'); }
    function namespace(): boolean {
      const objects = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE lower(name) GLOB 'host_refresh_*'").all();
      if (!objects.length) return false;
      if (objects.length !== tables.size || objects.some(object => typeof object.name !== 'string' || object.type !== 'table' ||
        object.sql !== `CREATE TABLE ${object.name} (${tables.get(object.name)})`)) throw new Error('Invalid refresh journal');
      const rows = db.prepare('SELECT * FROM host_refresh_schema').all(), marker = rows[0];
      if (rows.length !== 1 || marker?.singleton !== 1 || marker.version !== 1 || marker.host !== deps.database.hostId || marker.root !== root) throw new Error('Invalid refresh journal');
      if (db.prepare(`SELECT 1 FROM sqlite_schema AS t, pragma_index_list(t.name) AS i
        WHERE t.type='table' AND lower(t.name) GLOB 'host_refresh_*' AND i."unique"=1 AND i.origin='c' LIMIT 1`).get()) throw new Error('Invalid refresh journal');
      return true;
    }
    function readJobs(): Job[] {
      const result: Job[] = [], attempts = new Set<string>();
      for (const row of db.prepare('SELECT * FROM host_refresh_jobs ORDER BY ordinal').all()) {
        const body = identifier(row.body, RECEIPT_LIMIT), job = parseJob(JSON.parse(body), root);
        if (Buffer.byteLength(body) > RECEIPT_LIMIT || job.ordinal !== result.length + 1 || row.ordinal !== job.ordinal ||
          row.id !== job.request.id || canonicalJson(job) !== body || attempts.has(job.build.command.id)) throw new Error('Invalid refresh journal');
        attempts.add(job.build.command.id); result.push(job);
      }
      return result;
    }
    function assertStored(expected: readonly Job[] = jobs): void {
      if (namespace() !== owned) throw new Error('Invalid refresh journal');
      if (owned) {
        assertRefreshSelectionOwner(deps.database);
        const stored = readJobs();
        if (stored.length !== expected.length || stored.some((job, index) => canonicalJson(job) !== canonicalJson(expected[index]))) throw new Error('Invalid refresh journal');
      } else if (db.prepare("SELECT 1 FROM sqlite_schema WHERE lower(name)='service_extension_refresh_owner'").get()) throw new Error('Missing refresh ownership');
    }
    function transaction<T>(work: () => T): T {
      db.exec('BEGIN IMMEDIATE');
      try { const value = work(); db.exec('COMMIT'); return value; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    function save(job: Job, insert = false): void {
      const body = canonicalJson(job);
      if (Buffer.byteLength(body) > RECEIPT_LIMIT) throw new Error('Refresh receipt too large');
      const next = insert ? [...jobs, job] : jobs.map(previous => previous.request.id === job.request.id ? job : previous);
      try {
        transaction(() => {
          assertStored();
          const result = insert ? db.prepare('INSERT INTO host_refresh_jobs VALUES(?,?,?)').run(job.ordinal, job.request.id, body)
            : db.prepare('UPDATE host_refresh_jobs SET body=? WHERE id=?').run(body, job.request.id);
          if (result.changes !== 1) throw new Error('Refresh write failed');
          assertStored(next);
        });
        jobs = next;
      } catch { unavailable(); }
    }
    try {
      transaction(() => {
        owned = namespace();
        if (owned) jobs = readJobs();
        assertStored();
      });
    } catch { throw new Error('Invalid refresh journal'); }
    function recover(commands: readonly SelectionCommand[]): { readonly kind: 'allow' } {
      assertStored();
      for (const command of commands) {
        if (!command.id.startsWith(REFRESH_SELECTION_PREFIX)) continue;
        const job = jobs.find(job => REFRESH_SELECTION_PREFIX + job.build.command.id === command.id);
        if (!job || job.promotion.kind === 'not-built' || canonicalJson(job.promotion.command) !== canonicalJson(command)) throw new Error('Missing refresh ownership');
      }
      if (!owned) {
        for (const [name, columns] of tables) db.exec(`CREATE TABLE ${name} (${columns})`);
        db.prepare('INSERT INTO host_refresh_schema VALUES(1,1,?,?)').run(deps.database.hostId, root);
        owned = true;
      }
      return { kind: 'allow' };
    }
    function admission(command: SelectionCommand): RefreshAdmission {
      assertStored();
      if (!command.id.startsWith(REFRESH_SELECTION_PREFIX)) return { kind: 'allow' };
      const job = jobs.find(job => REFRESH_SELECTION_PREFIX + job.build.command.id === command.id);
      if (!job || job.promotion.kind === 'not-built' || canonicalJson(job.promotion.command) !== canonicalJson(command)) return { kind: 'refuse', reason: 'refresh-intent-conflict' };
      return jobs.at(-1)?.request.id === job.request.id ? { kind: 'allow' } : { kind: 'refuse', reason: 'source-superseded' };
    }
    const selection = await createServerSelection({ ...deps.selection, database: deps.database, refreshOwnership: { recover, admit: admission },
      stopRuntime: () => { broken = true; deps.selection.stopRuntime(); } }).catch(error => {
      if (error instanceof SelectionRefusal) throw error;
      throw new Error('Invalid refresh selection');
    });
    acquiredSelection = selection;
    try {
      if (selection.status().kind !== 'ready') broken = true;
      else transaction(() => {
        assertStored();
        const recovered = jobs.map((job): Job => job.build.kind === 'building'
          ? { request: job.request, ordinal: job.ordinal, build: { kind: 'interrupted', command: job.build.command }, promotion: { kind: 'not-built' } } : job);
        for (const job of recovered) if (job !== jobs[job.ordinal - 1]) {
          if (db.prepare('UPDATE host_refresh_jobs SET body=? WHERE id=?').run(canonicalJson(job), job.request.id).changes !== 1) throw new Error('Refresh recovery failed');
        }
        assertStored(recovered); jobs = recovered;
      });
    } catch { throw new Error('Invalid refresh ownership'); }
    function get(id: string): Job {
      available();
      try { assertStored(); } catch { unavailable(); }
      const job = jobs.find(job => job.request.id === operationId(id));
      if (!job) throw new RefreshRefusal('unknown-request');
      return job;
    }
    function receiptMatches(job: Extract<Job, { build: { kind: 'built' } }>, operation: OperationSummary): void {
      const chunks: Buffer[] = [];
      let offset = 0, total = 0;
      do {
        const chunk = selection.receipt(operation.receiptDigest, offset);
        if (chunk.offset !== offset || chunk.next <= offset || chunk.total > RECEIPT_LIMIT || chunk.digest !== operation.receiptDigest) throw new Error('Invalid selection receipt');
        chunks.push(Buffer.from(chunk.base64, 'base64')); offset = chunk.next; total = chunk.total;
      } while (offset < total);
      const bytes = Buffer.concat(chunks);
      if (bytes.length !== total || createHash('sha256').update(bytes).digest('hex') !== operation.receiptDigest) throw new Error('Invalid selection receipt');
      const receipt = record(JSON.parse(bytes.toString()), ['version', 'hostId', 'selection', 'grantsDigest', 'manifests']);
      if (receipt.version !== 1 || receipt.hostId !== deps.database.hostId || operation.id !== job.promotion.command.id || operation.revision !== job.request.expectedSelectionRevision + 1 ||
        canonicalJson(receipt.selection) !== canonicalJson(job.promotion.command.selection) || canonicalJson(receipt.manifests) !== canonicalJson([job.build.manifest])) throw new Error('Invalid refresh selection receipt');
    }
    async function inspect(id: string): Promise<RefreshReceipt> {
      const job = get(id), latestRequestId = jobs.at(-1)?.request.id;
      if (!latestRequestId) throw new RefreshRefusal('unavailable');
      const selectionStatus = selection.status();
      if (job.build.kind !== 'built') return structuredClone({ job: { request: job.request, ordinal: job.ordinal, build: job.build, promotion: { kind: 'not-built' } }, latestRequestId, selectionStatus });
      if (job.promotion.kind === 'not-built') throw new RefreshRefusal('unavailable');
      let promotion: JobSummary['promotion'] = job.promotion;
      try {
        const exact = selection.status({ kind: 'selection', id: job.promotion.command.id });
        if (exact.kind !== 'ready') throw new Error('Invalid selection ownership');
        receiptMatches({ ...job, build: job.build, promotion: job.promotion }, exact.operation);
        promotion = { kind: 'selected', command: job.promotion.command, operation: exact.operation };
      } catch (error) { if (!(error instanceof SelectionRefusal && error.reason === 'unknown-operation')) unavailable(); }
      const { manifest, ...build } = job.build;
      const { root, builder, runtime, sdkVersion } = manifest;
      return structuredClone({ job: { request: job.request, ordinal: job.ordinal, build: { ...build, provenance: { root, builder, runtime, sdkVersion } }, promotion }, latestRequestId, selectionStatus });
    }
    async function promote(id: string): Promise<RefreshReceipt> {
      const job = get(id);
      if (job.promotion.kind === 'not-built' || job.build.kind !== 'built') throw new RefreshRefusal('not-built');
      try { await selection.select(job.promotion.command); }
      catch (error) {
        const reason = error instanceof SelectionRefusal ? promotionRefusal(error.reason) : undefined;
        if (reason) {
          if (!closed && !broken) save({ ...job, build: job.build, promotion: { kind: 'refused', command: job.promotion.command, reason } });
        } else {
          if (error instanceof SelectionRefusal && (error.reason === 'unavailable' || error.reason === 'uncertain')) {
            broken = true;
            throw new RefreshRefusal('unavailable');
          }
          unavailable();
        }
      }
      return inspect(id);
    }
    async function build(job: Job): Promise<RefreshReceipt> {
      available();
      const command = job.build.command;
      let value: unknown;
      try { value = builder.kind === 'unavailable' ? { kind: 'failed', failure: 'unavailable' } : await builder.run(structuredClone(command)); }
      catch { value = { kind: 'failed', failure: 'build' }; }
      available();
      let result: RefreshBuildResult;
      try {
        const input = record(value);
        if (input.kind === 'built') {
          record(input, ['kind', 'pin', 'manifest']);
          const pin = parseSelection({ version: 1, artifacts: [input.pin] }).artifacts[0];
          if (!pin) throw new Error('Invalid refresh artifact');
          const manifest = parseServerCustomizationArtifact(input.manifest);
          assertBuild(command, job.request, pin, manifest);
          if (command.toolchain.kind !== 'ready' || command.toolchain.node !== process.execPath) throw new Error('Incompatible refresh builder');
          const verified = await readServerCustomizationArtifact({ directory: command.directory, expected: serverArtifactExpectation(pin.artifactId) });
          if (canonicalJson(verified.manifest) !== canonicalJson(manifest)) throw new Error('Changed refresh artifact');
          result = { kind: 'built', pin, manifest: verified.manifest };
        } else {
          record(input, ['kind', 'failure']);
          if (input.kind !== 'failed') throw new Error('Invalid refresh result');
          result = { kind: 'failed', failure: failure(input.failure) };
        }
      } catch { result = { kind: 'failed', failure: 'qualification' }; }
      available();
      const current = get(job.request.id);
      if (current.build.kind !== 'building' || canonicalJson(current.build.command) !== canonicalJson(command)) throw new RefreshRefusal('unavailable');
      if (result.kind === 'failed') {
        save({ request: job.request, ordinal: job.ordinal, build: { ...result, command }, promotion: { kind: 'not-built' } });
        return inspect(job.request.id);
      }
      const built: Job = { request: job.request, ordinal: job.ordinal, build: { ...result, command },
        promotion: { kind: 'unconfirmed', command: commandFor(command, job.request, result.pin) } };
      let fits = false;
      try {
        fits = [built, ...promotionRefusals.map(reason => ({ ...built,
          promotion: { kind: 'refused', command: built.promotion.command, reason } }))]
          .every(job => Buffer.byteLength(canonicalJson(job)) <= RECEIPT_LIMIT);
      } catch (error) { if (!(error instanceof JsonLimitError)) throw error; }
      if (!fits) {
        save({ request: job.request, ordinal: job.ordinal, build: { kind: 'failed', command, failure: 'resource-limit' }, promotion: { kind: 'not-built' } });
        return inspect(job.request.id);
      }
      save(built);
      return promote(job.request.id);
    }
    async function request(value: RefreshRequest): Promise<RefreshReceipt> {
      const request = parseRefreshRequest(value);
      available();
      try { assertStored(); } catch { unavailable(); }
      const existing = jobs.find(job => job.request.id === request.id);
      if (existing) {
        if (canonicalJson(existing.request) !== canonicalJson(request)) throw new RefreshRefusal('id-conflict');
        return inspect(request.id);
      }
      if (active.size >= 2) throw new RefreshRefusal('busy');
      const id = randomUUID(), command: RefreshBuildCommand = { id, requestId: request.id, source: request.reference, directory: join(root, id), toolchain: identity };
      const job: Job = { request, ordinal: jobs.length + 1, build: { kind: 'building', command }, promotion: { kind: 'not-built' } };
      save(job, true);
      const task = Promise.resolve().then(() => build(job));
      active.set(request.id, task);
      void task.finally(() => active.delete(request.id)).catch(() => {});
      return task;
    }
    function close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = Promise.resolve().then(async () => {
        let cleanupFailed = false;
        try {
          if (!broken) for (const job of jobs) if (job.build.kind === 'building') save({ request: job.request, ordinal: job.ordinal,
            build: { kind: 'interrupted', command: job.build.command }, promotion: { kind: 'not-built' } });
        } finally {
          const draining = [...active.values()];
          const cleanup = await Promise.allSettled([selection.close(), builder.kind === 'ready' ? Promise.resolve().then(() => builder.close()) : undefined]);
          await Promise.allSettled(draining);
          cleanupFailed = cleanup.some(result => result.status === 'rejected');
        }
        if (cleanupFailed) throw new Error('Refresh shutdown failed');
      });
      return closePromise;
    }
    return { selection, request, inspect, promote, close };
  } catch (error) {
    await Promise.allSettled([Promise.resolve().then(() => acquiredSelection?.close()),
      builder.kind === 'ready' ? Promise.resolve().then(() => builder.close()) : undefined]);
    throw error;
  }
}
export type RefreshController = Awaited<ReturnType<typeof createRefreshController>>;
