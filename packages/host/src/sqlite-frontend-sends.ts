import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '@agentui/contracts';
import { nonempty } from './codec.js';

const taggedSendSql = `json_extract(target, '$.kind')='provider' AND json_extract(target, '$.operation.kind')='send' AND json_extract(target, '$.operation.protocol')='ag-ui'`;
const taggedThreadSql = `json_extract(target, '$.operation.request.threadId')`;
const taggedRunSql = `json_extract(target, '$.operation.request.runId')`;
export const taggedKeySql = `${taggedSendSql} AND ${taggedThreadSql}=? AND ${taggedRunSql}=?`;
export const taggedHistorySql = `SELECT 1 FROM commands INDEXED BY commands_tagged_send_key WHERE host=? AND conversation=? AND ${taggedKeySql} LIMIT 1`;
const ownerCommandForeignKey = 'FOREIGN KEY(host,conversation,command_id) REFERENCES commands(host,conversation,id) DEFERRABLE INITIALLY DEFERRED';
const ownerSchema = `CREATE TABLE frontend_send_owners (
    host TEXT NOT NULL, conversation TEXT NOT NULL, command_id TEXT NOT NULL, actor_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('available','unavailable')), thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
    PRIMARY KEY(host,conversation,command_id), UNIQUE(host,conversation,thread_id,run_id),
    FOREIGN KEY(host,conversation) REFERENCES conversations(host,conversation),
    ${ownerCommandForeignKey})`;

export function migrateFrontendSends(db: DatabaseSync, format: number): void {
  if (format < 5) db.exec(`${ownerSchema};
    CREATE TABLE frontend_send_tombstones (
      host TEXT NOT NULL, conversation TEXT NOT NULL, command_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      PRIMARY KEY(host,conversation,command_id,actor_id), FOREIGN KEY(host,conversation) REFERENCES conversations(host,conversation));
    CREATE INDEX commands_tagged_send_key ON commands(host,conversation,${taggedThreadSql},${taggedRunSql}) WHERE ${taggedSendSql};`);
  assertFrontendSendSchema(db);
}

function assertFrontendSendSchema(db: DatabaseSync): void {
  for (const [table, names, primary] of [
    ['frontend_send_owners', ['host', 'conversation', 'command_id', 'actor_id', 'state', 'thread_id', 'run_id'], ['host', 'conversation', 'command_id']],
    ['frontend_send_tombstones', ['host', 'conversation', 'command_id', 'actor_id'], ['host', 'conversation', 'command_id', 'actor_id']],
  ] as const) {
    const columns = db.prepare('SELECT name,type,"notnull",pk FROM pragma_table_info(?) ORDER BY cid').all(table);
    if (canonicalJson(columns.map(row => row.name)) !== canonicalJson(names) ||
      columns.some(row => row.type !== 'TEXT' || row.notnull !== 1 || row.pk !== primary.findIndex(name => name === row.name) + 1)) throw new Error('Invalid frontend ownership schema');
    const foreignKeys = db.prepare('SELECT * FROM pragma_foreign_key_list(?) ORDER BY id,seq').all(table);
    const groups = [...new Set(foreignKeys.map(row => row.id))].map(id => foreignKeys.filter(row => row.id === id)
      .map(row => [row.seq, row.table, row.from, row.to, row.on_update, row.on_delete]));
    const expected = [[[0, 'conversations', 'host', 'host', 'NO ACTION', 'NO ACTION'],
      [1, 'conversations', 'conversation', 'conversation', 'NO ACTION', 'NO ACTION']]];
    if (table === 'frontend_send_owners') expected.push([
      [0, 'commands', 'host', 'host', 'NO ACTION', 'NO ACTION'],
      [1, 'commands', 'conversation', 'conversation', 'NO ACTION', 'NO ACTION'],
      [2, 'commands', 'command_id', 'id', 'NO ACTION', 'NO ACTION']]);
    if (canonicalJson(groups.map(group => canonicalJson(group)).sort()) !== canonicalJson(expected.map(group => canonicalJson(group)).sort())) throw new Error('Invalid frontend ownership foreign keys');
    const indexes = db.prepare('SELECT name FROM pragma_index_list(?) WHERE "unique"=1 AND partial=0').all(table);
    const unique = indexes.map(row => db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(nonempty(row.name)).map(column => column.name));
    if (!unique.some(columns => canonicalJson(columns) === canonicalJson(primary)) ||
      (table === 'frontend_send_owners' && !unique.some(columns => canonicalJson(columns) === canonicalJson(['host', 'conversation', 'thread_id', 'run_id'])))) throw new Error('Invalid frontend ownership uniqueness');
  }
  // SQLite's foreign_key_list omits deferral, which preserves admission callback ordering.
  const ownerSql = nonempty(db.prepare("SELECT sql FROM sqlite_schema WHERE name='frontend_send_owners'").get()?.sql);
  if (ownerSql.replace(/\s+/g, ' ').trim() !== ownerSchema.replace(/\s+/g, ' ').trim()) throw new Error('Invalid frontend ownership foreign key timing');
  // INDEXED BY refuses an absent or unusable history index at prepare time.
  db.prepare(taggedHistorySql);
}
