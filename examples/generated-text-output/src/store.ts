import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, parseTextMetadata } from '@agentui/contracts';
import { z } from 'zod';
import { binding, conversation, instance, operation, outputListing, reportMetadata, settlement, supportsOutputs } from './model.js';
import type { ConversationRef, ProviderConversation, ProviderOutputListing, ProviderOutputRead } from '@agentui/sdk';

const schema = [
  ['creations', 'CREATE TABLE creations (scope TEXT PRIMARY KEY, intent TEXT NOT NULL, binding TEXT NOT NULL) WITHOUT ROWID'],
  ['receipts', 'CREATE TABLE receipts (id TEXT PRIMARY KEY, request TEXT NOT NULL, reply TEXT NOT NULL, CHECK(length(CAST(request AS BLOB))<=73728), CHECK(length(CAST(reply AS BLOB))<=16384)) WITHOUT ROWID'],
  ['receipt_update', "CREATE TRIGGER receipt_update BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, 'immutable receipt'); END"],
  ['receipt_delete', "CREATE TRIGGER receipt_delete BEFORE DELETE ON receipts BEGIN SELECT RAISE(ABORT, 'immutable receipt'); END"],
  ['receipt_insert', "CREATE TRIGGER receipt_insert BEFORE INSERT ON receipts WHEN EXISTS (SELECT 1 FROM receipts WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT, 'immutable receipt'); END"],
  ['payloads', 'CREATE TABLE payloads (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, opaque TEXT UNIQUE NOT NULL, metadata TEXT NOT NULL, bytes BLOB NOT NULL)'],
] satisfies readonly [string, string][];
const receiptRow = z.object({ id: z.string(), request: z.string(), reply: z.string() });
const creationRow = z.object({ scope: z.string(), intent: z.string(), binding: z.string() });
const payloadRow = z.object({ seq: z.number().int().positive(), scope: z.string(), opaque: z.string(), metadata: z.string(), bytes: z.instanceof(Uint8Array) });
const scalar = z.object({ n: z.number().int().nonnegative() });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const rejected = (reason: string) => ({ kind: 'rejected' as const, reason, evidence: null });
const refused = (reason: string) => ({ kind: 'not-dispatched' as const, reason });

export class ReportStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE');
      const objects = this.db.prepare("SELECT name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      if (!objects.length && this.db.prepare('PRAGMA user_version').get()?.user_version === 0) {
        for (const [, sql] of schema) this.db.exec(sql);
        this.db.exec('PRAGMA user_version=1');
      } else {
        const expected = schema.map(([name, sql]) => ({ name, sql })).sort((a, b) => a.name.localeCompare(b.name));
        if (this.db.prepare('PRAGMA user_version').get()?.user_version !== 1 || canonicalJson(objects) !== canonicalJson(expected)) throw new Error('Invalid store');
      }
      this.validate();
      this.db.exec('COMMIT');
    } catch { this.db.close(); throw new Error('Report store unavailable'); }
  }
  private count(sql: string): number { return scalar.parse(this.db.prepare(sql).get()).n; }
  private used(): number {
    return this.count('SELECT coalesce(sum(length(CAST(request AS BLOB))+length(CAST(reply AS BLOB))),0) AS n FROM receipts');
  }
  private known(value: ProviderConversation<'reports'>): boolean {
    const row = this.db.prepare('SELECT binding FROM creations WHERE scope=?').get(canonicalJson(value.creation.scope));
    return row?.binding === canonicalJson(value);
  }
  private validate(): void {
    if (this.count('SELECT count(*) AS n FROM creations') > 128 || this.count('SELECT count(*) AS n FROM receipts') > 4096 || this.used() > 67108864) throw new Error('Invalid store capacity');
    for (const raw of this.db.prepare('SELECT * FROM receipts').iterate()) {
      const row = receiptRow.parse(raw), value = operation.parse(JSON.parse(row.request));
      if (row.id !== value.operationId || canonicalJson(value) !== row.request || Buffer.byteLength(row.request) > 73728 ||
          Buffer.byteLength(row.reply) > 16384 || row.reply !== canonicalJson(settlement(value)) ||
          !this.known(value.kind === 'create' ? binding(value) : value.binding)) throw new Error('Invalid receipt');
    }
    for (const raw of this.db.prepare('SELECT * FROM creations').iterate()) {
      const row = creationRow.parse(raw), value = conversation.parse(JSON.parse(row.binding));
      if (row.scope !== canonicalJson(value.creation.scope) || row.intent !== canonicalJson(value.creation) || row.binding !== canonicalJson(value) ||
          !this.db.prepare('SELECT id FROM receipts WHERE id=? AND request=?').get(value.creation.operationId, row.intent)) throw new Error('Invalid creation');
    }
    if (this.db.prepare('SELECT scope FROM payloads GROUP BY scope HAVING count(*)>32').get()) throw new Error('Invalid retention');
    for (const raw of this.db.prepare('SELECT * FROM payloads').iterate()) {
      const row = payloadRow.parse(raw), metadata = parseTextMetadata(JSON.parse(row.metadata));
      const receipt = receiptRow.parse(this.db.prepare('SELECT * FROM receipts WHERE id=?').get(row.opaque));
      const value = operation.parse(JSON.parse(receipt.request));
      if (value.kind !== 'send' || row.scope !== canonicalJson(value.binding.creation.scope) || metadata.name !== 'response.txt' ||
          row.metadata !== canonicalJson(metadata) || metadata.byteLength !== row.bytes.length || metadata.sha256 !== hash(row.bytes) ||
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(row.bytes) !== value.request.text) throw new Error('Invalid payload');
    }
  }
  settle(input: unknown, lookup = false) {
    const value = operation.parse(input), request = canonicalJson(value);
    if (Buffer.byteLength(request) > 73728) return refused('request-capacity');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const saved = this.db.prepare('SELECT * FROM receipts WHERE id=?').get(value.operationId);
      if (saved) {
        const row = receiptRow.parse(saved);
        return row.request === request ? settlement(value) : rejected('operation-conflict');
      }
      if (lookup) return refused('operation-absent');
      if (this.count('SELECT count(*) AS n FROM receipts') >= 4096 || this.used() + Buffer.byteLength(request) + 16384 > 67108864) return refused('receipt-capacity');
      if (value.kind === 'create') {
        const scope = canonicalJson(value.scope);
        if (this.db.prepare('SELECT scope FROM creations WHERE scope=?').get(scope)) return rejected('creation-conflict');
        if (this.count('SELECT count(*) AS n FROM creations') >= 128) return refused('creation-capacity');
        const created = binding(value);
        if (!supportsOutputs(created)) return refused('listing-capacity');
        conversation.parse(created);
        this.db.prepare('INSERT INTO creations VALUES (?,?,?)').run(scope, request, canonicalJson(created));
      } else {
        if (!this.known(value.binding)) return rejected('conversation-mismatch');
        const bytes = new TextEncoder().encode(value.request.text), scope = canonicalJson(value.binding.creation.scope);
        const metadata = canonicalJson(reportMetadata(bytes.length, hash(bytes)));
        this.db.prepare('INSERT INTO payloads(scope,opaque,metadata,bytes) VALUES (?,?,?,?)').run(scope, value.operationId, metadata, bytes);
        this.db.prepare('DELETE FROM payloads WHERE scope=? AND seq NOT IN (SELECT seq FROM payloads WHERE scope=? ORDER BY seq DESC LIMIT 32)').run(scope, scope);
      }
      const result = settlement(value), reply = canonicalJson(result);
      if (Buffer.byteLength(reply) > 16384) throw new Error('Receipt capacity');
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?)').run(value.operationId, request, reply);
      this.db.exec('COMMIT');
      return result;
    } finally { if (this.db.isTransaction) this.db.exec('ROLLBACK'); }
  }
  list(input: ProviderConversation<'reports'>): ProviderOutputListing<'reports'> {
    const value = conversation.parse(input);
    if (!this.known(value)) return { kind: 'unavailable', reason: 'conversation-mismatch' };
    return outputListing(value, this.db.prepare('SELECT * FROM payloads WHERE scope=? ORDER BY seq').all(canonicalJson(value.creation.scope)).map(raw => {
      const row = payloadRow.parse(raw);
      return { opaqueId: row.opaque, metadata: parseTextMetadata(JSON.parse(row.metadata)) };
    }));
  }
  read(reference: ConversationRef<'reports', 'output'>): ProviderOutputRead {
    const value = conversation.parse(reference.binding);
    if (!this.known(value) || reference.ref.kind !== 'output' || canonicalJson(reference.ref.instance) !== canonicalJson(instance)) return { kind: 'unavailable', reason: 'conversation-mismatch' };
    const raw = this.db.prepare('SELECT * FROM payloads WHERE scope=? AND opaque=?').get(canonicalJson(value.creation.scope), reference.ref.opaqueId);
    return raw ? { kind: 'available', bytes: payloadRow.parse(raw).bytes } : { kind: 'missing' };
  }
  close(): void { if (!this.closed) { this.closed = true; this.db.close(); } }
}
