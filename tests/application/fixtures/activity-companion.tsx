import { lazy, useState } from 'react';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ConversationContentLayoutProps, UiExtensionContributions, UiExtensionEntry } from '@agentui/sdk/react';

const mode = new URLSearchParams(location.search).get('activity');
const ready = Promise.withResolvers<{ default: () => React.ReactNode }>();
const activation = Promise.withResolvers<UiExtensionContributions>();
let pending: Promise<void> | null = null;
let broken = false;
let release = () => {};
let refresh = () => {};
function Layout({ transcript, modules }: ConversationContentLayoutProps) {
  const [, update] = useState(0);
  refresh = () => update(value => value + 1);
  if (broken) throw new Error('Independent layout failed');
  if (pending) throw pending;
  return <main aria-label="Independent layout">{transcript}{modules}</main>;
}
export default {
  kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION,
  activate() {
    Object.assign(window, { activityCompanion: {
      resolve() { ready.resolve({ default: () => <p>Independent whole transcript</p> }); },
      reject() { ready.reject(new Error('Independent transcript failed')); },
      activate() { activation.resolve({ modules: [], dispose() {} }); },
      suspend() { pending = new Promise(resolve => { release = resolve; }); refresh(); },
      resume() { pending = null; release(); },
      fail() { broken = true; refresh(); },
    } });
    if (mode === 'activation') return activation.promise;
    return { modules: [], dispose() {},
      ...(mode === 'conflict' ? { overrides: { activity: () => <p>Conflicting activity</p> } } : {}),
      ...(mode === 'independent-transcript' ? { overrides: { transcript: lazy(() => ready.promise) } } : {}),
      ...(mode === 'independent-layout' ? { contentLayout: Layout } : {}),
    };
  },
} satisfies UiExtensionEntry<'desktop'>;
