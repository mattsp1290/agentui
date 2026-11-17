import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { UiExtensionEntry } from '@agentui/sdk/react';

const disposed: number[] = [];
const fixture = { activations: 0, disposed, executions: 0 };
Object.assign(window, { captureFixture: fixture });
export default {
  kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION,
  activate({ frontendTools }) {
    const activation = ++fixture.activations;
    frontendTools.add({ definition: { name: 'echo', description: `Original activation ${activation}`, parameters: { type: 'object' } },
      decodeInput: value => value, async execute() { fixture.executions++; return String(activation); } });
    return { modules: [{ id: 'capture', label: 'Capture fixture', component() { return <p>Capture activation {activation}</p>; },
      actions: [{ id: 'send', label: 'Send captured extension message', availability: ({ commands }) => commands.send.availability('Extension capture'), run: ({ commands }) => commands.send.run('Extension capture') }] }],
    dispose() { fixture.disposed.push(activation); } };
  },
} satisfies UiExtensionEntry<'desktop'>;
