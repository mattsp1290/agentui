import { Component, Suspense, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { checkExtensionEntrypoint, validateExtensionLifetime, type ExtensionManifest } from '@agentui/sdk';
import { validateUiExtensionContributions, type ConversationModuleProps, type UiExtensionContributions, type UiExtensionEntry } from '@agentui/sdk/react';

export interface DesktopCustomization {
  readonly manifest: ExtensionManifest;
  load(): Promise<{ readonly default: unknown }>;
}
export type NamespaceActivation = { readonly namespace: string } & (
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly lifetime: number; readonly value: UiExtensionContributions;
      readonly transcript: ComponentType<ConversationModuleProps> | undefined; readonly fail: (error: unknown) => void }
);
export type TranscriptSelection =
  | { readonly kind: 'default' }
  | { readonly kind: 'conflict'; readonly namespaces: readonly string[] }
  | { readonly kind: 'override'; readonly namespace: string; readonly lifetime: number;
      readonly component: ComponentType<ConversationModuleProps>; readonly fail: (error: unknown) => void };
const DEFAULT_TRANSCRIPT: TranscriptSelection = { kind: 'default' };
let nextLifetime = 0;
export const customizationMessage = (error: unknown): string => error instanceof Error ? error.message : 'Customization failed.';

export class CustomizationBoundary extends Component<{
  readonly children: ReactNode; readonly fallback: ReactNode; readonly fail: (error: unknown) => void;
}, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: unknown) { this.props.fail(error); }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function selectTranscript(owners: readonly NamespaceActivation[]): TranscriptSelection {
  if (owners.some(owner => owner.kind === 'loading')) return DEFAULT_TRANSCRIPT;
  const claims = owners.flatMap(owner => owner.kind === 'ready' && owner.transcript
    ? [{ kind: 'override', namespace: owner.namespace, lifetime: owner.lifetime, component: owner.transcript, fail: owner.fail } satisfies TranscriptSelection] : []);
  if (claims.length > 1) return { kind: 'conflict', namespaces: claims.map(owner => owner.namespace).sort() };
  return claims[0] ?? DEFAULT_TRANSCRIPT;
}

export function useDesktopCustomizations({ customizations, enabled }: {
  readonly customizations: readonly DesktopCustomization[]; readonly enabled: boolean;
}): { readonly namespaces: readonly NamespaceActivation[]; readonly transcript: TranscriptSelection } {
  const lifetime = useMemo(() => ({ customizations, enabled }), [customizations, enabled]);
  const [snapshot, setSnapshot] = useState<{ readonly lifetime: typeof lifetime; readonly namespaces: readonly NamespaceActivation[] }>(() => ({ lifetime, namespaces: [] }));
  useEffect(() => {
    if (!lifetime.enabled) return;
    let removed = false;
    const cleanups: (() => void)[] = [];
    let namespaces: readonly NamespaceActivation[] = lifetime.customizations.map(item => ({ kind: 'loading', namespace: item.manifest.namespace }));
    const publish = () => { if (!removed) setSnapshot({ lifetime, namespaces }); };
    publish();
    lifetime.customizations.forEach((customization, index) => {
      const namespace = customization.manifest.namespace, identity = ++nextLifetime;
      let dispose: (() => void | Promise<void>) | undefined;
      let failed = false;
      const update = (owner: NamespaceActivation) => { namespaces = namespaces.map((previous, position) => position === index ? owner : previous); publish(); };
      const cleanup = () => {
        const release = dispose;
        dispose = undefined;
        if (release) void Promise.resolve().then(release).catch(error => {
          if (!removed) update({ kind: 'failed', namespace, message: `Customization cleanup failed. ${customizationMessage(error)}` });
        });
      };
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        if (!removed) update({ kind: 'failed', namespace, message: customizationMessage(error) });
        cleanup();
      };
      cleanups.push(cleanup);
      void (async () => {
        try {
          const imported = await customization.load();
          if (removed) return;
          const compatibility = checkExtensionEntrypoint(customization.manifest, 'desktop', imported.default);
          if (compatibility.kind !== 'compatible') throw new Error(compatibility.reason);
          const entry = imported.default as UiExtensionEntry<'desktop'>;
          const value: unknown = await entry.activate({ namespace, frontendTools: { add() { throw new Error('Frontend tools are not supported by this local build.'); } } });
          validateExtensionLifetime(value);
          const release = value.dispose;
          dispose = () => release.call(value);
          if (removed) { cleanup(); return; }
          validateUiExtensionContributions(value);
          const transcript = value.overrides?.transcript;
          update({ kind: 'ready', namespace, lifetime: identity, value, transcript, fail });
        } catch (error) { fail(error); }
      })();
    });
    return () => { removed = true; cleanups.forEach(cleanup => cleanup()); };
  }, [lifetime]);
  const namespaces = enabled && snapshot.lifetime === lifetime ? snapshot.namespaces : [];
  return { namespaces, transcript: selectTranscript(namespaces) };
}

export function CustomizationTranscript({ selection, context, fallback, conversationKey }: {
  readonly selection: TranscriptSelection; readonly context: ConversationModuleProps; readonly fallback: ReactNode; readonly conversationKey: string;
}) {
  if (selection.kind === 'default') return fallback;
  if (selection.kind === 'conflict') return <><p role="alert">Transcript override conflict. {selection.namespaces.join(', ')} claim the transcript. The default view remains active.</p>{fallback}</>;
  const View = selection.component;
  return <Suspense fallback={fallback}>
    <CustomizationBoundary key={`${selection.lifetime}/${conversationKey}`} fail={selection.fail} fallback={fallback}>
      <View {...context} />
    </CustomizationBoundary>
  </Suspense>;
}
