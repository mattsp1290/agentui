import { DatabaseSync } from 'node:sqlite';

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    const version = db.prepare('PRAGMA user_version').get()?.user_version;
    if (typeof version !== 'number' || (version !== 0 && version !== 1)) throw new Error('Unsupported database version');
    db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (version === 0) {
      db.exec('BEGIN IMMEDIATE');
      const lockedVersion = db.prepare('PRAGMA user_version').get()?.user_version;
      if (lockedVersion !== 0 && lockedVersion !== 1) throw new Error('Unsupported database version');
      if (lockedVersion === 0) db.exec(`
        CREATE TABLE conversations (
          host TEXT NOT NULL, conversation TEXT NOT NULL, installation TEXT NOT NULL,
          head INTEGER NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(host, conversation));
        CREATE TABLE runs (
          host TEXT NOT NULL, conversation TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(host, conversation, id),
          FOREIGN KEY(host, conversation) REFERENCES conversations(host, conversation));
        CREATE TABLE commands (
          host TEXT NOT NULL, conversation TEXT NOT NULL, id TEXT NOT NULL, operation TEXT NOT NULL,
          intent TEXT NOT NULL, target TEXT NOT NULL, observation TEXT, receipt TEXT NOT NULL,
          PRIMARY KEY(host, conversation, id), UNIQUE(host, operation),
          FOREIGN KEY(host, conversation) REFERENCES conversations(host, conversation));
        CREATE TABLE pending_decisions (
          host TEXT NOT NULL, conversation TEXT NOT NULL, id TEXT NOT NULL, run TEXT NOT NULL,
          data TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','reserved','closed')),
          operation TEXT,
          PRIMARY KEY(host, conversation, id),
          FOREIGN KEY(host, conversation, run) REFERENCES runs(host, conversation, id));
        CREATE TABLE events (
          host TEXT NOT NULL, conversation TEXT NOT NULL, sequence INTEGER NOT NULL,
          payload TEXT NOT NULL, bytes INTEGER NOT NULL,
          PRIMARY KEY(host, conversation, sequence),
          FOREIGN KEY(host, conversation) REFERENCES conversations(host, conversation));
        PRAGMA user_version=1;`);
      db.exec('COMMIT');
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
