import type { DatabaseSync } from 'node:sqlite';

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
const tombstoneSchema = `CREATE TABLE frontend_send_tombstones (
      host TEXT NOT NULL, conversation TEXT NOT NULL, command_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      PRIMARY KEY(host,conversation,command_id,actor_id), FOREIGN KEY(host,conversation) REFERENCES conversations(host,conversation))`;

export function migrateFrontendSends(db: DatabaseSync, format: number): void {
  if (format < 5) db.exec(`${ownerSchema};
    ${tombstoneSchema};
    CREATE INDEX commands_tagged_send_key ON commands(host,conversation,${taggedThreadSql},${taggedRunSql}) WHERE ${taggedSendSql};`);
  assertFrontendSendSchema(db);
}

function assertFrontendSendSchema(db: DatabaseSync): void {
  for (const [table, schema] of [
    ['frontend_send_owners', ownerSchema], ['frontend_send_tombstones', tombstoneSchema],
  ] as const) {
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.sql;
    if (typeof sql !== 'string' || sql.replace(/\s+/g, ' ').trim() !== schema.replace(/\s+/g, ' ').trim()) throw new Error('Invalid frontend ownership schema');
  }
  // INDEXED BY refuses an absent or unusable history index at prepare time.
  db.prepare(taggedHistorySql);
}
