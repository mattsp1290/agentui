import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { useConversation } from '@agentui/client/react';
import { checkExtensionEntrypoint, validateExtensionLifetime, type ExtensionManifest } from '@agentui/sdk';
import { validateUiExtensionContributions, type UiExtensionContributions, type UiExtensionEntry } from '@agentui/sdk/react';
import type { ConversationActions, OpenConversation } from './application-controller.js';
import { conversationResponding } from './responding.js';

export interface DesktopCustomization {
  readonly manifest: ExtensionManifest;
  load(): Promise<{ readonly default: unknown }>;
}
type Activation = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly value: UiExtensionContributions } |
  { readonly kind: 'failed'; readonly message: string };
const message = (error: unknown) => error instanceof Error ? error.message : 'Customization failed.';

class ModuleBoundary extends Component<{ readonly children: ReactNode; readonly fail: (error: unknown) => void }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: unknown) { this.props.fail(error); }
  override render() { return this.state.failed ? null : this.props.children; }
}

function ConversationModules({ value, active, actions, enabled, agent }: {
  readonly value: UiExtensionContributions; readonly active: OpenConversation; readonly actions: ConversationActions;
  readonly enabled: boolean; readonly agent: string;
}) {
  const view = useConversation(active.store);
  const available = enabled && view.connection.kind === 'connected' && !conversationResponding(agent, view.document.domain);
  return <fieldset disabled={!available} className="customization-modules">
    <legend>Custom tools</legend>
    {!available && <p>Available when this conversation is connected and ready.</p>}
    {value.modules.map(module => {
      const View = module.component;
      return <section key={module.id} aria-label={module.label}><View conversation={active.scope} activity={view.document} commands={actions.commands} /></section>;
    })}
  </fieldset>;
}

export function CustomizationModules({ customization, active, actions, enabled, agent }: {
  readonly customization: DesktopCustomization; readonly active: OpenConversation | null;
  readonly actions: ConversationActions | null; readonly enabled: boolean; readonly agent: string;
}) {
  const [activation, setActivation] = useState<Activation>({ kind: 'loading' });
  const fail = useRef<(error: unknown) => void>(() => {});
  useEffect(() => {
    let removed = false;
    let dispose: (() => void | Promise<void>) | undefined;
    const cleanup = async () => {
      const release = dispose;
      dispose = undefined;
      try { await release?.(); }
      catch (error) { if (!removed) setActivation({ kind: 'failed', message: `Customization cleanup failed. ${message(error)}` }); }
    };
    const failed = (error: unknown) => {
      if (!removed) setActivation({ kind: 'failed', message: message(error) });
      void cleanup();
    };
    fail.current = failed;
    void (async () => {
      try {
        const imported = await customization.load();
        if (removed) return;
        const compatibility = checkExtensionEntrypoint(customization.manifest, 'desktop', imported.default);
        if (compatibility.kind !== 'compatible') throw new Error(compatibility.reason);
        const entry = imported.default as UiExtensionEntry<'desktop'>;
        const value: unknown = await entry.activate({ namespace: customization.manifest.namespace,
          frontendTools: { add() { throw new Error('Frontend tools are not supported by this local build.'); } } });
        validateExtensionLifetime(value);
        const release = value.dispose;
        dispose = () => release.call(value);
        if (removed) { await cleanup(); return; }
        validateUiExtensionContributions(value);
        if (value.modules.some(module => module.children !== undefined || module.actions !== undefined)) {
          throw new Error('Nested modules and module actions are not supported by this local build.');
        }
        setActivation({ kind: 'ready', value });
      } catch (error) { failed(error); }
    })();
    return () => { removed = true; void cleanup(); };
  }, [customization]);
  return <aside className="customization-panel" aria-label="Customization">
    {activation.kind === 'loading' && <p role="status">Loading custom tools…</p>}
    {activation.kind === 'failed' && <p role="alert">Custom tools could not load. {activation.message} Use Restore default view to continue without them.</p>}
    {activation.kind === 'ready' && active && actions && <ModuleBoundary fail={error => fail.current(error)}>
      <ConversationModules key={`${active.viewId}/${active.scope.hostId}/${active.scope.conversationId}`}
        value={activation.value} active={active} actions={actions} enabled={enabled} agent={agent} />
    </ModuleBoundary>}
  </aside>;
}
