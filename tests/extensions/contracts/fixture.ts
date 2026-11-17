import { createElement } from 'react';
import { Text } from '@agentui/ui-primitives/desktop';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ExtensionLifetime, ExtensionManifest, ServerExtensionEntry } from '@agentui/sdk';
import type { ConversationModule, ModuleAction, UiExtensionContributions, ConversationModuleProps, FrontendToolContribution, UiExtensionEntry } from '@agentui/sdk/react';

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
          actions: [{ id: 'summarize', label: 'Summarize', availability: ({ commands }) => commands.send.availability('Summarize this conversation.'), run: ({ commands }) => commands.send.run('Summarize this conversation.') }],
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

export class Subscription implements ExtensionLifetime {
  dispose() {}
}
export class ServerEntry implements ServerExtensionEntry {
  readonly kind = 'server';
  readonly sdkVersion = EXTENSION_SDK_VERSION;
  activate() { return new Subscription(); }
}
export class Summarize implements ModuleAction {
  readonly id = 'summarize';
  get label() { return 'Summarize'; }
  availability({ commands }: ConversationModuleProps) { return commands.send.availability('Summarize'); }
  run({ commands }: ConversationModuleProps) { return commands.send.run('Summarize'); }
}
export class NotesModule implements ConversationModule {
  readonly id = 'notes';
  get label() { return 'Notes'; }
  readonly component = Notes;
  readonly actions = [new Summarize()];
}
export class NotesContribution extends Subscription implements UiExtensionContributions {
  readonly modules = [new NotesModule()];
}
export class UiEntry implements UiExtensionEntry<'desktop'> {
  readonly kind = 'desktop';
  readonly sdkVersion = EXTENSION_SDK_VERSION;
  activate() { return new NotesContribution(); }
}
export const callableContribution = Object.assign(() => {}, {
  modules: [Object.assign(() => {}, {
    id: 'notes', label: 'Notes', component: Notes,
    actions: [Object.assign(() => {}, { id: 'summarize', label: 'Summarize',
      availability: ({ commands }: ConversationModuleProps) => commands.send.availability('Summarize'),
      run: ({ commands }: ConversationModuleProps) => commands.send.run('Summarize') })],
  })],
  dispose() {},
}) satisfies UiExtensionContributions;
export const callableEntry = Object.assign(() => {}, {
  kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION, activate: () => callableContribution,
} satisfies UiExtensionEntry<'desktop'>);
