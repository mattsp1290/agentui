import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceAgent, WorkspaceViewProps } from '@agentui/sdk/react';
import { useTheme } from '@agentui/theme/react';
import { ThemeScope } from '@agentui/ui-primitives/desktop';
import { MemberForm } from './MemberForm.js';
import { initials } from './initials.js';
import { membersListOutput } from '../operation-output.js';

const CONFIGURATION = '~/.local/share/agentui/extensions.json';
const TOKEN = 'AGENTUI_EXTENSION_CREW_TOKEN';
const NEWER = 'Requires a newer Crew service';
/** A dark aubergine sidebar beside the host's light or dark message area. Layout and colour idiom only. */
const SIDEBAR = {
  light: { surface: '#3f0e40', canvas: '#3f0e40', raised: '#5b2a5d', text: '#ffffff', muted: '#e3d3e4', border: '#5b2a5d', controlBorder: '#cdb8cf', accent: '#1164a3', onAccent: '#ffffff', focus: '#ffffff' },
  dark: { surface: '#19171d', canvas: '#19171d', raised: '#2c2830', text: '#e8e8e8', muted: '#b9b7bd', border: '#34313a', controlBorder: '#8e8a93', accent: '#1d9bd1', onAccent: '#0b1a24', focus: '#e8e8e8' },
} as const;
type MemberDetail = { readonly engine: string; readonly profile: string };
const NO_DETAILS: ReadonlyMap<string, MemberDetail> = new Map();
/** A lost or overloaded member list is read again. A definitive refusal stays until the owner retries. */
const RETRYABLE_LIST = new Set(['unreachable', 'unavailable', 'timeout']);
const LIST_RETRY_MS = 1_000;

function status(agent: WorkspaceAgent): 'ready' | 'unavailable' {
  return agent.availability.kind === 'ready' ? 'ready' : 'unavailable';
}

export function CrewWorkspace(props: WorkspaceViewProps) {
  const theme = useTheme();
  // The composer's agent control offers every agent of the namespace, so the selected conversation may belong to any
  // installation: show that one while it is available. Otherwise show the first available installation, then the first.
  const selectedInstallation = props.selected
    ? props.conversations.entries.find(entry => entry.scope.conversationId === props.selected?.conversationId)?.provider.installationId
    : undefined;
  const installation = props.installations.find(item => item.installationId === selectedInstallation && item.status === 'available')
    ?? props.installations.find(item => item.status === 'available') ?? props.installations[0];
  const installationId = installation?.installationId;
  // The view shows one installation: its members, conversations and operations. Member IDs are only unique within one.
  const members = props.agents.filter((agent): agent is WorkspaceAgent & { readonly providerAgentId: string } =>
    agent.providerAgentId !== null && agent.installationId === installation?.installationId);
  const entries = useMemo(() => props.conversations.entries.filter(entry => entry.provider.installationId === installation?.installationId),
    [props.conversations.entries, installation?.installationId]);
  // Member details belong to the installation they were listed for; another installation's never show.
  const [listed, setListed] = useState<{ readonly installationId: string; readonly details: ReadonlyMap<string, MemberDetail> } | null>(null);
  const details = listed && listed.installationId === installationId ? listed.details : NO_DETAILS;
  const [listFailure, setListFailure] = useState<{ readonly installationId: string; readonly code: string } | null>(null);
  const listError = listFailure && listFailure.installationId === installationId ? listFailure.code : '';
  const [listAttempt, setListAttempt] = useState(0);
  const selectedKey = props.selected ? `${props.selected.hostId}/${props.selected.conversationId}` : null;
  // A new selection (opened here, started from the composer's agent control, or opened in Chats) or installation shows its
  // own member, so an earlier member click must not hide it. Clicking a member row after that chooses again.
  const choiceKey = `${installationId ?? ''}|${selectedKey ?? ''}`;
  const [choice, setChoice] = useState<{ readonly key: string; readonly memberId: string } | null>(null);
  const chosen = choice?.key === choiceKey ? choice.memberId : null;
  const setChosen = (memberId: string) => setChoice({ key: choiceKey, memberId });
  // The form adds a member to the installation it opened for. It closes when the shown installation changes, so an
  // unconfirmed request is never retried against another installation.
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const adding = addingFor !== null && addingFor === installationId;
  const setAdding = (open: boolean) => setAddingFor(open ? installationId ?? null : null);
  useEffect(() => { setAddingFor(current => current === installationId ? current : null); }, [installationId]);
  const [panel, setPanel] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [notice, setNotice] = useState('');
  const membersNav = useRef<HTMLElement>(null);
  // The drawer only opens from its toggle on narrow widths; move focus into it so keyboard users land on the members.
  useEffect(() => { if (drawer) membersNav.current?.querySelector<HTMLButtonElement>('button')?.focus(); }, [drawer]);
  const available = installation?.status === 'available';
  const memberKey = members.map(member => member.providerAgentId).join(',');
  useEffect(() => {
    if (!available || !installationId) return;
    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void props.call(installationId, 'members.list', {}).then(result => {
      if (!current) return;
      if (result.kind !== 'ok') {
        const code = result.kind === 'refused' ? result.code : result.cause;
        setListFailure({ installationId, code });
        if (RETRYABLE_LIST.has(code)) retry = setTimeout(() => { if (current) setListAttempt(attempt => attempt + 1); }, LIST_RETRY_MS);
        return;
      }
      setListFailure(failure => failure?.installationId === installationId ? null : failure);
      const members = membersListOutput(result.output)?.members ?? [];
      setListed({ installationId, details: new Map(members.map(member => [member.memberId, { engine: member.engine, profile: member.profile }])) });
    });
    return () => { current = false; clearTimeout(retry); };
    // Re-read details when the member set changes, or when a retryable failure is read again.
  }, [available, installationId, memberKey, listAttempt]);
  const selectedEntry = props.selected ? entries.find(entry => entry.scope.conversationId === props.selected?.conversationId) : undefined;
  // A chosen or selected member that is not listed (just created and not yet rediscovered, or deleted upstream) falls back
  // to the first member, so the pane never claims the owner has no members while the sidebar lists some.
  const wanted = chosen ?? selectedEntry?.provider.providerAgentId ?? null;
  const member = members.find(item => item.providerAgentId === wanted) ?? members[0] ?? null;
  const activeMember = member?.providerAgentId ?? null;
  const conversations = useMemo(() => entries.filter(entry => entry.provider.providerAgentId === activeMember), [entries, activeMember]);
  const showing = selectedEntry && selectedEntry.provider.providerAgentId === activeMember;
  const detail = member ? details.get(member.providerAgentId) : undefined;
  const palette = SIDEBAR[theme.appearance];
  const sidebarId = `crew-members-${installation?.installationId ?? 'none'}`;
  /** open and create reject only outside this namespace; any other failure is in the host status strip. */
  function attempt(action: () => Promise<void>) {
    setNotice('');
    void action().catch(() => setNotice('That conversation could not be opened. Refresh and try again.'));
  }

  if (!installation) {
    return <div className="crew-workspace crew-setup" role="region" aria-label="Crew setup">
      <h2>Connect Crew</h2>
      <p>Crew is not configured on this host. Add a Crew installation to <code>{CONFIGURATION}</code> with its service address and the token variable <code>{TOKEN}</code>, export that variable in the launcher's shell, and restart AgentUI.</p>
      <p>See <code>docs/extensions/crew.md</code> in the AgentUI repository for the configuration file and the network setup Crew needs.</p>
    </div>;
  }
  if (!available) {
    const reason = props.agents.find(agent => agent.installationId === installation.installationId && agent.availability.kind === 'unavailable');
    return <div className="crew-workspace crew-setup" role="region" aria-label="Crew unavailable">
      <h2>Crew is unavailable</h2>
      <p role="status">{reason?.availability.kind === 'unavailable' ? reason.availability.reason : 'Crew is offline or unreachable.'}</p>
      <button type="button" onClick={() => void props.refresh()}>Retry</button>
    </div>;
  }
  return <div className="crew-workspace" data-drawer={drawer ? 'open' : 'closed'}>
    <ThemeScope id={sidebarId} className="crew-sidebar" colors={palette}>
      <nav aria-label="Crew members" ref={membersNav}>
        <header className="crew-sidebar-header">
          <strong>{installation.installationId}</strong>
          <button type="button" className="crew-compose" aria-label="Add member" title="Add member" onClick={() => { setAdding(true); setDrawer(false); }}>+</button>
        </header>
        <h3 className="crew-section-title">Members</h3>
        <ul className="crew-member-list">
          {members.map(item => {
            const own = entries.filter(entry => entry.provider.providerAgentId === item.providerAgentId);
            const selected = item.providerAgentId === activeMember;
            return <li key={item.id}>
              <button type="button" className="crew-member-row" aria-current={selected ? 'true' : undefined}
                onClick={() => { setChosen(item.providerAgentId); setAdding(false); setDrawer(false); }}>
                <span className="crew-avatar crew-avatar-square" aria-hidden="true">{initials(item.label)}</span>
                <span className="crew-member-label">{item.label}</span>
                <span className="crew-status-dot" data-status={status(item)} role="img" aria-label={status(item) === 'ready' ? 'Available' : 'Unavailable'} />
              </button>
              {selected && own.length > 0 && <ul className="crew-conversation-list" aria-label={`Conversations with ${item.label}`}>
                {own.map(entry => <li key={entry.scope.conversationId}>
                  <button type="button" className="crew-conversation-row" aria-current={props.selected?.conversationId === entry.scope.conversationId ? 'page' : undefined}
                    onClick={() => { attempt(() => props.open(entry.scope)); setDrawer(false); }}>{entry.preview ?? 'New conversation'}</button>
                </li>)}
              </ul>}
            </li>;
          })}
          <li><button type="button" className="crew-member-row crew-add-row" onClick={() => { setAdding(true); setDrawer(false); }}>Add member</button></li>
        </ul>
        {listError && <p role="status" className="crew-section-title">{listError} <button type="button" onClick={() => setListAttempt(attempt => attempt + 1)}>Retry</button></p>}
        {props.conversations.hasMore && <button type="button" className="crew-more" onClick={() => props.conversations.more()}>More conversations</button>}
      </nav>
    </ThemeScope>
    <section className="crew-main" aria-label="Crew conversation">
      <header className="crew-header">
        <button type="button" className="crew-drawer-toggle" aria-label="Members" aria-expanded={drawer} aria-controls={sidebarId}
          onClick={() => setDrawer(open => !open)}><span aria-hidden="true">☰</span></button>
        {member ? <>
          <h2 className="crew-header-title">{member.label}</h2>
          {detail && `${detail.engine} · ${detail.profile}` !== member.label && <span className="crew-header-meta">{detail.engine} · {detail.profile}</span>}
          <button type="button" className="crew-details-toggle" aria-pressed={panel} onClick={() => setPanel(open => !open)}>Details</button>
        </> : <h2 className="crew-header-title">Crew</h2>}
      </header>
      {notice && <p role="alert" className="crew-notice">{notice}</p>}
      <div className="crew-body">
        <div className="crew-conversation">
          {adding ? <MemberForm key={installation.installationId} installationId={installation.installationId} call={props.call} refresh={props.refresh}
              onCreated={memberId => { setAdding(false); setChosen(memberId); }} onCancel={() => setAdding(false)} />
            : !member ? <div className="crew-empty-state"><p>This Crew owner has no members yet.</p>
                <button type="button" onClick={() => setAdding(true)}>Add member</button></div>
            : showing ? props.conversation
            : <div className="crew-empty-state">
                <p>{conversations.length
                  ? `Pick a conversation with ${member.label}, or start a new one.`
                  : props.conversations.hasMore
                    ? `No conversation with ${member.label} is on the loaded pages.`
                    : `No conversation with ${member.label} yet.`}</p>
                <button type="button" disabled={member.availability.kind !== 'ready'} onClick={() => attempt(() => props.create(member.id))}>Start conversation</button>
              </div>}
        </div>
        {panel && member && <aside className="crew-details" aria-label="Member details">
          <h3>Member details</h3>
          <dl>
            <dt>Member ID</dt><dd><code>{member.providerAgentId}</code></dd>
            <dt>Engine</dt><dd>{detail?.engine ?? 'Unknown'}</dd>
            <dt>Profile</dt><dd>{detail?.profile ?? 'Unknown'}</dd>
          </dl>
          <div className="crew-detail-actions">
            <button type="button" disabled title={NEWER}>Edit</button>
            <button type="button" disabled title={NEWER}>Delete</button>
          </div>
          <p className="crew-note">{NEWER} to edit or delete members.</p>
        </aside>}
      </div>
    </section>
  </div>;
}
