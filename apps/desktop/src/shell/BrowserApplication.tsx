import type { ReactNode } from 'react';
import { DesktopShell } from './Shell.js';
import { PairForm } from './PairForm.js';
import { HostStatusLabel } from './HostStatusLabel.js';
import { applicationEnabled } from '../application/application-controller.js';
import { useApplication } from '../application/use-application.js';
import { ConversationStatus, ConversationView } from '../application/ConversationView.js';
import '../application/application.css';

export function BrowserApplication({ children, artifact }: { readonly children?: ReactNode; readonly artifact?: ReactNode }) {
  const { controller, snapshot: app } = useApplication();
  const enabled = applicationEnabled(app);
  const runtime = 'metadata' in app.host ? app.host.metadata.compatibility.nativeRuntime : null;
  const agent = runtime?.engine === 'codex' ? 'codex' : runtime?.engine === 'agentui-recorded' ? 'recorded' : 'local';
  const hostLabel = runtime === null ? 'Local agent' : agent === 'codex' ? `Codex · ${runtime.version}` : 'Browser development · Recorded playback';
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
    <div className="application-status"><strong>{hostLabel}</strong>
      <HostStatusLabel host={app.host} />
    </div>
    {artifact}
    {app.savedViewNotice && <p role="note">{app.savedViewNotice}</p>}
    {app.storageFailure && <div className="application-alert" role="alert"><strong>Local storage unavailable. Commands are blocked.</strong><p>{app.storageFailure}</p><p>Existing records have not been discarded. Restore browser storage access, then reload.</p></div>}
    {app.error && <p className="application-alert" role="alert">{app.error}</p>}
    {app.host.kind === 'incompatible' && <div className="application-alert" role="alert"><strong>This host is incompatible. Commands are blocked.</strong>
      {app.host.issues.map(issue => <p key={issue.dimension}>{issue.reason} {issue.action}</p>)}
    </div>}
    {app.host.kind === 'unpaired' && <PairForm disabled={app.busy || Boolean(app.storageFailure)} pair={code => controller.pair(code)} />}
    <div className="action-row">
      <button disabled={app.busy || Boolean(app.storageFailure)} onClick={() => void controller.reconnect()}>Reconnect</button>
      <button disabled={!enabled || app.saved.pendingCreation !== null} onClick={() => void controller.create()}>{agent === 'recorded' ? 'New recorded conversation' : 'New conversation'}</button>
    </div>
    {app.saved.pendingCreation && <div className="creation-recovery"><p>Creation of {app.saved.pendingCreation.conversationId} needs confirmation. Recovery uses the saved conversation ID.</p>
      <button disabled={!enabled} onClick={() => void controller.recoverCreation()}>Recover creation</button>
    </div>}
    {app.catalog.items.length > 0 && <nav className="conversation-catalog" aria-label="Host conversations">
      {app.catalog.items.map((scope, index) => <button key={scope.conversationId} disabled={!enabled}
        title={scope.conversationId} aria-label={`Open conversation ${scope.conversationId}`}
        aria-current={scope.conversationId === app.active?.scope.conversationId ? 'page' : undefined}
        onClick={() => void controller.open(scope)}>Conversation {index + 1}</button>)}
      {app.catalog.after !== null && <button disabled={!enabled} onClick={() => void controller.moreConversations()}>More conversations</button>}
    </nav>}
    {(app.savedViews.items.length > 0 || app.savedViews.after !== null) && <nav className="conversation-catalog" aria-label="Saved local views">
      {app.savedViews.items.map(viewId => <button key={viewId} disabled={!enabled} onClick={() => void controller.reopenView(viewId)}>Reopen saved view {viewId}</button>)}
      {app.savedViews.after !== null && <button disabled={!enabled} onClick={() => void controller.moreSavedViews()}>More saved views</button>}
    </nav>}
  </div>;
  return <DesktopShell protectedContent={controls} defaultView={conversation}
    status={app.active ? <ConversationStatus active={app.active} /> : 'No conversation open'}
    buildLabel={runtime === null ? 'Local host' : agent === 'codex' ? 'Local Codex host' : 'Browser development · Recorded host'}>{children}</DesktopShell>;
}
