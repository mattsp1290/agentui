import { conversationLabel, conversationPreview } from '@agentui/contracts/conversation';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import { SERVICE_CATALOG_PAGE, SERVICE_SEARCH_EXCERPT_LENGTH } from '@agentui/contracts/service';
import type { ConversationSearchPage } from '@agentui/contracts/service';
import type { LocalHost } from '@agentui/host';
import { conversationProvider } from './agents.js';

export function searchConversations(host: LocalHost<TranscriptEvent, Transcript>, request: {
  readonly hostId: string; readonly query: string; readonly after: string | null;
}): ConversationSearchPage {
  // Text in an earlier segment of a continued chat stays findable; opening the hit follows the chain to its newest segment.
  const candidates = host.listConversations(request.hostId, request.after, SERVICE_CATALOG_PAGE, { everySegment: true });
  const query = request.query.toLowerCase();
  const items: ConversationSearchPage['items'][number][] = [];
  for (const scope of candidates) {
    const inspected = host.inspect(scope), transcript = inspected.snapshot.document.domain;
    const entry = { scope, preview: conversationPreview(transcript), provider: conversationProvider(inspected.installation) };
    const match = transcript.messages.map(message => message.text.replace(/\s+/gu, ' ').trim())
      .find(text => text.toLowerCase().includes(query));
    if (match === undefined && !conversationLabel(entry).toLowerCase().includes(query)) continue;
    let excerpt: string | null = null;
    if (match !== undefined) {
      const at = match.toLowerCase().indexOf(query);
      let from = 0, to = 0, lowered = 0;
      // Match the whole string for contextual casing, then map only the hit boundaries.
      for (const character of match) {
        if (lowered <= at) from = to;
        to += character.length;
        lowered += character.toLowerCase().length;
        if (lowered >= at + query.length) break;
      }
      let start = Math.max(0, from - 40);
      if (to - start > SERVICE_SEARCH_EXCERPT_LENGTH && to - from <= SERVICE_SEARCH_EXCERPT_LENGTH) {
        start = to - SERVICE_SEARCH_EXCERPT_LENGTH;
      }
      if (/[\uDC00-\uDFFF]/u.test(match[start] ?? '')) start++;
      excerpt = match.slice(start, start + SERVICE_SEARCH_EXCERPT_LENGTH).replace(/[\uD800-\uDBFF]$/u, '');
    }
    items.push({ ...entry, excerpt });
  }
  return { items, after: candidates.length === SERVICE_CATALOG_PAGE ? candidates.at(-1)?.conversationId ?? null : null };
}
