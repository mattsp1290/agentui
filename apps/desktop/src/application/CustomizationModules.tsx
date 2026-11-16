import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { useConversation } from '@agentui/client/react';
import { checkExtensionEntrypoint, validateExtensionLifetime, type ExtensionManifest } from '@agentui/sdk';
import { validateUiExtensionContributions, type ConversationModule, type ConversationModuleProps, type ModuleAction, type UiExtensionContributions, type UiExtensionEntry } from '@agentui/sdk/react';
import type { SubmitResult } from '@agentui/contracts';
import { Button } from '@agentui/ui-primitives/desktop';
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

function actionOutcome(result: SubmitResult): string {
  if (result.kind === 'rejected') return `Submission rejected. ${result.reason}`;
  const state = result.receipt.state;
  switch (state.kind) {
    case 'pending': return 'Submission pending. Follow its progress in the conversation.';
    case 'accepted': return 'Submitted. Follow the response in the conversation.';
    case 'completed': return 'Command completed. Follow the response in the conversation.';
    case 'rejected': return `Submission rejected. ${state.reason}`;
    case 'not-dispatched': return `Not dispatched. ${state.reason}`;
    case 'uncertain': return `Submission uncertain. ${state.reason} Use the conversation recovery controls before trying again.`;
    default: { const exhaustive: never = state; return exhaustive; }
  }
}

function ConversationModuleAction({ action, context }: { readonly action: ModuleAction; readonly context: ConversationModuleProps }) {
  const owner = useRef({ mounted: true, pending: false });
  const [state, setState] = useState<{ readonly kind: 'idle' | 'pending' } | { readonly kind: 'settled'; readonly message: string }>({ kind: 'idle' });
  useEffect(() => {
    const current = owner.current;
    current.mounted = true;
    return () => { current.mounted = false; };
  }, []);
  async function run() {
    const current = owner.current;
    if (current.pending) return;
    current.pending = true;
    setState({ kind: 'pending' });
    try {
      const result = await action.run(context);
      if (current.mounted) setState({ kind: 'settled', message: actionOutcome(result) });
    } catch (error) {
      if (current.mounted) setState({ kind: 'settled', message: `Action failed. ${message(error)} Check conversation recovery before trying again.` });
    } finally {
      current.pending = false;
    }
  }
  return <div>
    <Button disabled={state.kind === 'pending'} aria-busy={state.kind === 'pending'} onClick={() => void run()}>{action.label}</Button>
    <p role="status" aria-label={`${action.label} status`}>{state.kind === 'pending' ? 'Submitting…' : state.kind === 'settled' ? state.message : ''}</p>
  </div>;
}

function ConversationModuleView({ module, context }: { readonly module: ConversationModule; readonly context: ConversationModuleProps }) {
  const View = module.component;
  return <section aria-label={module.label}>
    <View {...context} />
    {module.actions?.map(action => <ConversationModuleAction key={action.id} action={action} context={context} />)}
    {module.children?.map(child => <ConversationModuleView key={child.id} module={child} context={context} />)}
  </section>;
}

function ConversationModules({ value, active, actions, enabled, agent }: {
  readonly value: UiExtensionContributions; readonly active: OpenConversation; readonly actions: ConversationActions;
  readonly enabled: boolean; readonly agent: string;
}) {
  const view = useConversation(active.store);
  const context: ConversationModuleProps = { conversation: active.scope, activity: view.document, commands: actions.commands };
  const available = enabled && active.agent.availability.kind === 'ready' && active.agent.commands.includes('send') && view.connection.kind === 'connected' && !conversationResponding(agent, view.document.domain);
  return <fieldset disabled={!available} className="customization-modules">
    <legend>Custom tools</legend>
    {!available && <p>Available when this conversation is connected and ready.</p>}
    {value.modules.map(module => <ConversationModuleView key={module.id} module={module} context={context} />)}
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
        setActivation({ kind: 'ready', value });
      } catch (error) { failed(error); }
    })();
    return () => { removed = true; void cleanup(); };
  }, [customization]);
  return <aside className="customization-panel" aria-label={`Customization ${customization.manifest.namespace}`}
    data-customization-namespace={customization.manifest.namespace} data-customization-state={activation.kind}>
    {activation.kind === 'loading' && <p role="status">Loading custom tools…</p>}
    {activation.kind === 'failed' && <p role="alert">Custom tools could not load. {activation.message} Use Restore default view to continue without them.</p>}
    {activation.kind === 'ready' && active && actions && <ModuleBoundary fail={error => fail.current(error)}>
      <ConversationModules key={`${active.viewId}/${active.scope.hostId}/${active.scope.conversationId}`}
        value={activation.value} active={active} actions={actions} enabled={enabled} agent={agent} />
    </ModuleBoundary>}
  </aside>;
}
