import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import type { LocalHost } from '@agentui/host';

/**
 * True while any work runs that an apply must not cut off: a host call in flight (dispatch, reconcile, creation,
 * continuation), pending provider work or a provider change, or a turn whose run has started and not ended. A native
 * turn keeps running after its dispatch call returned, so the projected run state of every conversation is read too.
 */
export function hostActiveWork(host: LocalHost<TranscriptEvent, Transcript>, hostId: string,
  providers?: { status(): { readonly kind: string; readonly pending?: number } }): boolean {
  if (host.busy()) return true;
  const extensions = providers?.status();
  if (extensions?.kind === 'changing' || (extensions?.kind === 'active' && (extensions.pending ?? 0) > 0)) return true;
  let after: string | null = null;
  for (;;) {
    const page = host.listConversations(hostId, after, 100);
    for (const scope of page) {
      const run = host.inspect(scope).snapshot.document.domain.currentRun;
      if (run && run.kind !== 'ended') return true;
      after = scope.conversationId;
    }
    if (page.length < 100) return false;
  }
}
