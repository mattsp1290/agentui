import { lazy, useEffect, useState } from 'react';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ConversationActivityProps, ConversationContentLayoutProps, UiExtensionEntry } from '@agentui/sdk/react';

const mode = new URLSearchParams(location.search).get('activity') ?? '';
const initial = Promise.withResolvers<{ default: typeof Activity }>();
let pending: Promise<void> | null = null;
let broken = false;
let refresh = () => {};
let release = () => {};
let committed = 0;
const controls = {
  resolve() { initial.resolve({ default: Activity }); },
  reject() { initial.reject(new Error('Committed activity lazy rejected')); },
  suspend() { pending = new Promise(resolve => { release = resolve; }); refresh(); },
  resume() { pending = null; release(); },
  fail() { broken = true; refresh(); },
  committed() { return committed; },
};
function Activity(props: ConversationActivityProps) {
  const [, update] = useState(0);
  refresh = () => update(value => value + 1);
  useEffect(() => { committed++; return () => { committed--; }; }, []);
  if (broken) throw new Error('Committed activity failed');
  if (pending) throw pending;
  return <section aria-label="Committed activity" data-updates={props.updates}>
    <p>Committed selective activity</p>
    <p>Updates {props.updates}</p>
    <pre>{JSON.stringify(props.activity.domain)}</pre>
    <button onClick={() => Object.assign(window, { activityCapturedSend: () => props.commands.send('Captured activity command') })}>Capture activity command</button>
    <button onClick={() => void props.commands.send('Current activity command').then(result => Object.assign(window, { activityCommandResult: result }))}>Send activity command</button>
  </section>;
}
function Layout({ transcript, modules }: ConversationContentLayoutProps) {
  const [failed, fail] = useState(false);
  const [suspended, suspend] = useState(false);
  if (failed) throw new Error('Committed activity layout failed');
  if (suspended) throw new Promise<void>(resolve => Object.assign(window, { resumeActivityLayout() { suspend(false); resolve(); } }));
  return <main aria-label="Activity layout">{transcript}{modules}
    <button onClick={() => suspend(true)}>Suspend activity layout</button>
    <button onClick={() => fail(true)}>Fail activity layout</button>
  </main>;
}
export default {
  kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION,
  activate() {
    Object.assign(window, { activityFixture: controls });
    return { modules: [], overrides: { ...(mode === 'none' ? {} : { activity: mode.startsWith('lazy') ? lazy(() => initial.promise) : Activity }),
      ...(mode === 'transcript' ? { transcript: () => <p>Whole committed transcript</p> } : {}) },
      ...(mode === 'layout' ? { contentLayout: Layout } : {}), dispose() {} };
  },
} satisfies UiExtensionEntry<'desktop'>;
