import { useEffect, useState } from 'react';
import type { ConversationScope } from '@agentui/contracts';
import type { WorkspaceAgent, WorkspaceViewProps } from '@agentui/sdk/react';
import { useTheme } from '@agentui/theme/react';
import { ThemeScope } from '@agentui/ui-primitives/desktop';
import { CoworkerContext, initials } from './shared.js';
import { coworkersListOutput, type CoworkerSummary } from '../operation-output.js';

const CONFIGURATION = '~/.local/share/agentui/extensions.json';
const TOKEN = 'AGENTUI_EXTENSION_COWORKERS_TOKEN';
const NEWER = 'Requires a newer Coworkers service';
/** A neutral grey surface with an indigo accent. Layout and colour idiom only. */
const PALETTE = {
  light: { canvas: '#f5f5f5', surface: '#ffffff', raised: '#ebebeb', border: '#e0e0e0', text: '#242424', muted: '#616161', accent: '#4f52b2', onAccent: '#ffffff', focus: '#4f52b2' },
  dark: { canvas: '#1f1f1f', surface: '#292929', raised: '#333333', border: '#3d3d3d', text: '#ffffff', muted: '#c7c7c7', accent: '#9ea2ff', onAccent: '#1a1b3d', focus: '#9ea2ff' },
} as const;
const WORKSPACE_ACCESS: Readonly<Record<string, string>> = { disabled: 'No workspace', read_only: 'Read-only workspace', read_write: 'Read and write workspace' };
type Coworker = WorkspaceAgent & { readonly providerAgentId: string };
const NO_DETAILS: ReadonlyMap<string, CoworkerSummary> = new Map();
/** A lost or overloaded coworker list is read again. A definitive refusal stays until the owner retries. */
const RETRYABLE_LIST = new Set(['unreachable', 'unavailable', 'timeout']);
const LIST_RETRY_MS = 1_000;

export function CoworkersWorkspace(props: WorkspaceViewProps) {
  const theme = useTheme();
  // The composer's agent control offers every agent of the namespace, so the selected chat may belong to any
  // installation: show that one while it is available. Otherwise show the first available installation, then the first.
  const selectedInstallation = props.selected
    ? props.conversations.entries.find(entry => entry.scope.conversationId === props.selected?.conversationId)?.provider.installationId
    : undefined;
  const installation = props.installations.find(item => item.installationId === selectedInstallation && item.status === 'available')
    ?? props.installations.find(item => item.status === 'available') ?? props.installations[0];
  const installationId = installation?.installationId;
  const available = installation?.status === 'available';
  // The view shows one installation: its coworkers, chats and operations. Coworker IDs are only unique within one.
  const coworkers = props.agents.filter((agent): agent is Coworker => agent.providerAgentId !== null && agent.installationId === installation?.installationId);
  const entries = props.conversations.entries.filter(entry => entry.provider.installationId === installation?.installationId);
  // The coworkers.list result and the coworker filter belong to one installation; another installation's never show.
  const [listed, setListed] = useState<{ readonly installationId: string; readonly details: ReadonlyMap<string, CoworkerSummary>;
    readonly management: boolean; readonly truncated: boolean } | null>(null);
  const own = listed && listed.installationId === installationId ? listed : null;
  const details = own?.details ?? NO_DETAILS;
  const management = own?.management ?? false;
  const truncated = own?.truncated ?? false;
  const [listFailure, setListFailure] = useState<{ readonly installationId: string; readonly code: string } | null>(null);
  const listError = listFailure && listFailure.installationId === installationId ? listFailure.code : '';
  const [listAttempt, setListAttempt] = useState(0);
  const [tab, setTab] = useState<'chat' | 'coworkers'>('chat');
  const [pill, setPill] = useState<'chat' | 'about'>('chat');
  const [filtered, setFiltered] = useState<{ readonly installationId: string | undefined; readonly coworkerId: string | null }>({ installationId, coworkerId: null });
  const filter = filtered.installationId === installationId ? filtered.coworkerId : null;
  const setFilter = (coworkerId: string | null) => setFiltered({ installationId, coworkerId });
  const [narrowPane, setNarrowPane] = useState<'list' | 'conversation'>('list');
  // The narrow layout moves to the conversation only once `selected` changes: open and create resolve without one on failure.
  // Navigating elsewhere drops the wait, so a later unrelated selection does not move the pane.
  const [awaiting, setAwaiting] = useState<{ readonly before: string | null } | null>(null);
  const [notice, setNotice] = useState('');
  const selectedKey = props.selected ? `${props.selected.hostId}/${props.selected.conversationId}` : null;
  useEffect(() => {
    if (awaiting && selectedKey !== null && selectedKey !== awaiting.before) { setAwaiting(null); setNarrowPane('conversation'); }
  }, [awaiting, selectedKey]);
  const key = coworkers.map(item => item.providerAgentId).join(',');
  useEffect(() => {
    if (!available || !installationId) return;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void props.call(installationId, 'coworkers.list', {}).then(result => {
      if (!current) return;
      if (result.kind !== 'ok') {
        const code = result.kind === 'refused' ? result.code : result.cause;
        setListFailure({ installationId, code });
        if (RETRYABLE_LIST.has(code)) retry = setTimeout(() => { if (current) setListAttempt(attempt => attempt + 1); }, LIST_RETRY_MS);
        return;
      }
      setListFailure(failure => failure?.installationId === installationId ? null : failure);
      const output = coworkersListOutput(result.output);
      setListed({ installationId, details: new Map((output?.coworkers ?? []).map(item => [item.coworkerId, item])),
        management: output?.management === true, truncated: output?.truncated === true });
    });
    return () => { current = false; clearTimeout(retry); };
  }, [available, installationId, key, listAttempt]);

  if (!installation) {
    return <div className="coworkers-workspace coworkers-setup" role="region" aria-label="Coworkers setup">
      <h2>Connect Coworkers</h2>
      <p>Coworkers is not configured on this host. Add a Coworkers installation to <code>{CONFIGURATION}</code> with its service address and the token variable <code>{TOKEN}</code>, export that variable in the launcher's shell, and restart AgentUI.</p>
      <p>The service must listen on an address this host can reach. See <code>docs/extensions/coworkers.md</code> in the AgentUI repository.</p>
    </div>;
  }
  if (!available) {
    const reason = props.agents.find(agent => agent.installationId === installation.installationId && agent.availability.kind === 'unavailable');
    return <div className="coworkers-workspace coworkers-setup" role="region" aria-label="Coworkers unavailable">
      <h2>Coworkers is unavailable</h2>
      <p role="status">{reason?.availability.kind === 'unavailable' ? reason.availability.reason : 'Coworkers is offline or unreachable.'}</p>
      <button type="button" onClick={() => void props.refresh()}>Retry</button>
    </div>;
  }
  const byId = new Map(coworkers.map(item => [item.providerAgentId, item]));
  const selectedEntry = props.selected ? entries.find(entry => entry.scope.conversationId === props.selected?.conversationId) : undefined;
  const current = selectedEntry ? byId.get(selectedEntry.provider.providerAgentId) : filter ? byId.get(filter) : undefined;
  // The selected chat still shows when its coworker is no longer listed; it is then named by its coworker ID.
  const shown = current ?? (selectedEntry ? { label: selectedEntry.provider.providerAgentId, providerAgentId: selectedEntry.provider.providerAgentId } : undefined);
  const detail = shown ? details.get(shown.providerAgentId) : undefined;
  const chats = entries.filter(entry => !filter || entry.provider.providerAgentId === filter);
  /** Opens or creates a chat. A rejection is shown here; any other failure is in the host status strip. */
  async function attempt(action: () => Promise<void>) {
    setNotice(''); setAwaiting({ before: selectedKey });
    try { await action(); }
    catch { setAwaiting(null); setNotice('That chat could not be opened. Refresh the list and try again.'); }
  }
  function openChat(scope: ConversationScope) {
    if (selectedKey === `${scope.hostId}/${scope.conversationId}`) { setNarrowPane('conversation'); return; }
    void attempt(() => props.open(scope));
  }
  function chatWith(coworker: Coworker) {
    setTab('chat'); setFilter(coworker.providerAgentId); setPill('chat');
    const first = entries.find(entry => entry.provider.providerAgentId === coworker.providerAgentId);
    if (first) { openChat(first.scope); return; }
    if (props.conversations.hasMore) {
      setNotice(`No chat with ${coworker.label} is on the loaded pages. Use More chats to keep looking, or New chat to start one.`);
      return;
    }
    void attempt(() => props.create(coworker.id));
  }
  const target = current ?? (filter ? byId.get(filter) : coworkers[0]);
  return <ThemeScope className="coworkers-workspace" colors={PALETTE[theme.appearance]} data-pane={narrowPane}>
    <nav className="coworkers-app-bar" aria-label="Coworkers app bar">
      <div role="group" aria-label="Coworkers sections" className="coworkers-sections">
        <button type="button" aria-pressed={tab === 'chat'} onClick={() => { setAwaiting(null); setTab('chat'); }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>Chat</button>
        <button type="button" aria-pressed={tab === 'coworkers'} onClick={() => { setAwaiting(null); setTab('coworkers'); }}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c0-3.3 2.7-5 6-5s6 1.7 6 5M14 19c0-2 1.5-3.5 4-3.5s3 1 3 3.5"/></svg>Coworkers</button>
      </div>
    </nav>
    {tab === 'coworkers' ? <section className="coworkers-directory" aria-label="Coworker directory">
      <header className="coworkers-directory-header">
        <h2>Coworkers</h2>
        <button type="button" disabled={!management} title={management ? undefined : NEWER}>New coworker</button>
      </header>
      {truncated && <p role="status" className="coworkers-notice">Details for some coworkers were not loaded.</p>}
      {listError && <p role="status" className="coworkers-notice">{listError} <button type="button" onClick={() => setListAttempt(attempt => attempt + 1)}>Retry</button></p>}
      <ul className="coworkers-cards">
        {coworkers.map(item => {
          const info = details.get(item.providerAgentId);
          return <li key={item.id} className="coworkers-card">
            <span className="coworkers-avatar coworkers-avatar-large" aria-hidden="true">{initials(item.label)}</span>
            <strong>{item.label}</strong>
            {info && <span className="coworkers-role">{info.role}</span>}
            <div className="coworkers-badges">
              {info && <span className="coworkers-badge">{WORKSPACE_ACCESS[info.workspace] ?? info.workspace}</span>}
              {info?.slack && <span className="coworkers-badge">Slack</span>}
            </div>
            <div className="coworkers-card-actions">
              <button type="button" disabled={item.availability.kind !== 'ready'} aria-label={`Chat with ${item.label}`} onClick={() => chatWith(item)}>Chat</button>
              <button type="button" disabled={!management} title={management ? undefined : NEWER}>Edit</button>
              <button type="button" disabled={!management} title={management ? undefined : NEWER}>Delete</button>
            </div>
          </li>;
        })}
      </ul>
    </section> : <>
      <section className="coworkers-chat-list" aria-label="Chats">
        <header className="coworkers-chat-list-header">
          <h2>Chats</h2>
          {target && <button type="button" onClick={() => void attempt(() => props.create(target.id))}>New chat</button>}
        </header>
        {notice && <p role="alert" className="coworkers-notice">{notice}</p>}
        {listError && <p role="status" className="coworkers-notice">{listError} <button type="button" onClick={() => setListAttempt(attempt => attempt + 1)}>Retry</button></p>}
        {filter && <button type="button" className="coworkers-filter" onClick={() => { setAwaiting(null); setFilter(null); }}>Showing {byId.get(filter)?.label ?? filter} · Show all</button>}
        {chats.length === 0 && <p className="coworkers-empty">{props.conversations.hasMore
          ? 'No matching chats on the loaded pages. Load more chats to keep looking.'
          : 'No chats yet. Open the Coworkers tab and choose Chat.'}</p>}
        <ul className="coworkers-chat-cards">
          {chats.map(entry => {
            const who = byId.get(entry.provider.providerAgentId);
            const name = who?.label ?? entry.provider.providerAgentId;
            return <li key={entry.scope.conversationId}>
              <button type="button" className="coworkers-chat-card" aria-current={props.selected?.conversationId === entry.scope.conversationId ? 'page' : undefined}
                onClick={() => openChat(entry.scope)}>
                <span className="coworkers-avatar" aria-hidden="true">{initials(name)}</span>
                <span className="coworkers-chat-text"><strong>{name}</strong><span>{entry.preview ?? 'New chat'}</span></span>
              </button>
            </li>;
          })}
        </ul>
        {props.conversations.hasMore && <button type="button" className="coworkers-more" onClick={() => props.conversations.more()}>More chats</button>}
      </section>
      <section className="coworkers-main" aria-label="Coworker conversation">
        {shown ? <>
          <header className="coworkers-header">
            <button type="button" className="coworkers-back" onClick={() => { setAwaiting(null); setNarrowPane('list'); }}>Chats</button>
            <span className="coworkers-avatar" aria-hidden="true">{initials(shown.label)}</span>
            <div className="coworkers-header-text"><h2>{shown.label}</h2>{detail && <span className="coworkers-role">{detail.role}</span>}</div>
            <div className="coworkers-pills" role="group" aria-label="Conversation views">
              <button type="button" aria-pressed={pill === 'chat'} onClick={() => setPill('chat')}>Chat</button>
              <button type="button" aria-pressed={pill === 'about'} onClick={() => setPill('about')}>About</button>
            </div>
          </header>
          <div className="coworkers-pane">
            {pill === 'about' ? <dl className="coworkers-about" aria-label={`About ${shown.label}`}>
              <dt>Coworker ID</dt><dd><code>{shown.providerAgentId}</code></dd>
              <dt>Role</dt><dd>{detail?.role ?? 'Unknown'}</dd>
              <dt>Workspace access</dt><dd>{detail ? WORKSPACE_ACCESS[detail.workspace] ?? detail.workspace : 'Unknown'}</dd>
              <dt>Instructions</dt><dd>{detail ? `${detail.instructionsBytes} bytes` : 'Unknown'}</dd>
            </dl> : selectedEntry && props.conversation
              ? <CoworkerContext.Provider value={{ name: shown.label }}>{props.conversation}</CoworkerContext.Provider>
              : <div className="coworkers-empty-state"><p>No chat with {shown.label} is open.</p>
                  {current && <button type="button" onClick={() => void attempt(() => props.create(current.id))}>Start a chat</button>}</div>}
          </div>
        </> : <div className="coworkers-empty-state"><p>Choose a chat, or open the Coworkers tab to start one.</p></div>}
      </section>
    </>}
  </ThemeScope>;
}
