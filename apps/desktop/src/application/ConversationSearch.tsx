import { useEffect, useId, useState, type ReactNode } from 'react';
import { conversationLabel } from '@agentui/contracts/conversation';
import type { ConversationScope } from '@agentui/contracts';
import { SERVICE_SEARCH_QUERY_LENGTH } from '@agentui/contracts/service';
import type { ConversationSearchEntry } from '@agentui/contracts/service';
import type { ApplicationController } from './application-controller.js';

type SearchResult = { readonly query: string; readonly items: readonly ConversationSearchEntry[] } & (
  | { readonly kind: 'loading' | 'ready' }
  | { readonly kind: 'failed'; readonly error: string }
);

export function ConversationSearch({ controller, connectionKey, enabled, active, children }: {
  readonly controller: ApplicationController;
  readonly connectionKey: string | null;
  readonly enabled: boolean;
  readonly active: ConversationScope | null;
  readonly children: ReactNode;
}) {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<SearchResult>({ query: '', kind: 'ready', items: [] });
  const [selected, setSelected] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const listId = useId();
  const query = input.replace(/\s+/gu, ' ').trim();
  function change(value: string): void {
    setInput(value);
    setSelected(null);
    if (value.replace(/\s+/gu, ' ').trim() !== query) setResult({ query: '', kind: 'ready', items: [] });
  }
  useEffect(() => {
    if (!query || connectionKey === null) { setResult({ query: '', kind: 'ready', items: [] }); return; }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        const items = new Map<string, ConversationSearchEntry>();
        let after: string | null = null;
        setResult({ query, kind: 'loading', items: [] });
        try {
          do {
            const page = await controller.search(query, after, abort.signal);
            if (abort.signal.aborted) return;
            for (const entry of page.items) items.set(entry.scope.conversationId, entry);
            after = page.after;
            setResult({ query, kind: after === null ? 'ready' : 'loading', items: [...items.values()] });
          } while (after !== null);
        } catch (cause) {
          if (!abort.signal.aborted) setResult({ query, kind: 'failed', items: [...items.values()],
            error: cause instanceof Error ? cause.message : 'Search could not finish.' });
        }
      })();
    }, 200);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [controller, query, connectionKey, retry]);
  const current = result.query === query && connectionKey !== null ? result : null;
  const items = current?.items ?? [];
  const selectedIndex = items.findIndex(entry => entry.scope.conversationId === selected);
  return <section className="chat-search" aria-label="Saved chat search">
    <label htmlFor={`${listId}-input`}>Search chats</label>
    <input id={`${listId}-input`} type="search" role="combobox" autoComplete="off" maxLength={SERVICE_SEARCH_QUERY_LENGTH}
      placeholder="Search messages and chats" value={input} disabled={connectionKey === null}
      aria-controls={listId} aria-expanded={Boolean(query)} aria-autocomplete="list"
      aria-activedescendant={selectedIndex < 0 ? undefined : `${listId}-${selectedIndex}`}
      onChange={event => change(event.target.value)}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === 'Escape') { change(''); event.preventDefault(); }
        if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && items.length > 0) {
          event.preventDefault();
          const index = event.key === 'ArrowDown' ? (selectedIndex + 1) % items.length
            : (selectedIndex < 0 ? items.length - 1 : (selectedIndex - 1 + items.length) % items.length);
          const next = items[index];
          if (next) { setSelected(next.scope.conversationId); document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: 'nearest' }); }
        }
        if (event.key === 'Enter' && enabled) {
          const entry = items[selectedIndex < 0 ? 0 : selectedIndex];
          if (entry) { event.preventDefault(); void controller.open(entry.scope); }
        }
      }} />
    {input && <button type="button" onClick={() => change('')}>Clear search</button>}
    {query && <>
      <p role="status" className="search-status">{connectionKey === null ? 'Connect to the host to search saved chats.'
        : current?.kind === 'failed' ? 'Search incomplete.'
          : current?.kind !== 'ready' ? `Searching saved chats… ${items.length} found.`
            : items.length === 0 ? 'No matching chats.' : `${items.length} matching ${items.length === 1 ? 'chat' : 'chats'}.`}</p>
      {current?.kind === 'failed' && <div role="alert"><p>{current.error}</p>
        <button type="button" onClick={() => { setResult({ query, kind: 'loading', items: [] }); setRetry(value => value + 1); }}>Retry search</button></div>}
    </>}
    <div id={listId} role="listbox" aria-label="Search results" hidden={!query}>
      {items.map((entry, index) => <button type="button" role="option" id={`${listId}-${index}`} key={entry.scope.conversationId}
        disabled={!enabled} aria-selected={selectedIndex === index} aria-current={entry.scope.conversationId === active?.conversationId ? 'page' : undefined}
        onFocus={() => setSelected(entry.scope.conversationId)} onClick={() => void controller.open(entry.scope)}>
        <span>{conversationLabel(entry)}</span>{entry.excerpt && <small>{entry.excerpt}</small>}
      </button>)}
    </div>
    <div hidden={Boolean(query)}>{children}</div>
  </section>;
}
