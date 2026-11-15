import { createElement, useRef, useState } from 'react';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ConversationModuleProps, UiExtensionEntry } from '@agentui/sdk/react';
import { Button, Surface, Text } from '@agentui/ui-primitives/desktop';
import { reviewPrompt } from '../shared/prompts.js';

function ReviewPlan({ commands }: ConversationModuleProps) {
  const pending = useRef(false);
  const [status, setStatus] = useState('');
  const [sending, setSending] = useState(false);
  async function review() {
    if (pending.current) return;
    pending.current = true;
    setSending(true);
    setStatus('Submitting…');
    try {
      const result = await commands.send(reviewPrompt);
      if (result.kind === 'rejected') setStatus(`Could not submit. ${result.reason}`);
      else {
        const receipt = result.receipt.state;
        setStatus(receipt.kind === 'accepted' ? 'Review submitted.' :
          receipt.kind === 'uncertain' ? 'Submission needs confirmation. Use the conversation recovery controls.' :
          `Review ${receipt.kind}.${'reason' in receipt ? ` ${receipt.reason}` : ''}`);
      }
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Review could not be submitted.'); }
    finally { pending.current = false; setSending(false); }
  }
  return createElement(Surface, null,
    createElement(Text, { as: 'h2' }, 'Plan review'),
    createElement(Text, null, 'Ask the current agent to review the plan and suggest a next step.'),
    createElement(Button, { disabled: sending, onClick: () => { void review(); } }, 'Review the plan'),
    createElement('p', { role: 'status' }, status));
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
