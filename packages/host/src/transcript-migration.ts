import type { DatabaseSync } from 'node:sqlite';
import { parseDocument, parseHostEvent, parseScope, sameScope } from '@agentui/contracts';
import { count, record } from '@agentui/contracts/decode';
import { parseTranscript, parseTranscriptEvent } from '@agentui/contracts/conversation';

export function migrateTranscriptDatabase(db: DatabaseSync): void {
  if (!db.prepare('SELECT 1 FROM conversations WHERE version=1 LIMIT 1').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of db.prepare('SELECT host, conversation, version, head, document, bytes FROM conversations').iterate()) {
      if (row.version !== 1 && row.version !== 2) throw new Error('Unsupported transcript projection version');
      const scope = parseScope({ hostId: row.host, conversationId: row.conversation }), head = count(row.head);
      if (typeof row.document !== 'string' || Buffer.byteLength(row.document) !== row.bytes) throw new Error('Corrupt transcript snapshot bytes');
      const legacy = row.version === 1;
      parseDocument(JSON.parse(row.document), value => {
        if (legacy && Object.hasOwn(record(value), 'activities')) throw new Error('Invalid legacy transcript');
        return parseTranscript(value);
      }, scope, head);
      let sequence = 0;
      for (const event of db.prepare('SELECT sequence, payload, bytes FROM events WHERE host=? AND conversation=? ORDER BY sequence').iterate(scope.hostId, scope.conversationId)) {
        if (event.sequence !== ++sequence || typeof event.payload !== 'string' || Buffer.byteLength(event.payload) !== event.bytes) {
          throw new Error('Corrupt transcript event sequence or bytes');
        }
        const envelope = record(JSON.parse(event.payload), ['scope', 'sequence', 'event']);
        if (envelope.sequence !== sequence || !sameScope(parseScope(envelope.scope), scope)) throw new Error('Corrupt transcript envelope');
        parseHostEvent(envelope.event, scope, sequence, { decodeEvent(value) {
          const parsed = parseTranscriptEvent(value);
          if (legacy && parsed.kind === 'command-updated') throw new Error('Invalid legacy transcript event');
          return parsed;
        } });
      }
      if (sequence !== head) throw new Error('Corrupt transcript head');
    }
    db.prepare('UPDATE conversations SET version=2 WHERE version=1').run();
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
