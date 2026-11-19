import { useState, type ReactElement, type ReactNode } from 'react';
import { DesktopShell } from './Shell.js';
import { HostStatusLabel } from './HostStatusLabel.js';
import { applicationEnabled } from '../application/application-controller.js';
import { useApplication } from '../application/use-application.js';
import { ConversationStatus, ConversationView } from '../application/ConversationView.js';
import { agentPresentation } from '../application/agent-presentation.js';
import '../application/application.css';
import customization from '../application/customization-selection.js';
import { useDesktopCustomizations } from '../application/DesktopCustomizations.js';
import { CustomizationModules } from '../application/CustomizationModules.js';
import { ConversationSearch } from '../application/ConversationSearch.js';
import { ComposerAgentControls } from '../application/ComposerAgentControls.js';
import { continuationAnnouncement } from '../application/continuation-copy.js';
import { ExtensionsList, ExtensionWorkspace, conversationSlots, extensionRows, openableRow } from '../application/ExtensionsView.js';
import { conversationLabel } from '@agentui/contracts/conversation';
import type { ApplicationController } from '../application/application-controller.js';

type ConnectionPresentation =
  | { readonly kind: 'browser' }
  | { readonly kind: 'native'; readonly controls: ReactElement; readonly reconnect: () => void };

export function BrowserApplication({ children, artifact, controller: supplied, connection = { kind: 'browser' }, suspended = false }: {
  readonly children?: ReactNode; readonly artifact?: ReactNode; readonly controller?: ApplicationController;
  readonly connection?: ConnectionPresentation;
  readonly suspended?: boolean;
}) {
  const { controller, snapshot: app } = useApplication(supplied);
  const [selectedView, setSelectedView] = useState<'chats' | 'extensions' | 'settings'>('chats');
  const [selectedExtension, setSelectedExtension] = useState<string | null>(null);
  const [customizationEnabled, setCustomizationEnabled] = useState(true);
  const custom = useDesktopCustomizations({ customizations: customization, sink: controller.frontendGenerations, enabled: children === undefined && customizationEnabled });
  const [recoveryChoice, setRecoveryChoice] = useState<{ scopeKey: string; agentId: string } | null>(null);
  const pendingScope = app.saved.pendingCreation?.scope;
  const pendingScopeKey = JSON.stringify([pendingScope?.hostId, pendingScope?.conversationId]);
  const recoveryAgent = app.saved.pendingCreation?.agentId === null && recoveryChoice?.scopeKey === pendingScopeKey ? recoveryChoice.agentId : undefined;
  const enabled = applicationEnabled(app) && !suspended;
  const metadata = 'metadata' in app.host ? app.host.metadata : null;
  const choices = metadata?.agents ?? [];
  const pi = choices.find(agent => 'runtime' in agent && agent.runtime.engine === 'pi');
  const setupPi = () => setSelectedView('settings');
  const selected = choices.find(agent => agent.id === app.active?.agent.id && agent.availability.kind === 'ready')
    ?? choices.find(agent => agent.id === metadata?.defaultAgentId && agent.availability.kind === 'ready')
    ?? choices.find(agent => agent.availability.kind === 'ready');
  const options = choices.map(agent => <option key={agent.id} value={agent.id} disabled={agent.availability.kind !== 'ready'}>
    {agent.label}{agent.availability.kind !== 'ready' ? ' · Unavailable' : ''}
  </option>);
  const searchConnection = app.host.kind === 'ready' && !app.storageFailure
    ? JSON.stringify([app.host.metadata.hostId, app.host.metadata.principalId]) : null;
  const displayedAgent = app.active?.agent ?? selected;
  const runtime = displayedAgent ? ('runtime' in displayedAgent ? displayedAgent.runtime : displayedAgent) : metadata?.compatibility.nativeRuntime ?? null;
  const { agent, presentation } = agentPresentation(runtime);
  const activeActions = app.active ? controller.conversationActions(app.active) : null;
  const modules = custom.namespaces.map(owner => <CustomizationModules key={owner.namespace} owner={owner}
    active={app.active} actions={activeActions} enabled={enabled} agent={agent} />);
  const customizationsOn = children === undefined && customizationEnabled;
  const rows = extensionRows({ customizations: customization, activations: custom.namespaces, enabled: customizationsOn, metadata });
  const workspaceRow = openableRow(rows.find(row => row.namespace === selectedExtension));
  const workspaceOpen = selectedView === 'extensions' && workspaceRow !== null;
  // One element, placed in one slot: the Chats view, or the open workspace of the active conversation's namespace.
  const slots = conversationSlots({ row: workspaceOpen ? workspaceRow : null, active: app.active, metadata, custom, modules, agents: choices });
  const activeConversation = app.active && activeActions
    ? <ConversationView
        key={`${app.active.viewId}/${app.active.scope.hostId}/${app.active.scope.conversationId}`}
        transcript={slots.transcript} activity={custom.activity} contentLayout={slots.contentLayout} modules={slots.modules} permissionState={app.permissionState} observation={app.observation} continuation={app.continuation} actions={activeActions} active={app.active} enabled={enabled} storageFailure={app.storageFailure} agent={agent}
        composerControls={canSwitch => <ComposerAgentControls agents={slots.composerAgents} agent={app.active?.agent ?? null} hasConversation enabled={canSwitch && app.saved.pendingCreation === null} onStartConversation={id => void controller.create(id)} onSetupPi={setupPi} />}
      />
    : null;
  const workspaceConversation = slots.workspace ? activeConversation : null;
  const conversation = !slots.workspace && activeConversation
    ? activeConversation
    : <section className="conversation-panel empty-workspace">
        <p className="eyebrow">YOUR LOCAL WORKSPACE</p>
        <h1>A conversation that stays with you.</h1>
        <p>{app.host.kind === 'ready' && !selected ? 'No agents are available to start a conversation.' : 'Connect to your local host, then start a conversation. Your chats and drafts stay here when you come back.'}</p>
        <div className="composer empty-composer"><p>Choose your chat settings.</p><ComposerAgentControls agents={choices} agent={selected ?? null} hasConversation={false} enabled={enabled && app.saved.pendingCreation === null} onStartConversation={id => void controller.create(id)} onSetupPi={setupPi} /></div>
      </section>;
  const hostAlerts = <>
    {app.storageFailure && <div className="application-alert" role="alert"><strong>Local storage unavailable. Commands are blocked.</strong><p>{app.storageFailure}</p><p>Existing records have not been discarded. Restore browser storage access, then reload.</p></div>}
    {app.error && <p className="application-alert" role="alert">{app.error}</p>}
    {app.host.kind === 'incompatible' && <div className="application-alert" role="alert"><strong>This host is incompatible. Commands are blocked.</strong>
      {app.host.issues.map(issue => <p key={issue.dimension}>{issue.reason} {issue.action}</p>)}
    </div>}
  </>;
  const creationRecovery = app.saved.pendingCreation && <div className="creation-recovery"><p>Creation of {app.saved.pendingCreation.scope.conversationId} needs confirmation. Recovery uses the saved conversation and agent.</p>
    {app.saved.pendingCreation.agentId === null && <label className="agent-choice">Agent if this chat was not created<select aria-label="Agent for pending creation" disabled={!enabled} value={recoveryAgent ?? ''} onChange={event => setRecoveryChoice(event.target.value ? { scopeKey: pendingScopeKey, agentId: event.target.value } : null)}>
      <option value="">Check the saved chat first</option>{options}
    </select></label>}
    <button disabled={!enabled} onClick={() => void controller.recoverCreation(recoveryAgent ?? undefined)}>Recover creation</button>
  </div>;
  const extensionsView = <div className="extensions-view" inert={suspended}>
    {workspaceOpen
      ? <ExtensionWorkspace row={workspaceRow} metadata={metadata} workspaces={app.workspaces} active={app.active} controller={controller}
          conversation={workspaceConversation} status={<>{hostAlerts}{creationRecovery}</>} onBack={() => setSelectedExtension(null)} />
      : <ExtensionsList rows={rows} enabled={!suspended} onOpen={setSelectedExtension} />}
  </div>;
  const controls = <div className="application-controls">
    <h2 className="sidebar-title">{selectedView === 'chats' ? 'Chats' : selectedView === 'extensions' ? 'Extensions' : 'Settings'}</h2>
    {app.capturedSends.length > 0 && <section aria-label="Captured tools"><h3>Captured tools</h3>
      <p>Tools are retained for these sends. Execution is not enabled.</p>
      {app.capturedSends.map(send => <div key={send.key} data-captured-command={send.command.clientCommandId}>
        <p role="status">{send.status === 'waiting' ? 'Waiting for confirmed run' : send.status === 'bound' ? 'Bound to confirmed run' : 'Captured tools unavailable'} · {send.command.body.text}</p>
        {send.binding && <p>Run {send.binding.run.runId}</p>}
        {send.status !== 'unavailable' && <button type="button" onClick={() => void controller.releaseCapturedSend(send.key)}>Release captured tools</button>}
      </div>)}
    </section>}
    {app.savedViewNotice && <p role="note">{app.savedViewNotice}</p>}
    {!workspaceOpen && hostAlerts}
    {selectedView === 'extensions' && !workspaceOpen && creationRecovery}
    <div className="chat-navigation" hidden={selectedView !== 'chats'}>
      <div className="action-row">
        <button disabled={!enabled || app.saved.pendingCreation !== null || selected?.availability.kind !== 'ready'} onClick={() => void controller.create(selected?.id)}>{selected && 'runtime' in selected && selected.runtime.engine === 'agentui-recorded' ? 'New recorded conversation' : 'New conversation'}</button>
      </div>
      {creationRecovery}
      <ConversationSearch controller={controller} connectionKey={searchConnection} enabled={enabled} active={app.active?.scope ?? null}>
      {app.catalog.items.length > 0 && <nav className="conversation-catalog" aria-label="Host conversations">
        {app.catalog.items.map(({ scope, preview }) => {
          const label = conversationLabel({ scope, preview });
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
      </ConversationSearch>
    </div>
    {selectedView === 'settings' && <a className="settings-link" href="#connection-settings">Connection and app</a>}
  </div>;
  const views = <div className="chat-view" inert={suspended}>
      {conversation}
      {!app.active && modules}
    </div>;
  const settings = <section className="settings-panel" aria-label="Settings" id="connection-settings">
      <h1>Settings</h1>
      <section className="settings-section"><h2>Connection</h2>
        <div className="application-status"><strong>{presentation.hostLabel}</strong><HostStatusLabel host={app.host} /></div>
        <p>{presentation.settings}</p>
        {connection.kind === 'native' && connection.controls}
        <button disabled={suspended || app.busy || Boolean(app.storageFailure)} onClick={() => connection.kind === 'native' ? connection.reconnect() : void controller.reconnect()}>Reconnect</button>
      </section>
      <section className="settings-section" aria-label="Pi and OpenCode Go"><h2>Pi and OpenCode Go</h2>
        <p>AgentUI includes a compatible Pi runtime. Your installed Pi command is separate and is not required for this chat.</p>
        <p role="status">{pi?.availability.kind === 'ready' ? 'Pi is configured for GLM 5.3 through OpenCode Go.'
          : pi?.availability.kind === 'unavailable' ? pi.availability.reason
          : 'This host does not offer Pi. Start AgentUI with ./agentui to include Pi, or ./agentui --agent pi for Pi only.'}</p>
        {pi && <><a className="settings-link" href="/setup/pi">Open secure Pi setup</a>
          <p>In the Mac app, setup opens a separate protected window. Your API key is saved in macOS Keychain. Return here and select Reconnect after setup.</p>
          <p>In a browser, reopen this host with the AgentUI Mac app to use protected setup. You can also supply OPENCODE_GO_API_KEY in the host environment.</p></>}
        <p>Pi supports text chat, saved conversations, and Stop. Tools and file access are unavailable in this integration.</p>
      </section>
      <section className="settings-section"><h2>Appearance</h2><p>Follows system light or dark appearance.</p><label><input type="checkbox" checked={customizationEnabled} onChange={event => setCustomizationEnabled(event.target.checked)} />Enable customizations</label></section>
      <section className="settings-section"><h2>About this build</h2>{artifact}</section>
    </section>;
  // On the rail, outside the keyed conversation and outside the chats pane the shell hides while a workspace is open.
  const continuationStatus = <div id="continuation-status" className="visually-hidden" aria-live="polite" aria-atomic="true">
    {continuationAnnouncement(app.continuation, app.observation?.status.kind === 'concluded')}</div>;
  const rail = <nav className="view-rail" aria-label="Workspace views">
    {continuationStatus}
    <button type="button" aria-label="Chats" title="Chats" aria-pressed={selectedView === 'chats'} onClick={() => setSelectedView('chats')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a7.5 7.5 0 0 1-7.5 7.5H5l-3 3v-9.5A7.5 7.5 0 0 1 9.5 5H12"/><path d="M16 5h6m-3-3v6"/></svg>
    </button>
    <button type="button" aria-label="Extensions" title="Extensions" aria-pressed={selectedView === 'extensions'} onClick={() => setSelectedView('extensions')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><path d="M17.25 13.5v7.5M13.5 17.25H21"/></svg>
    </button>
    <button type="button" className="settings-view-button" aria-label="Settings" title="Settings" aria-pressed={selectedView === 'settings'} onClick={() => setSelectedView('settings')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h4m4 0h8M4 12h8m4 0h4M4 18h2m4 0h10"/><circle cx="10" cy="6" r="2"/><circle cx="14" cy="12" r="2"/><circle cx="8" cy="18" r="2"/></svg>
    </button>
  </nav>;
  return <DesktopShell navigation={rail} activeView={selectedView} protectedContent={controls} defaultView={views} settingsView={settings}
    extensionsView={extensionsView} workspaceOpen={workspaceOpen} restoreMode={children === undefined ? 'managed' : 'remount'}
    onRestore={() => { setCustomizationEnabled(false); setSelectedView('chats'); }}
    status={app.active ? <ConversationStatus active={app.active} /> : 'No conversation open'}
    buildLabel={presentation.buildLabel}>{children}</DesktopShell>;
}
