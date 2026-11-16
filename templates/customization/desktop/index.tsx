import { createElement } from 'react';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ConversationModuleProps, UiExtensionEntry } from '@agentui/sdk/react';
import { Surface, Text } from '@agentui/ui-primitives/desktop';
import { reviewPrompt } from '../shared/prompts.js';

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
      modules: [{ id: 'plan-review', label: 'Plan review', component: ReviewPlan,
        actions: [{ id: 'review', label: 'Review the plan', run: ({ commands }: ConversationModuleProps) => commands.send(reviewPrompt) }],
        children: [{ id: 'guidance', label: 'Review guidance', component: ReviewGuidance }] }],
      dispose() {},
    };
  },
} satisfies UiExtensionEntry<'desktop'>;
