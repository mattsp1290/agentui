import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@agentui/contracts';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import { HostCapacityError } from '@agentui/host';
import type { Installation, LocalHost } from '@agentui/host';

export function recoverCodexConversations(
  host: LocalHost<TranscriptEvent, Transcript>, hostId: string, installation: Installation,
): void {
  const installed = canonicalJson(installation);
  let after: string | null = null;
  for (;;) {
    const page = host.listConversations(hostId, after, 100);
    for (const scope of page) {
      after = scope.conversationId;
      const current = host.inspect(scope);
      if (canonicalJson(current.installation) !== installed) continue;
      const unfinished = current.snapshot.document.domain.messages.filter(message =>
        message.role === 'assistant' && !message.complete);
      const expiredDecisions = Object.keys(current.snapshot.document.decisions);
      if (unfinished.length === 0 && expiredDecisions.length === 0) continue;
      host.append(scope, {
        events: unfinished.map(message => ({ ...message, kind: 'message-updated',
          revision: message.revision + 1, complete: true })),
        runs: [], decisions: [], expiredDecisions,
      });
      try {
        host.append(scope, {
          events: [{ kind: 'message-updated', messageId: `interrupted:${randomUUID()}`,
            revision: 1, role: 'assistant', complete: true,
            text: 'The Codex connection was interrupted when the host stopped. Check any unconfirmed actions before retrying them.' }],
          runs: [], decisions: [],
        });
      } catch (error) {
        if (!(error instanceof HostCapacityError)) throw error;
        process.emitWarning(`Could not add the Codex interruption notice to conversation ${scope.conversationId}. Its history is full; start a new conversation.`,
          { code: 'AGENTUI_CODEX_RECOVERY_CAPACITY' });
      }
    }
    if (page.length < 100) return;
  }
}
