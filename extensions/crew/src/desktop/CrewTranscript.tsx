import type { ConversationModuleProps } from '@agentui/sdk/react';
import { initials } from './initials.js';

/** Flat message rows: avatar, bold sender, text. No bubbles. The SDK exposes no Markdown renderer, so text renders as written. */
export function CrewTranscript({ activity }: ConversationModuleProps) {
  const messages = activity.domain.messages;
  return <section className="crew-transcript" aria-label="Crew messages">
    {messages.length === 0 && <p className="crew-empty">No messages yet. Write to this member below.</p>}
    <ol className="crew-message-list">
      {messages.map(message => {
        const sender = message.role === 'user' ? 'You' : 'Crew member';
        return <li key={message.messageId} className="crew-message" data-role={message.role}>
          <span className="crew-avatar" aria-hidden="true">{initials(sender)}</span>
          <div className="crew-message-body">
            <strong className="crew-sender">{sender}</strong>
            <p className="crew-text">{message.text}</p>
            {!message.complete && <span className="crew-progress">Responding…</span>}
          </div>
        </li>;
      })}
    </ol>
  </section>;
}
