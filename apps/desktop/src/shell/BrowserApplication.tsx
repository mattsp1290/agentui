import { useState, type ReactNode } from 'react';
import { DesktopShell } from './Shell.js';
import { applicationEnabled } from '../application/application-controller.js';
import { useApplication } from '../application/use-application.js';
import { ConversationStatus, ConversationView } from '../application/ConversationView.js';
import '../application/application.css';

export function BrowserApplication({ children, artifact }: { readonly children?: ReactNode; readonly artifact?: ReactNode }) {
  const { controller, snapshot: app } = useApplication();
  const enabled = applicationEnabled(app);
  const [code, setCode] = useState('');
  const conversation = app.active ? <ConversationView key={`${app.active.viewId}/${app.active.scope.hostId}/${app.active.scope.conversationId}`} actions={controller.conversationActions(app.active)} active={app.active} />
    : <section className="conversation-panel empty-workspace"><p className="eyebrow">YOUR LOCAL WORKSPACE</p><h1>A conversation that stays with you.</h1><p>Pair this browser, then create or open a recorded conversation. Drafts belong to this tab. The host keeps the conversation when you close it.</p></section>;
  const controls = <div className="application-controls">
    <div className="application-status"><strong>Browser development · Recorded playback</strong>
      <span>{app.host.kind === 'ready' ? `Host ${app.host.metadata.hostId}` : app.host.kind === 'unpaired' ? 'Pairing required' : app.host.kind === 'loading' ? 'Opening saved view…' : 'Host unavailable'}</span>
    </div>
    {artifact}
    {app.savedViewNotice && <p role="note">{app.savedViewNotice}</p>}
    {app.storageFailure && <div className="application-alert" role="alert"><strong>Local storage unavailable. Commands are blocked.</strong><p>{app.storageFailure}</p><p>Existing records have not been discarded. Restore browser storage access, then reload.</p></div>}
    {app.error && <p className="application-alert" role="alert">{app.error}</p>}
    {app.host.kind === 'ready' && app.host.compatibility.kind === 'incompatible' && <div className="application-alert" role="alert"><strong>This host is incompatible. Commands are blocked.</strong>
      {app.host.compatibility.issues.map(issue => <p key={issue.dimension}>{issue.reason} {issue.action}</p>)}
    </div>}
    {app.host.kind === 'unpaired' && <form className="pair-form" onSubmit={event => { event.preventDefault(); void controller.pair(code); setCode(''); }}>
      <label htmlFor="pairing-code">Pairing code</label><input id="pairing-code" value={code} onChange={event => setCode(event.target.value)} autoComplete="off" placeholder="Code from the local host" />
      <button disabled={app.busy || Boolean(app.storageFailure) || !code.trim()}>Pair host</button>
    </form>}
    <div className="action-row">
      <button disabled={app.busy || Boolean(app.storageFailure)} onClick={() => void controller.reconnect()}>Reconnect</button>
      <button disabled={!enabled || app.saved.pendingCreation !== null} onClick={() => void controller.create()}>New recorded conversation</button>
    </div>
    {app.saved.pendingCreation && <div className="creation-recovery"><p>Creation of {app.saved.pendingCreation.conversationId} needs confirmation. Recovery uses the saved conversation ID.</p>
      <button disabled={!enabled} onClick={() => void controller.recoverCreation()}>Recover creation</button>
    </div>}
    {app.catalog.items.length > 0 && <nav className="conversation-catalog" aria-label="Host conversations">
      {app.catalog.items.map(scope => <button key={scope.conversationId} disabled={!enabled}
        aria-current={scope.conversationId === app.active?.scope.conversationId ? 'page' : undefined}
        onClick={() => void controller.open(scope)}>Open conversation {scope.conversationId}</button>)}
      {app.catalog.after !== null && <button disabled={!enabled} onClick={() => void controller.moreConversations()}>More conversations</button>}
    </nav>}
    {(app.savedViews.items.length > 0 || app.savedViews.after !== null) && <nav className="conversation-catalog" aria-label="Saved local views">
      {app.savedViews.items.map(viewId => <button key={viewId} disabled={!enabled} onClick={() => void controller.reopenView(viewId)}>Reopen saved view {viewId}</button>)}
      {app.savedViews.after !== null && <button disabled={!enabled} onClick={() => void controller.moreSavedViews()}>More saved views</button>}
    </nav>}
  </div>;
  return <DesktopShell protectedContent={controls} defaultView={conversation}
    status={app.active ? <ConversationStatus active={app.active} /> : 'No conversation open'}
    buildLabel="Browser development · Recorded host">{children}</DesktopShell>;
}
