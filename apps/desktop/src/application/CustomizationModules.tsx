import { Suspense, useEffect, useRef, useState } from 'react';
import { useConversation } from '@agentui/client/react';
import type { ConversationModule, ConversationModuleProps, ModuleAction } from '@agentui/sdk/react';
import type { SubmitResult } from '@agentui/contracts';
import { Button } from '@agentui/ui-primitives/desktop';
import { refusalMessage } from './application-controller.js';
import type { ConversationActions, OpenConversation } from './application-controller.js';
import { CustomizationBoundary, customizationMessage as message, type NamespaceActivation } from './DesktopCustomizations.js';

function actionOutcome(result: SubmitResult): string {
  if (result.kind === 'rejected') return `Submission rejected. ${refusalMessage(result.reason)}`;
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
  const lifetime = useRef({ alive: false });
  type Request = { readonly owner: ConversationModuleProps['outputs']; readonly lifetime: { alive: boolean }; pending: boolean };
  const latest = useRef<Request | null>(null);
  const [feedback, setFeedback] = useState<{ readonly request: Request; readonly pending: boolean; readonly message: string } | null>(null);
  useEffect(() => {
    const current = { alive: true };
    lifetime.current = current;
    return () => { current.alive = false; };
  }, []);
  const state = feedback?.request.owner === context.outputs && feedback.request.lifetime === lifetime.current ? feedback : null;
  const pending = state?.pending ?? false;
  const availability = action.availability(context);
  async function run() {
    const previous = latest.current;
    if (previous?.owner === context.outputs && previous.lifetime === lifetime.current && previous.pending) return;
    const request = { owner: context.outputs, lifetime: lifetime.current, pending: true };
    latest.current = request;
    function settle(message: string) {
      if (request.lifetime.alive && latest.current === request) setFeedback({ request, pending: false, message });
    }
    try {
      if (action.availability(context).kind !== 'available') return;
      setFeedback({ request, pending: true, message: '' });
      settle(actionOutcome(await action.run(context)));
    }
    catch (error) { settle(`Action failed. ${message(error)} Check conversation recovery before trying again.`); }
    finally { request.pending = false; }
  }
  return <div>
    <Button disabled={pending || availability.kind === 'disabled'} aria-busy={pending} onClick={() => void run()}>{action.label}</Button>
    {availability.kind === 'disabled' && <p>{availability.reason}</p>}
    <p role="status" aria-label={`${action.label} status`}>{pending ? 'Submitting…' : state?.message ?? ''}</p>
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

function ConversationModules({ modules, active, actions }: {
  readonly modules: readonly ConversationModule[]; readonly active: OpenConversation; readonly actions: ConversationActions;
}) {
  const view = useConversation(active.store);
  const context: ConversationModuleProps = { conversation: active.scope, activity: view.document, outputs: actions.outputs, commands: actions.commands, permissions: actions.permissions };
  return <section className="customization-modules" aria-label="Custom tools">
    {modules.map(module => <ConversationModuleView key={module.id} module={module} context={context} />)}
  </section>;
}

export function CustomizationModules({ owner, active, actions }: {
  readonly owner: NamespaceActivation; readonly active: OpenConversation | null;
  readonly actions: ConversationActions | null;
}) {
  return <aside className="customization-panel" aria-label={`Customization ${owner.namespace}`}
    data-customization-namespace={owner.namespace} data-customization-state={owner.kind}>
    {owner.kind === 'loading' && <p role="status">Loading custom tools…</p>}
    {owner.kind === 'failed' && <p role="alert">Custom tools could not load. {owner.message} Use Restore default view to continue without them.</p>}
    {owner.kind === 'ready' && active && actions && <Suspense fallback={<p role="status">Loading custom tools…</p>}>
      <CustomizationBoundary key={`${owner.lifetime}/${active.viewId}/${active.scope.hostId}/${active.scope.conversationId}`} fail={owner.fail} fallback={null}>
        <ConversationModules modules={owner.presentation.modules} active={active} actions={actions} />
      </CustomizationBoundary>
    </Suspense>}
  </aside>;
}
