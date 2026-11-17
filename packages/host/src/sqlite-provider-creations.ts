import type { DatabaseSync } from 'node:sqlite';

const successorIndex = `provider_creations_from ON provider_creations(host, json_extract(original,'$.intent.from.scope.conversationId'))
  WHERE json_extract(original,'$.intent.from.scope.conversationId') IS NOT NULL`;
export function migrateProviderCreations(db: DatabaseSync, format: number): void {
  if (format < 8) db.exec(`CREATE INDEX IF NOT EXISTS ${successorIndex}`);
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name='provider_creations_from' AND tbl_name='provider_creations'").get()?.sql;
  if (typeof sql !== 'string' || sql.replace(/\s+/g, ' ').trim() !== `CREATE INDEX ${successorIndex}`.replace(/\s+/g, ' ').trim()) {
    throw new Error('Invalid provider creation schema');
  }
}
