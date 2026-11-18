import { Suspense, useEffect, type ReactNode } from 'react';
import type { ConversationScope, Json } from '@agentui/contracts';
import { sameScope } from '@agentui/contracts';
import type { AgentDescriptor, ExtensionCallValue, ServiceMetadata } from '@agentui/contracts/service';
import { classifyExtensionCall } from '@agentui/contracts/service';
import type { WorkspaceAgent, WorkspaceContribution, WorkspaceConversation, WorkspaceViewProps } from '@agentui/sdk/react';
import { CustomizationBoundary, workspaceTranscript, type ContentLayoutSelection, type DesktopCustomization, type NamespaceActivation, type TranscriptSelection } from './DesktopCustomizations.js';
import type { ApplicationController, OpenConversation, WorkspaceConversations } from './application-controller.js';

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

export function ExtensionsList({ rows, onOpen, enabled }: {
  readonly rows: readonly ExtensionRow[]; readonly onOpen: (namespace: string) => void; readonly enabled: boolean;
}) {
  return <section className="extensions-panel" aria-label="Extensions">
    <h1>Extensions</h1>
    {rows.length === 0 ? <p className="empty-state">No extensions are installed in this build or configured on this host.</p>
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
