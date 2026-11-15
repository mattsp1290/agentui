import { PI_CHAT_LABEL } from '@agentui/contracts/compatibility';
import { useState, type ReactNode } from 'react';
import { DesktopShell } from './Shell.js';
import { PairForm } from './PairForm.js';
import { HostStatusLabel } from './HostStatusLabel.js';
import { applicationEnabled } from '../application/application-controller.js';
import { useApplication } from '../application/use-application.js';
import { ConversationStatus, ConversationView } from '../application/ConversationView.js';
import '../application/application.css';
import customization from '../application/customization-selection.js';
import { CustomizationModules } from '../application/CustomizationModules.js';

export function BrowserApplication({ children, artifact }: { readonly children?: ReactNode; readonly artifact?: ReactNode }) {
  const { controller, snapshot: app } = useApplication();
  const [selectedView, setSelectedView] = useState<'chats' | 'settings'>('chats');
  const [customizationEnabled, setCustomizationEnabled] = useState(true);
  const enabled = applicationEnabled(app);
  const runtime = 'metadata' in app.host ? app.host.metadata.compatibility.nativeRuntime : null;
  const agent = runtime?.engine === 'codex' ? 'codex' : runtime?.engine === 'pi' ? 'pi' : runtime?.engine === 'agentui-recorded' ? 'recorded' : 'local';
  const hostLabel = runtime === null ? 'Local agent' : agent === 'codex' ? `Codex · ${runtime.version}` : agent === 'pi' ? PI_CHAT_LABEL : 'Browser development · Recorded playback';
  const conversation = app.active
    ? <ConversationView
        key={`${app.active.viewId}/${app.active.scope.hostId}/${app.active.scope.conversationId}`}
        actions={controller.conversationActions(app.active)} active={app.active} enabled={enabled} storageFailure={app.storageFailure} agent={agent}
      />
    : <section className="conversation-panel empty-workspace">
        <p className="eyebrow">YOUR LOCAL WORKSPACE</p>
        <h1>A conversation that stays with you.</h1>
        <p>Connect to your local host, then start a conversation. Your chats and drafts stay here when you come back.</p>
      </section>;
  const controls = <div className="application-controls">
    <h2 className="sidebar-title">{selectedView === 'chats' ? 'Chats' : 'Settings'}</h2>
    {app.savedViewNotice && <p role="note">{app.savedViewNotice}</p>}
    {app.storageFailure && <div className="application-alert" role="alert"><strong>Local storage unavailable. Commands are blocked.</strong><p>{app.storageFailure}</p><p>Existing records have not been discarded. Restore browser storage access, then reload.</p></div>}
    {app.error && <p className="application-alert" role="alert">{app.error}</p>}
    {app.host.kind === 'incompatible' && <div className="application-alert" role="alert"><strong>This host is incompatible. Commands are blocked.</strong>
      {app.host.issues.map(issue => <p key={issue.dimension}>{issue.reason} {issue.action}</p>)}
    </div>}
    {app.host.kind === 'unpaired' && <PairForm disabled={app.busy || Boolean(app.storageFailure)} pair={code => controller.pair(code)} />}
    <div className="chat-navigation" hidden={selectedView !== 'chats'}>
      <div className="action-row">
        <button disabled={!enabled || app.saved.pendingCreation !== null} onClick={() => void controller.create()}>{agent === 'recorded' ? 'New recorded conversation' : 'New conversation'}</button>
      </div>
      {app.saved.pendingCreation && <div className="creation-recovery"><p>Creation of {app.saved.pendingCreation.conversationId} needs confirmation. Recovery uses the saved conversation ID.</p>
        <button disabled={!enabled} onClick={() => void controller.recoverCreation()}>Recover creation</button>
      </div>}
      {app.catalog.items.length > 0 && <nav className="conversation-catalog" aria-label="Host conversations">
        {app.catalog.items.map(({ scope, preview }) => {
          const label = preview ?? `New chat · ${scope.conversationId.slice(-8)}`;
          return <button key={scope.conversationId} disabled={!enabled}
            title={scope.conversationId} aria-label={`${label} · Open conversation ${scope.conversationId}`}
            aria-current={scope.conversationId === app.active?.scope.conversationId ? 'page' : undefined}
            onClick={() => void controller.open(scope)}>{label}</button>;
        })}
        {app.catalog.after !== null && <button disabled={!enabled} onClick={() => void controller.moreConversations()}>More conversations</button>}
      </nav>}
      {(app.savedViews.items.length > 0 || app.savedViews.after !== null) && <nav className="conversation-catalog" aria-label="Saved local views">
        {app.savedViews.items.map(viewId => <button key={viewId} disabled={!enabled} onClick={() => void controller.reopenView(viewId)}>Reopen saved view {viewId}</button>)}
        {app.savedViews.after !== null && <button disabled={!enabled} onClick={() => void controller.moreSavedViews()}>More saved views</button>}
      </nav>}
    </div>
    {selectedView === 'settings' && <a className="settings-link" href="#connection-settings">Connection and app</a>}
  </div>;
  const views = <>
    <div className="chat-view" hidden={selectedView !== 'chats'}>{conversation}
      {children === undefined && customization && customizationEnabled && <CustomizationModules customization={customization}
        active={app.active} actions={app.active ? controller.conversationActions(app.active) : null} enabled={enabled} agent={agent} />}
    </div>
    <section className="settings-panel" hidden={selectedView !== 'settings'} aria-label="Settings" id="connection-settings">
      <h1>Settings</h1>
      <section className="settings-section"><h2>Connection</h2>
        <div className="application-status"><strong>{hostLabel}</strong><HostStatusLabel host={app.host} /></div>
        <p>{agent === 'pi' ? 'The local host saves your conversations. Pi provides text chat without tools.' : 'The local host manages your saved conversations and approvals.'}</p>
        <button disabled={app.busy || Boolean(app.storageFailure)} onClick={() => void controller.reconnect()}>Reconnect</button>
      </section>
      <section className="settings-section"><h2>Appearance</h2><p>Follows system light or dark appearance.</p></section>
      <section className="settings-section"><h2>About this build</h2>{artifact}</section>
    </section>
  </>;
  const rail = <nav className="view-rail" aria-label="Workspace views">
    <button type="button" aria-label="Chats" title="Chats" aria-pressed={selectedView === 'chats'} onClick={() => setSelectedView('chats')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3v-9.5A7.5 7.5 0 0 1 9.5 5H12"/><path d="M16 5h6m-3-3v6"/></svg>
    </button>
    <button type="button" className="settings-view-button" aria-label="Settings" title="Settings" aria-pressed={selectedView === 'settings'} onClick={() => setSelectedView('settings')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h4m4 0h8M4 12h8m4 0h4M4 18h2m4 0h10"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></svg>
    </button>
  </nav>;
  return <DesktopShell navigation={rail} activeView={selectedView} protectedContent={controls} defaultView={views} restoreMode={children === undefined ? 'managed' : 'remount'}
    onRestore={() => { setCustomizationEnabled(false); setSelectedView('chats'); }}
    status={app.active ? <ConversationStatus active={app.active} /> : 'No conversation open'}
    buildLabel={runtime === null ? 'Local host' : agent === 'codex' ? 'Local Codex host' : agent === 'pi' ? PI_CHAT_LABEL : 'Browser development · Recorded host'}>{children}</DesktopShell>;
}
