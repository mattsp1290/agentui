import { createElement } from 'react';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ConversationContentLayoutProps, ConversationModuleProps, UiExtensionEntry } from '@agentui/sdk/react';
import { Surface, Text } from '@agentui/ui-primitives/desktop';
import { reviewPrompt } from '../shared/prompts.js';

function ReviewLayout({ transcript, modules }: ConversationContentLayoutProps) {
  return createElement('div', { className: 'review-layout' },
    createElement('style', null, `.review-layout { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 16px; }
      .review-layout > * { min-width: 0; }
      @container (max-width: 640px) { .review-layout { grid-template-columns: minmax(0, 1fr); } }`),
    createElement('div', { className: 'review-transcript' }, transcript), createElement('aside', null, modules));
}

function ReviewPlan() {
  return createElement(Surface, null,
    createElement(Text, { as: 'h2' }, 'Plan review'),
    createElement(Text, null, 'Ask the current agent to review the plan and suggest a next step.'));
}

function ReviewGuidance() {
  return createElement(Surface, null,
    createElement(Text, { as: 'h3' }, 'Review guidance'),
    createElement(Text, null, 'Follow the reply in this conversation. Your composer draft stays untouched.'));
}

export default {
  kind: 'desktop',
  sdkVersion: EXTENSION_SDK_VERSION,
  activate() {
    return {
      contentLayout: ReviewLayout,
      modules: [{ id: 'plan-review', label: 'Plan review', component: ReviewPlan,
        actions: [{ id: 'review', label: 'Review the plan', availability: ({ commands }: ConversationModuleProps) => commands.send.availability(reviewPrompt), run: ({ commands }: ConversationModuleProps) => commands.send.run(reviewPrompt) }],
        children: [{ id: 'guidance', label: 'Review guidance', component: ReviewGuidance }] }],
      dispose() {},
    };
  },
} satisfies UiExtensionEntry<'desktop'>;
