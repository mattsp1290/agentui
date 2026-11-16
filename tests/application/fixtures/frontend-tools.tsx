import { useState } from 'react';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { UiExtensionEntry } from '@agentui/sdk/react';
import { createUiExtensionGeneration } from '@agentui/sdk/react-tools';

function ToolModule() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(value => value + 1)}>Committed tool module {count}</button>;
}

export default {
  kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION,
  activate({ frontendTools }) {
    void createUiExtensionGeneration;
    frontendTools.add({ definition: { name: 'echo', description: 'Committed tool' },
      decodeInput: value => value, async execute() { return 'committed'; } });
    return { modules: [{ id: 'tool', label: 'Committed tool', component: ToolModule }], dispose() {} };
  },
} satisfies UiExtensionEntry<'desktop'>;
