import type { TranscriptEvent } from '@agentui/contracts/conversation';
import { messageParts } from './transcript-parts.js';

export function createTranscriptWriter(options: {
  readonly messageIdPrefix: string;
  readonly publish: (events: readonly TranscriptEvent[]) => void;
}) {
  const rendered: { text: string; complete: boolean; revision: number }[] = [];
  let revision = 0;
  return {
    write(text: string, complete: boolean): void {
      const parts = messageParts(text);
      for (let index = 0; index < Math.max(parts.length, rendered.length); index++) {
        const value = parts[index] ?? '';
        const previous = rendered[index];
        if (previous?.complete || !complete && previous?.text === value) continue;
        const nextRevision = ++revision;
        options.publish([{ kind: 'message-updated', messageId: `${options.messageIdPrefix}:${index}`,
          revision: nextRevision, role: 'assistant', text: value, complete }]);
        rendered[index] = { text: value, complete, revision: nextRevision };
      }
    },
    sealSaved(): boolean {
      let saved = true;
      for (const [index, previous] of rendered.entries()) {
        if (previous.complete) continue;
        const nextRevision = previous.revision + 1;
        try {
          options.publish([{ kind: 'message-updated', messageId: `${options.messageIdPrefix}:${index}`,
            revision: nextRevision, role: 'assistant', text: previous.text, complete: true }]);
          rendered[index] = { ...previous, revision: nextRevision, complete: true };
          revision = Math.max(revision, nextRevision);
        } catch { saved = false; }
      }
      return saved;
    },
  };
}
