import { Component, Suspense, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { checkExtensionEntrypoint, type ExtensionManifest } from '@agentui/sdk';
import type { ConversationModuleProps, UiExtensionPresentation, UiExtensionEntry } from '@agentui/sdk/react';
import { createUiExtensionGeneration } from '@agentui/sdk/react-tools';
import type { FrontendToolGeneration } from '@agentui/sdk/tools';

export interface DesktopCustomization {
  readonly manifest: ExtensionManifest;
  load(): Promise<{ readonly default: unknown }>;
}
export type NamespaceActivation = { readonly namespace: string } & (
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly lifetime: number; readonly generation: FrontendToolGeneration; readonly presentation: UiExtensionPresentation; readonly fail: (error: unknown) => void }
);
type ReadyActivation = Extract<NamespaceActivation, { readonly kind: 'ready' }>;
type TranscriptOwner = ReadyActivation & { readonly presentation: UiExtensionPresentation & { readonly transcript: ComponentType<ConversationModuleProps> } };
export type TranscriptSelection =
  | { readonly kind: 'default' }
  | { readonly kind: 'conflict'; readonly namespaces: readonly string[] }
  | { readonly kind: 'override'; readonly owner: TranscriptOwner };
const DEFAULT_TRANSCRIPT: TranscriptSelection = { kind: 'default' };
export const customizationMessage = (error: unknown): string => error instanceof Error ? error.message : 'Customization failed.';

export class CustomizationBoundary extends Component<{
  readonly children: ReactNode; readonly fallback: ReactNode; readonly fail: (error: unknown) => void;
}, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: unknown) { this.props.fail(error); }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function hasTranscript(owner: NamespaceActivation): owner is TranscriptOwner {
  return owner.kind === 'ready' && owner.presentation.transcript !== undefined;
}

function selectTranscript(owners: readonly NamespaceActivation[]): TranscriptSelection {
  if (owners.some(owner => owner.kind === 'loading')) return DEFAULT_TRANSCRIPT;
  const claims = owners.filter(hasTranscript);
  if (claims.length > 1) return { kind: 'conflict', namespaces: claims.map(owner => owner.namespace).sort() };
  const owner = claims[0];
  return owner ? { kind: 'override', owner } : DEFAULT_TRANSCRIPT;
}

function activateNamespace(customization: DesktopCustomization, lifetime: number, publish: (owner: NamespaceActivation) => void): () => void {
  const namespace = customization.manifest.namespace;
  let removed = false;
  let generation: FrontendToolGeneration | undefined;
  const cleanup = () => {
    const retiring = generation;
    generation = undefined;
    if (retiring) void retiring.retire().catch(error => {
      if (!removed) publish({ kind: 'failed', namespace, message: `Customization cleanup failed. ${customizationMessage(error)}` });
    });
  };
  const fail = (error: unknown) => {
    if (!removed) publish({ kind: 'failed', namespace, message: customizationMessage(error) });
    cleanup();
  };
  void (async () => {
    try {
      const imported = await customization.load();
      if (removed) return;
      const compatibility = checkExtensionEntrypoint(customization.manifest, 'desktop', imported.default);
      if (compatibility.kind !== 'compatible') throw new Error(compatibility.reason);
      const entry = imported.default as UiExtensionEntry<'desktop'>;
      const active = await createUiExtensionGeneration({ namespace, generation: String(lifetime), platform: 'desktop',
        activate: context => entry.activate(context), onFailure: fail });
      generation = active.generation;
      if (removed) { cleanup(); return; }
      publish({ kind: 'ready', namespace, lifetime, generation, presentation: active.presentation, fail });
    } catch (error) { fail(error); }
  })();
  return () => { removed = true; cleanup(); };
}

export function useDesktopCustomizations({ customizations, enabled }: {
  readonly customizations: readonly DesktopCustomization[]; readonly enabled: boolean;
}): { readonly namespaces: readonly NamespaceActivation[]; readonly transcript: TranscriptSelection; readonly generations: readonly FrontendToolGeneration[] } {
  const [request, setRequest] = useState({ customizations, enabled });
  const [snapshot, setSnapshot] = useState<{ readonly request: typeof request; readonly namespaces: readonly NamespaceActivation[] }>(() => ({ request, namespaces: [] }));
  const nextLifetime = useRef(0);
  const current = request.customizations === customizations && request.enabled === enabled;
  if (!current) setRequest({ customizations, enabled });
  useEffect(() => {
    if (!request.enabled) return;
    let removed = false;
    let namespaces: readonly NamespaceActivation[] = request.customizations.map(item => ({ kind: 'loading', namespace: item.manifest.namespace }));
    const publish = () => { if (!removed) setSnapshot({ request, namespaces }); };
    publish();
    const cleanups = request.customizations.map((customization, index) => activateNamespace(customization, ++nextLifetime.current, owner => {
      namespaces = namespaces.map((previous, position) => position === index ? owner : previous);
      publish();
    }));
    return () => { removed = true; cleanups.forEach(cleanup => cleanup()); };
  }, [request]);
  const namespaces = current && enabled && snapshot.request === request ? snapshot.namespaces : [];
  const ready = namespaces.filter((owner): owner is ReadyActivation => owner.kind === 'ready');
  return { namespaces, transcript: selectTranscript(namespaces), generations: ready.map(owner => owner.generation) };
}

export function CustomizationTranscript({ selection, context, fallback, conversationKey }: {
  readonly selection: TranscriptSelection; readonly context: ConversationModuleProps; readonly fallback: ReactNode; readonly conversationKey: string;
}) {
  if (selection.kind === 'default') return fallback;
  if (selection.kind === 'conflict') return <><p role="alert">Transcript override conflict. {selection.namespaces.join(', ')} claim the transcript. The default view remains active.</p>{fallback}</>;
  const View = selection.owner.presentation.transcript;
  return <Suspense fallback={fallback}>
    <CustomizationBoundary key={`${selection.owner.lifetime}/${conversationKey}`} fail={selection.owner.fail} fallback={fallback}>
      <View {...context} />
    </CustomizationBoundary>
  </Suspense>;
}
