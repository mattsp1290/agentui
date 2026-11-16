import type { DatabaseSync } from 'node:sqlite';
import { parseDocument, parseHostEvent, parseScope, sameScope } from '@agentui/contracts';
import { count, record } from '@agentui/contracts/decode';
import { parseTranscript, parseTranscriptEvent } from '@agentui/contracts/conversation';

export function migrateTranscriptDatabase(db: DatabaseSync): void {
  if (!db.prepare('SELECT 1 FROM conversations WHERE version<>4 LIMIT 1').get()) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    const hasCheckpoints = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='provider_checkpoints'").get();
    for (const row of db.prepare('SELECT host, conversation, version, head, document, bytes, installation FROM conversations').iterate()) {
      if (row.version !== 1 && row.version !== 2 && row.version !== 3 && row.version !== 4) throw new Error('Unsupported transcript projection version');
      const scope = parseScope({ hostId: row.host, conversationId: row.conversation }), head = count(row.head);
      if (typeof row.document !== 'string' || Buffer.byteLength(row.document) !== row.bytes) throw new Error('Corrupt transcript snapshot bytes');
      const legacy = row.version === 1, imageless = row.version !== 4;
      parseDocument(JSON.parse(row.document), value => {
        if (legacy && Object.hasOwn(record(value), 'activities')) throw new Error('Invalid legacy transcript');
        const parsed = parseTranscript(value);
        if (row.version !== 3 && row.version !== 4 && parsed.activities?.some(item => item.kind !== 'command')) throw new Error('Invalid historical activity');
        if (imageless && parsed.messages.some(item => item.image)) throw new Error('Invalid historical image');
        return parsed;
      }, scope, head);
      const floor = hasCheckpoints ? count(db.prepare('SELECT floor FROM provider_checkpoints WHERE host=? AND conversation=?')
        .get(scope.hostId, scope.conversationId)?.floor ?? 0) : 0;
      if (floor > head || (floor > 0 && (typeof row.installation !== 'string' || record(JSON.parse(row.installation)).kind !== 'provider'))) {
        throw new Error('Corrupt transcript replay floor');
      }
      let sequence = 0;
      for (const event of db.prepare('SELECT sequence, payload, bytes FROM events WHERE host=? AND conversation=? ORDER BY sequence').iterate(scope.hostId, scope.conversationId)) {
        const next = count(event.sequence);
        if (next <= sequence || next > head || next === floor || (next > floor && next !== Math.max(sequence, floor) + 1) || typeof event.payload !== 'string' || Buffer.byteLength(event.payload) !== event.bytes) {
          throw new Error('Corrupt transcript event sequence or bytes');
        }
        sequence = next;
        const envelope = record(JSON.parse(event.payload), ['scope', 'sequence', 'event']);
        if (envelope.sequence !== sequence || !sameScope(parseScope(envelope.scope), scope)) throw new Error('Corrupt transcript envelope');
        parseHostEvent(envelope.event, scope, sequence, { decodeEvent(value) {
          const parsed = parseTranscriptEvent(value);
          if ((legacy && parsed.kind === 'command-updated') || (row.version !== 3 && row.version !== 4 && parsed.kind === 'file-change-updated') ||
            (imageless && parsed.kind === 'message-updated' && parsed.image)) throw new Error('Invalid legacy transcript event');
          return parsed;
        } });
      }
      if (Math.max(sequence, floor) !== head) throw new Error('Corrupt transcript head');
    }
    db.prepare('UPDATE conversations SET version=4 WHERE version IN (1, 2, 3)').run();
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
