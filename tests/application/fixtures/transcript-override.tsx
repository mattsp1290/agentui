import { useState } from 'react';
import { EXTENSION_SDK_VERSION } from '@agentui/sdk';
import type { ConversationModuleProps, UiExtensionEntry } from '@agentui/sdk/react';

function Transcript({ conversation, activity }: ConversationModuleProps) {
  const [expanded, setExpanded] = useState(true);
  return <section aria-label="Committed transcript">
    <button onClick={() => setExpanded(value => !value)}>Toggle history</button>
    <p>{conversation.conversationId} has {activity.domain.messages.length} messages</p>
    {expanded && activity.domain.messages.map(message => <p key={message.messageId}>{message.text}</p>)}
  </section>;
}

export default {
  kind: 'desktop', sdkVersion: EXTENSION_SDK_VERSION,
  activate() { return { modules: [], overrides: { transcript: Transcript }, dispose() {} }; },
} satisfies UiExtensionEntry<'desktop'>;
