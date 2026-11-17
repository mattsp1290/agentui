import { useState } from 'react';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ConversationContentLayoutProps, UiExtensionEntry } from '@agentui/sdk/react';

let pending: Promise<void> | null = null;
function ImageLayout({ transcript, modules }: ConversationContentLayoutProps) {
  const [broken, fail] = useState(false);
  const [, refresh] = useState(0);
  if (broken) throw new Error('Committed image layout failed');
  if (pending) throw pending;
  function suspend() {
    pending = new Promise(resolve => {
      Object.assign(window, { resumeImageLayout() { pending = null; resolve(); } });
    });
    refresh(value => value + 1);
  }
  return <section aria-label="Committed image layout">
    <main aria-label="Layout transcript">{transcript}</main>
    <aside>
      <button onClick={suspend}>Suspend image layout</button>
      <button onClick={() => fail(true)}>Fail image layout</button>
      {modules}
    </aside>
  </section>;
}

export default {
  kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION,
  activate() { return { contentLayout: ImageLayout, modules: [], dispose() {} }; },
} satisfies UiExtensionEntry<'desktop'>;
