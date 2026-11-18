import { Suspense, useEffect, useState, type ReactNode } from 'react';
import type { ConversationScope, Json } from '@agentui/contracts';
import { sameScope } from '@agentui/contracts';
import type { AgentDescriptor, CustomizationStatus, ExtensionCallValue, ServiceMetadata } from '@agentui/contracts/service';
import { classifyExtensionCall } from '@agentui/contracts/service';
import type { WorkspaceAgent, WorkspaceContribution, WorkspaceConversation, WorkspaceViewProps } from '@agentui/sdk/react';
import { CustomizationBoundary, workspaceTranscript, type ContentLayoutSelection, type DesktopCustomization, type NamespaceActivation, type TranscriptSelection } from './DesktopCustomizations.js';
import type { ApplicationController, OpenConversation, WorkspaceConversations } from './application-controller.js';
import { BUILD_PHASES, buildFailureMessage, outcomeMessage } from './customization-messages.js';

export type ExtensionRowState = 'Ready' | 'Not configured' | 'Unavailable' | 'No view' | 'Failed' | 'Disabled' | 'Loading';
export interface ExtensionRow {
  readonly namespace: string;
  readonly label: string;
  readonly state: ExtensionRowState;
  readonly detail: string | null;
  readonly owner: Extract<NamespaceActivation, { readonly kind: 'ready' }> | null;
  readonly workspace: WorkspaceContribution | null;
}
/** A row whose workspace can open: its namespace is ready and contributes a workspace. */
export type OpenableRow = ExtensionRow & { readonly owner: NonNullable<ExtensionRow['owner']>; readonly workspace: WorkspaceContribution };
const CLOSED_STATES: ReadonlySet<ExtensionRowState> = new Set(['Disabled', 'Failed', 'Loading']);
export function openableRow(row: ExtensionRow | undefined): OpenableRow | null {
  return row?.owner && row.workspace && !CLOSED_STATES.has(row.state) ? { ...row, owner: row.owner, workspace: row.workspace } : null;
}
type ProviderAgent = Extract<AgentDescriptor, { readonly kind: 'provider' }>;
const SERVER_FAILURE = 'The server extension failed to load. Check the extension configuration, then restart the host.';
const UNAVAILABLE = 'The provider service is offline or unreachable. AgentUI checks again automatically.';

export function namespaceAgents(metadata: ServiceMetadata | null, namespace: string): readonly ProviderAgent[] {
  return (metadata?.agents ?? []).filter((agent): agent is ProviderAgent => 'kind' in agent && agent.namespace === namespace);
}

export interface ConversationSlots {
  /** The workspace row that renders the active conversation, or null when the Chats view does. */
  readonly workspace: OpenableRow | null;
  readonly transcript: TranscriptSelection;
  readonly contentLayout: ContentLayoutSelection;
  readonly modules: ReactNode;
  readonly composerAgents: readonly AgentDescriptor[];
}
/**
 * Where the active conversation renders, and which customization slots apply there.
 * At most one conversation view is mounted. The Chats view keeps its (hidden) view while Settings is open, and gives it
 * up only while the open workspace of the active conversation's namespace renders it. `row` is only set while that
 * workspace is open, so a Failed, Loading or Disabled row never takes the view without rendering one.
 */
export function conversationSlots({ row, active, metadata, custom, modules, agents }: {
  readonly row: OpenableRow | null; readonly active: OpenConversation | null; readonly metadata: ServiceMetadata | null;
  readonly custom: { readonly transcript: TranscriptSelection; readonly contentLayout: ContentLayoutSelection };
  readonly modules: ReactNode; readonly agents: readonly AgentDescriptor[];
}): ConversationSlots {
  const workspace = row && active && 'kind' in active.agent && active.agent.namespace === row.namespace ? row : null;
  if (!workspace) return { workspace: null, transcript: custom.transcript, contentLayout: custom.contentLayout, modules, composerAgents: agents };
  return {
    workspace,
    transcript: workspace.workspace.transcript ? workspaceTranscript(workspace.owner, workspace.workspace.transcript) : custom.transcript,
    contentLayout: { kind: 'default' }, modules: null, composerAgents: namespaceAgents(metadata, workspace.namespace),
  };
}

/** One row per namespace in the static desktop selection or the host's configured server extensions, sorted by namespace. */
export function extensionRows({ customizations, activations, enabled, metadata }: {
  readonly customizations: readonly DesktopCustomization[]; readonly activations: readonly NamespaceActivation[];
  readonly enabled: boolean; readonly metadata: ServiceMetadata | null;
}): readonly ExtensionRow[] {
  const bundled = new Set(customizations.map(item => item.manifest.namespace));
  const names = [...new Set([...bundled, ...(metadata?.extensions ?? []).map(item => item.namespace)])].sort();
  return names.map(namespace => {
    const activation = activations.find(item => item.namespace === namespace);
    const descriptor = metadata?.extensions.find(item => item.namespace === namespace);
    const owner = activation?.kind === 'ready' ? activation : null;
    const workspace = owner?.presentation.workspace ?? null;
    const row = (state: ExtensionRowState, detail: string | null = null): ExtensionRow =>
      ({ namespace, label: workspace?.label ?? namespace, state, detail, owner, workspace });
    if (!bundled.has(namespace)) return row(descriptor?.state === 'failed' ? 'Failed' : 'No view', descriptor?.state === 'failed' ? SERVER_FAILURE : null);
    if (!enabled) return row('Disabled', 'Customizations are off. Turn on Enable customizations in Settings to open this extension.');
    if (activation?.kind === 'failed') return row('Failed', activation.message);
    if (descriptor?.state === 'failed') return row('Failed', SERVER_FAILURE);
    if (!activation || activation.kind === 'loading') return row('Loading');
    if (!workspace) return row('No view');
    // Without host metadata (loading or unreachable) nothing is known about the host's installations yet.
    if (metadata === null) return row('Loading', 'Waiting for the host to report its extensions.');
    if (!descriptor || descriptor.installations.length === 0) return row('Not configured');
    if (descriptor.installations.every(item => item.status === 'unavailable')) {
      const reason = namespaceAgents(metadata, namespace).find(agent => agent.availability.kind === 'unavailable');
      return row('Unavailable', reason?.availability.kind === 'unavailable' ? reason.availability.reason : UNAVAILABLE);
    }
    return row('Ready');
  });
}

/** The apply step: offered for a ready build of the connected head that the host is not running. */
export function ApplyPanel({ controller, status, restarting, enabled }: {
  readonly controller: ApplicationController; readonly status: CustomizationStatus | null; readonly restarting: boolean; readonly enabled: boolean;
}) {
  const [notice, setNotice] = useState('');
  const build = status?.build ?? null;
  const applicable = status?.support === 'supported' && build?.state === 'ready' && status.running.buildKey !== build.buildKey;
  if (restarting) return <p className="customization-apply" role="status">AgentUI is restarting with the applied customization. The page reloads when it is back.</p>;
  if (!applicable && !notice) return null;
  return <div className="customization-apply">
    {applicable && build && <>
      <p>A new build of the connected repository is ready. Applying it restarts the host, and this page reloads.</p>
      <button type="button" disabled={!enabled} onClick={() => {
        setNotice('');
        void controller.applyCustomization(build.buildKey).then(outcome => setNotice(outcomeMessage(outcome, controller.getSnapshot().customization)));
      }}>Apply and restart</button>
    </>}
    {notice && <p role="alert">{notice}</p>}
  </div>;
}

export type RepositoryRowState = ExtensionRowState | 'Enabled, not applied yet' | 'Disabled, still running until applied' | 'Not in the connected repository';
export interface RepositoryRow {
  /** The reference key, or null for a running extension the connected repository does not list. */
  readonly key: string | null;
  readonly label: string;
  /** The extension's namespace, when the repository's manifest or the running build names one. */
  readonly namespace: string | null;
  readonly enabled: boolean;
  readonly state: RepositoryRowState;
  readonly detail: string | null;
  /** The running extension's row, whose workspace can open. */
  readonly running: ExtensionRow | null;
}
const tokenPart = (namespace: string) => namespace.toUpperCase().replace(/[^A-Z0-9]/gu, '_');
/** One row per reference in the connected repository, sorted by label, then running extensions it does not list. */
export function repositoryRows(status: CustomizationStatus, running: readonly ExtensionRow[]): readonly RepositoryRow[] {
  const listed = status.extensions.map((reference): RepositoryRow => {
    const row = reference.namespace === null ? null : running.find(item => item.namespace === reference.namespace) ?? null;
    const label = row?.label ?? reference.namespace ?? reference.key;
    const namespace = reference.namespace;
    if (!reference.enabled) return { key: reference.key, label, namespace, enabled: false, running: row, detail: null, state: row ? 'Disabled, still running until applied' : 'Disabled' };
    if (!row) return { key: reference.key, label, namespace, enabled: true, running: null, detail: null, state: 'Enabled, not applied yet' };
    // A grant left out at startup for a missing token: name the variable to set.
    // Grant variables are named AGENTUI_EXTENSION_<NAMESPACE>_…; when none matches, every omitted name is listed.
    const own = status.running.omittedGrants.filter(name => reference.namespace !== null && name.startsWith(`AGENTUI_EXTENSION_${tokenPart(reference.namespace)}_`));
    const omitted = own.length ? own : status.running.omittedGrants;
    const detail = row.state === 'Not configured' && omitted.length
      ? `Set ${omitted.join(', ')} in the shell that runs the AgentUI launcher, then restart AgentUI.` : row.detail;
    return { key: reference.key, label, namespace, enabled: true, running: row, detail, state: row.state };
  }).sort((a, b) => a.label.localeCompare(b.label));
  const namespaces = new Set(status.extensions.map(reference => reference.namespace));
  const extra = running.filter(row => !namespaces.has(row.namespace)).map((row): RepositoryRow =>
    ({ key: null, label: row.label, namespace: row.namespace, enabled: true, running: row, detail: null, state: 'Not in the connected repository' }));
  return [...listed, ...extra];
}

/** The build of the connected head: its phase, its failure with Rebuild, or the apply step. */
export function BuildPanel({ controller, status, restarting, enabled }: {
  readonly controller: ApplicationController; readonly status: CustomizationStatus; readonly restarting: boolean; readonly enabled: boolean;
}) {
  const [notice, setNotice] = useState('');
  const build = status.build;
  const [, setTick] = useState(0);
  const active = build !== null && !['ready', 'failed', 'cancelled'].includes(build.state);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick(value => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  const rebuild = () => { setNotice(''); void controller.rebuildCustomization().then(outcome => setNotice(outcomeMessage(outcome, controller.getSnapshot().customization))); };
  return <div className="customization-build">
    {status.running.stale && <p>AgentUI was updated, so the applied customization was built for another version. It is being rebuilt, or is ready to apply.</p>}
    {build && active && <p>{BUILD_PHASES[build.state]} · {Math.max(0, Math.round((Date.now() - build.startedAt) / 1_000))} s</p>}
    {build?.state === 'cancelled' && <p>The build was cancelled.</p>}
    {build?.state === 'failed' && <div role="alert">
      <p>The build failed. {build.failure ? buildFailureMessage(build.failure) : ''}</p>
      <p>The log is in <code>customization/builds/{build.buildKey}/log.txt</code> under the AgentUI setup root on the machine that runs the launcher.</p>
    </div>}
    {(build?.state === 'failed' || build?.state === 'cancelled') && <button type="button" disabled={!enabled || status.pending !== null} onClick={rebuild}>Rebuild</button>}
    <ApplyPanel controller={controller} status={status} restarting={restarting} enabled={enabled && status.pending === null} />
    {notice && <p role="alert">{notice}</p>}
  </div>;
}

/** The Extensions page body: the connected repository's extensions with toggles, or the running ones when it cannot change. */
export function ExtensionsPage({ controller, status, rows, restarting, enabled, onOpen, onSettings }: {
  readonly controller: ApplicationController; readonly status: CustomizationStatus | null; readonly rows: readonly ExtensionRow[];
  readonly restarting: boolean; readonly enabled: boolean; readonly onOpen: (namespace: string) => void; readonly onSettings: () => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  if (status === null || status.support === 'worker-offline') {
    return <ExtensionsList rows={rows} enabled={enabled} onOpen={onOpen} onSettings={onSettings}>
      {status !== null && <p>These extensions cannot be changed until the launcher is connected.</p>}
    </ExtensionsList>;
  }
  if (status.connection === null) {
    return <section className="extensions-panel" aria-label="Extensions">
      <h1>Extensions</h1>
      <div className="empty-state"><p>No customization repository is connected. Extensions come from the repository you connect in Settings.</p>
        <button type="button" onClick={onSettings}>Open Settings</button></div>
      <ApplyPanel controller={controller} status={status} restarting={restarting} enabled={enabled} />
    </section>;
  }
  const listed = repositoryRows(status, rows);
  const pending = status.pending !== null || saving !== null;
  const toggle = async (row: RepositoryRow) => {
    if (row.key === null) return;
    setSaving(row.key);
    setNotice('');
    try {
      const outcome = await controller.toggleExtension(row.key, !row.enabled);
      if (outcome.kind !== 'ok') setNotice(outcomeMessage(outcome, controller.getSnapshot().customization));
    } finally { setSaving(null); }
  };
  return <section className="extensions-panel" aria-label="Extensions">
    <h1>Extensions</h1>
    <BuildPanel controller={controller} status={status} restarting={restarting} enabled={enabled && !restarting} />
    {!restarting && <p role="status" className="customization-status">{saving !== null ? 'Saving\u2026' : ''}</p>}
    {notice && <p role="alert">{notice}</p>}
    {listed.length === 0 ? <p className="empty-state">The connected repository lists no extensions.</p> : <ul className="extension-list">
      {listed.map(row => {
        const open = row.running ? openableRow(row.running) : null;
        return <li key={row.key ?? `running:${row.namespace ?? row.label}`} className="extension-row" data-extension={row.namespace ?? row.key ?? undefined} data-extension-key={row.key ?? undefined}>
          <div className="extension-row-text">
            <strong>{row.label}</strong>
            {row.key && <code className="extension-key">{row.key}</code>}
            <span className="extension-state" data-state={row.state}>{saving !== null && saving === row.key ? 'Saving\u2026' : row.state}</span>
            {row.detail && <p>{row.detail}</p>}
          </div>
          {row.key !== null && <button type="button" role="switch" aria-checked={row.enabled} aria-label={`${row.label} enabled`} disabled={!enabled || pending || restarting}
            onClick={() => void toggle(row)}>{row.enabled ? 'On' : 'Off'}</button>}
          {open && <button type="button" disabled={!enabled} aria-label={`Open ${row.label}`} onClick={() => onOpen(open.namespace)}>Open</button>}
        </li>;
      })}
    </ul>}
  </section>;
}

export function ExtensionsList({ rows, onOpen, enabled, children, onSettings }: {
  readonly rows: readonly ExtensionRow[]; readonly onOpen: (namespace: string) => void; readonly enabled: boolean; readonly children?: ReactNode;
  readonly onSettings?: () => void;
}) {
  return <section className="extensions-panel" aria-label="Extensions">
    <h1>Extensions</h1>
    {children}
    {rows.length === 0 ? <div className="empty-state"><p>No extensions are running. Extensions come from a customization repository you connect in Settings.</p>
      {onSettings && <button type="button" onClick={onSettings}>Open Settings</button>}</div>
      : <ul className="extension-list">
        {rows.map(row => {
          const selectable = openableRow(row) !== null;
          return <li key={row.namespace} className="extension-row" data-extension={row.namespace}>
            <div className="extension-row-text">
              <strong>{row.label}</strong>
              <span className="extension-state" data-state={row.state}>{row.state}</span>
              {row.detail && <p>{row.detail}</p>}
            </div>
            {selectable && <button type="button" disabled={!enabled} aria-label={`Open ${row.label}`} onClick={() => onOpen(row.namespace)}>Open</button>}
          </li>;
        })}
      </ul>}
  </section>;
}

export function ExtensionWorkspace({ row, metadata, workspaces, active, controller, conversation, status, onBack }: {
  readonly row: OpenableRow;
  readonly metadata: ServiceMetadata | null;
  readonly workspaces: Readonly<Record<string, WorkspaceConversations>>;
  readonly active: OpenConversation | null;
  readonly controller: ApplicationController;
  readonly conversation: ReactNode;
  readonly status: ReactNode;
  readonly onBack: () => void;
}) {
  const namespace = row.namespace;
  const hostKey = metadata ? `${metadata.hostId}/${metadata.principalId}` : null;
  useEffect(() => { if (hostKey !== null) void controller.loadWorkspace(namespace); }, [controller, namespace, hostKey]);
  const agents: readonly WorkspaceAgent[] = namespaceAgents(metadata, namespace).map(agent => ({ id: agent.id, label: agent.label,
    installationId: agent.installationId, providerAgentId: agent.providerAgentId, availability: agent.availability }));
  const listed = workspaces[namespace];
  const loaded: readonly WorkspaceConversation[] = (listed?.entries ?? []).flatMap(entry => entry.provider?.namespace === namespace
    ? [{ scope: entry.scope, preview: entry.preview, provider: { installationId: entry.provider.installationId, providerAgentId: entry.provider.providerAgentId } }] : []);
  const activeAgent = active && 'kind' in active.agent && active.agent.namespace === namespace ? active.agent : null;
  const selected = active && activeAgent ? active.scope : null;
  // The catalog is paged in conversation-ID order, so the active conversation may sit on a page not loaded yet. The
  // workspace finds it in `entries`, so add it from the active agent rather than leave it mounted nowhere.
  const entries: readonly WorkspaceConversation[] = selected && activeAgent?.providerAgentId && !loaded.some(entry => sameScope(entry.scope, selected))
    ? [...loaded, { scope: selected, preview: null, provider: { installationId: activeAgent.installationId, providerAgentId: activeAgent.providerAgentId } }]
    : loaded;
  const props: WorkspaceViewProps = {
    namespace,
    installations: metadata?.extensions.find(item => item.namespace === namespace)?.installations ?? [],
    agents,
    conversations: { entries, hasMore: listed?.hasMore ?? false, loading: listed?.loading ?? hostKey !== null, more: () => void controller.moreWorkspace(namespace) },
    selected,
    conversation: selected ? conversation : null,
    async open(scope: ConversationScope) {
      if (!entries.some(entry => sameScope(entry.scope, scope)) && !(selected && sameScope(selected, scope))) throw new Error('This conversation is not in this extension.');
      await controller.open(scope);
    },
    async create(agentId: string) {
      if (!agents.some(agent => agent.id === agentId)) throw new Error('This agent is not part of this extension.');
      await controller.create(agentId);
    },
    async call(installationId: string, operation: string, input: Json): Promise<ExtensionCallValue> {
      const request = { namespace, installationId, operation, input };
      try {
        const call = classifyExtensionCall(request);
        if (call.kind === 'failed') return call;
      } catch (error) {
        // A malformed operation name or input is the extension's own bug, not an outage: say so where its author looks.
        console.error(`[${namespace}] invalid extension call to "${String(operation)}": ${error instanceof Error ? error.message : 'invalid request'}`);
        return { kind: 'failed', cause: 'unavailable' };
      }
      try { return await controller.extensionCall(request); }
      catch { return { kind: 'failed', cause: 'unavailable' }; }
    },
    async refresh() {
      await controller.refreshMetadata();
      await controller.loadWorkspace(namespace);
    },
  };
  const View = row.workspace.component;
  return <div className="extension-workspace-frame">
    <div className="extension-status-strip">
      <button type="button" className="extension-back" onClick={onBack}>All extensions</button>
      {status}
    </div>
    <div className="extension-workspace" data-extension-workspace={namespace}>
      <Suspense fallback={<p role="status" className="extension-loading">Loading {row.label}…</p>}>
        <CustomizationBoundary key={row.owner.lifetime} fail={row.owner.fail} fallback={<p role="alert">{row.label} could not load.</p>}>
          <View {...props} />
        </CustomizationBoundary>
      </Suspense>
    </div>
  </div>;
}
