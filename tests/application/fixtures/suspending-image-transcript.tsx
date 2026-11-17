import { lazy, useSyncExternalStore } from 'react';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ConversationModuleProps, UiExtensionEntry } from '@agentui/sdk/react';

export default {
  kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION,
  activate() {
    const initial = Promise.withResolvers<void>();
    let state: { kind: 'ready' } | { kind: 'pending'; promise: Promise<void>; resolve: () => void } | { kind: 'failed' } = { kind: 'ready' };
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const snapshot = () => state;
    const changed = () => { for (const listener of listeners) listener(); };
    function Transcript({ activity }: ConversationModuleProps) {
      const current = useSyncExternalStore(subscribe, snapshot);
      if (current.kind === 'pending') throw current.promise;
      if (current.kind === 'failed') throw new Error('Committed image transcript failed');
      return <section aria-label="Committed transcript">
        {activity.domain.messages.map(message => <p key={message.messageId}>{message.text}</p>)}
      </section>;
    }
    Object.assign(window, { imageTranscript: {
      resolve: initial.resolve,
      suspend() { const gate = Promise.withResolvers<void>(); state = { kind: 'pending', promise: gate.promise, resolve: gate.resolve }; changed(); },
      resume() { if (state.kind === 'pending') { const pending = state; state = { kind: 'ready' }; pending.resolve(); changed(); } },
      fail() { state = { kind: 'failed' }; changed(); },
    } });
    return { modules: [], overrides: { transcript: lazy(() => initial.promise.then(() => ({ default: Transcript }))) }, dispose() {} };
  },
} satisfies UiExtensionEntry<'desktop'>;
