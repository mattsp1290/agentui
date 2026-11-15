import { createElement } from 'react';
import { Text } from '@agentui/ui-primitives/desktop';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ExtensionManifest } from '@agentui/sdk';
import type { ConversationModuleProps, FrontendToolContribution, UiExtensionEntry } from '@agentui/sdk/react';

export const manifest = {
  namespace: 'notes', trust: 'full', sdkVersion: EXTENSION_SDK_VERSION,
  entries: [{ kind: 'desktop', module: './desktop.js' }],
} satisfies ExtensionManifest;

function Notes({ conversation, activity }: ConversationModuleProps) {
  return createElement(Text, null, `${conversation.conversationId}: ${activity.domain.messages.length} messages`);
}
function History({ activity }: ConversationModuleProps) {
  return createElement(Text, null, activity.domain.messages.map(message => message.text).join('\n'));
}
export function createNotesFixture(onDispose: () => void): UiExtensionEntry<'desktop'> {
  return {
    kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION,
    async activate() {
      return {
        modules: [{
          id: 'notes', label: 'Notes', component: Notes,
          actions: [{ id: 'summarize', label: 'Summarize', run: ({ commands }) => commands.send('Summarize this conversation.') }],
          children: [{ id: 'history', label: 'History', component: History }],
        }],
        dispose: onDispose,
      };
    },
  };
}
export const textTool = {
  definition: { name: 'text_length', description: 'Count text characters', parameters: {
    type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false,
  } },
  decodeInput(value: unknown): { text: string } {
    if (typeof value !== 'object' || value === null || !('text' in value) || typeof value.text !== 'string') {
      throw new Error('Expected text');
    }
    return { text: value.text };
  },
  async execute({ text }: { text: string }) { return String(text.length); },
} satisfies FrontendToolContribution<{ text: string }>;
