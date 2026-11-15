import { conversationLabel, conversationPreview } from '@agentui/contracts/conversation';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import { SERVICE_CATALOG_PAGE, SERVICE_SEARCH_EXCERPT_LENGTH } from '@agentui/contracts/service';
import type { ConversationSearchPage } from '@agentui/contracts/service';
import type { LocalHost } from '@agentui/host';

export function searchConversations(host: LocalHost<TranscriptEvent, Transcript>, request: {
  readonly hostId: string; readonly query: string; readonly after: string | null;
}): ConversationSearchPage {
  const candidates = host.listConversations(request.hostId, request.after, SERVICE_CATALOG_PAGE);
  const query = request.query.toLowerCase();
  const items: ConversationSearchPage['items'][number][] = [];
  for (const scope of candidates) {
    const transcript = host.inspect(scope).snapshot.document.domain;
    const entry = { scope, preview: conversationPreview(transcript) };
    const match = transcript.messages.map(message => message.text.replace(/\s+/gu, ' ').trim())
      .find(text => text.toLowerCase().includes(query));
    if (match === undefined && !conversationLabel(entry).toLowerCase().includes(query)) continue;
    let excerpt: string | null = null;
    if (match !== undefined) {
      const start = Math.max(0, match.toLowerCase().indexOf(query) - 40);
      excerpt = match.slice(start, start + SERVICE_SEARCH_EXCERPT_LENGTH).replace(/[\uD800-\uDBFF]$/u, '');
    }
    items.push({ ...entry, excerpt });
  }
  return { items, after: candidates.length === SERVICE_CATALOG_PAGE ? candidates.at(-1)?.conversationId ?? null : null };
}
