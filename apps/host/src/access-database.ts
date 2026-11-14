import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export interface AccessDatabase { readonly database: DatabaseSync; readonly hostId: string }
export function openAccessDatabase(path: string): AccessDatabase {
  const database = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    database.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS service_schema (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL);
      INSERT OR IGNORE INTO service_schema(singleton,version) VALUES(1,1);
      CREATE TABLE IF NOT EXISTS service_identity (singleton INTEGER PRIMARY KEY CHECK(singleton=1), host TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS service_devices (id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, host TEXT NOT NULL,
        credential_class TEXT NOT NULL CHECK(credential_class IN ('browser-development','native')), expires INTEGER NOT NULL,
        policy TEXT NOT NULL CHECK(policy='owner'), revoked INTEGER NOT NULL CHECK(revoked IN (0,1)));`);
    if (database.prepare('SELECT version FROM service_schema WHERE singleton=1').get()?.version !== 1 ||
      !database.prepare('PRAGMA table_info(service_devices)').all().some(row => row.name === 'credential_class')) throw new Error('Unsupported host access schema');
    database.prepare('INSERT OR IGNORE INTO service_identity(singleton,host) VALUES(1,?)').run(randomUUID());
    const host = database.prepare('SELECT host FROM service_identity WHERE singleton=1').get()?.host;
    if (typeof host !== 'string' || !host) throw new Error('Invalid persisted host identity');
    if (database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='conversations'").get() &&
      database.prepare('SELECT 1 FROM conversations WHERE host<>? LIMIT 1').get(host)) throw new Error('Conversation host identity differs from persisted service identity');
    return { database, hostId: host };
  } catch (error) { database.close(); throw error; }
}
