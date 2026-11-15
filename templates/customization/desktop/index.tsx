import { createElement } from 'react';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ConversationModuleProps, UiExtensionEntry } from '@agentui/sdk/react';
import { Button, Surface, Text } from '@agentui/ui-primitives/desktop';
import { reviewPrompt } from '../shared/prompts.js';

function ReviewPlan({ commands }: ConversationModuleProps) {
  return createElement(Surface, null,
    createElement(Text, { as: 'h2' }, 'Plan review'),
    createElement(Text, null, 'Ask the current agent to review the plan and suggest a next step.'),
    createElement(Button, { onClick: () => { void commands.send(reviewPrompt); } }, 'Review the plan'));
}

export default {
  kind: 'desktop',
  sdkVersion: EXTENSION_SDK_VERSION,
  activate() {
    return {
      modules: [{ id: 'plan-review', label: 'Plan review', component: ReviewPlan }],
      dispose() {},
    };
  },
} satisfies UiExtensionEntry<'desktop'>;
