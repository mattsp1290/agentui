import { useContext } from 'react';
import type { ConversationModuleProps } from '@agentui/sdk/react';
import { CoworkerContext, initials } from './shared.js';

/** Bubbles: your messages on the right on the accent tint, the coworker's on the left with its avatar and name above each group. */
export function CoworkersTranscript({ activity }: ConversationModuleProps) {
  const coworker = useContext(CoworkerContext)?.name ?? 'Coworker';
  const { messages, currentRun } = activity.domain;
  const typing = currentRun?.kind === 'running' || currentRun?.kind === 'stopping';
  return <section className="coworkers-transcript" aria-label="Coworker messages">
    {messages.length === 0 && <p className="coworkers-empty">Say hello to {coworker}.</p>}
    <ol className="coworkers-message-list">
      {messages.map((message, index) => {
        const mine = message.role === 'user', first = index === 0 || messages[index - 1]!.role !== message.role;
        return <li key={message.messageId} className="coworkers-message" data-side={mine ? 'mine' : 'theirs'}>
          {!mine && first && <div className="coworkers-sender"><span className="coworkers-avatar" aria-hidden="true">{initials(coworker)}</span><strong>{coworker}</strong></div>}
          <div className="coworkers-bubble">{message.text}</div>
        </li>;
      })}
      {typing && <li className="coworkers-message coworkers-typing" data-side="theirs" role="status" aria-label={`${coworker} is working on a reply`}>
        <div className="coworkers-bubble"><span className="coworkers-dot" /><span className="coworkers-dot" /><span className="coworkers-dot" /></div>
      </li>}
    </ol>
  </section>;
}
