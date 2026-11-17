import type { DatabaseSync } from 'node:sqlite';

const schemas = {
  frontend_observation_runs: `CREATE TABLE frontend_observation_runs (
    host TEXT NOT NULL, conversation TEXT NOT NULL, command_id TEXT NOT NULL,
    fault TEXT CHECK(fault IN ('history-unavailable','event-conflict')),
    PRIMARY KEY(host,conversation,command_id),
    FOREIGN KEY(host,conversation,command_id) REFERENCES commands(host,conversation,id))`,
  frontend_observation_events: `CREATE TABLE frontend_observation_events (
    host TEXT NOT NULL, conversation TEXT NOT NULL, command_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 4096), data TEXT NOT NULL,
    bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1 AND 64000),
    PRIMARY KEY(host,conversation,command_id,position),
    FOREIGN KEY(host,conversation,command_id) REFERENCES frontend_observation_runs(host,conversation,command_id))`,
};
export function migrateFrontendObservations(db: DatabaseSync, format: number): void {
  if (format < 7) for (const schema of Object.values(schemas)) db.exec(schema);
  for (const [table, schema] of Object.entries(schemas)) {
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.sql;
    if (typeof sql !== 'string' || sql.replace(/\s+/g, ' ').trim() !== schema.replace(/\s+/g, ' ').trim()) throw new Error('Invalid frontend observation schema');
  }
}
