import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@agentui/contracts';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import { HostCapacityError } from '@agentui/host';
import type { Installation, LocalHost } from '@agentui/host';

export function recoverCodexConversations(
  host: LocalHost<TranscriptEvent, Transcript>, hostId: string, installation: Installation, displayName = 'Codex',
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
      const run = current.snapshot.document.domain.currentRun;
      const activeRun = run && run.kind !== 'ended' ? run : null;
      const expiredDecisions = Object.keys(current.snapshot.document.decisions);
      if (!activeRun && unfinished.length === 0 && expiredDecisions.length === 0) continue;
      const seals = unfinished.map((message): TranscriptEvent => ({ ...message, kind: 'message-updated',
        revision: message.revision + 1, complete: true }));
      try {
        host.append(scope, {
          events: [
            ...seals,
            ...(activeRun ? [{ kind: 'run-ended' as const, runId: activeRun.runId, outcome: 'connection-lost' as const }] : []),
          ],
          runs: [], decisions: [], expiredDecisions,
        });
      } catch (error) {
        if (!(error instanceof HostCapacityError)) throw error;
        try {
          host.append(scope, { events: seals, runs: [], decisions: [], expiredDecisions });
        } catch (fallbackError) {
          if (!(fallbackError instanceof HostCapacityError)) throw fallbackError;
        }
        process.emitWarning(`Could not finish ${displayName} recovery for conversation ${scope.conversationId}. Its history is full; start a new conversation.`,
          { code: `AGENTUI_${displayName.toUpperCase()}_RECOVERY_CAPACITY` });
        continue;
      }
      try {
        host.append(scope, {
          events: [{ kind: 'message-updated', messageId: `interrupted:${randomUUID()}`,
            revision: 1, role: 'assistant', complete: true,
            text: `The ${displayName} connection was interrupted when the host stopped. ${displayName === 'Codex' ? 'Check any unconfirmed actions before retrying them.' : 'You can send another message to continue.'}` }],
          runs: [], decisions: [],
        });
      } catch (error) {
        if (!(error instanceof HostCapacityError)) throw error;
        process.emitWarning(`Could not add the ${displayName} interruption notice to conversation ${scope.conversationId}. Its history is full; start a new conversation.`,
          { code: `AGENTUI_${displayName.toUpperCase()}_RECOVERY_CAPACITY` });
      }
    }
    if (page.length < 100) return;
  }
}
