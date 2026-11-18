import { Fragment, type ReactNode } from 'react';
import type { ContinuationRefusal, ConversationClosure } from '@agentui/contracts';
import type { ContinuationBoundary, ConversationActions, ConversationContinuation } from './application-controller.js';
import { AssistantReply } from './AssistantReply.js';

export const BEFORE_CONTINUE = 'Starts a new provider conversation with the same agent. The provider sends it the newest complete turns, up to 64 KiB. '
  + 'Older turns and turns with an unknown outcome are left out. Nothing you sent is resent. Tools, approvals and pending work do not carry over.';
export const NEW_CHAT_NOTE = 'Nothing from this chat is sent. Add any context yourself.';
const REFUSAL: Record<ContinuationRefusal, { readonly text: string; readonly tryAgain: boolean; readonly newChat: boolean }> = {
  busy: { text: 'The provider is still finishing work here.', tryAgain: true, newChat: false },
  limit: { text: 'The agent is over a provider limit.', tryAgain: false, newChat: false },
  unavailable: { text: 'The provider could not carry context.', tryAgain: false, newChat: true },
  'continued-elsewhere': { text: 'This conversation was continued outside AgentUI.', tryAgain: false, newChat: true },
};
const BOUNDARY_REASON: Record<ConversationClosure, string> = {
  cancelled: 'was stopped',
  failed: 'ended after the provider reported a failure',
  exhausted: 'reached its turn limit',
};

function turns(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
// Rounded up to a tenth, so a non-empty transcript never reads as 0 KiB.
function kib(bytes: number): string {
  return String(Math.ceil(bytes * 10 / 1024) / 10);
}
export function boundaryNote({ closure, carried }: ContinuationBoundary): string {
  const reason = closure && closure !== 'unknown' ? ` because the earlier one ${BOUNDARY_REASON[closure]}` : '';
  return [`Continued in a new provider conversation${reason}.`,
    carried && carried.carriedTurns > 0 && `Carried the newest ${turns(carried.carriedTurns, 'completed turn')} (${kib(carried.carriedBytes)} KiB of ${kib(carried.limitBytes)} KiB).`,
    carried && carried.omittedTurns > 0 && `${turns(carried.omittedTurns, 'older turn')} left out.`,
    carried && carried.uncertainTurns > 0 && `${turns(carried.uncertainTurns, 'turn')} with an unknown outcome left out and not resent.`,
    'Tools, approvals and the agent’s memory did not carry over.',
    carried && carried.carriedTurns > 0 && 'The first reply acknowledges the carried turns.',
  ].filter(Boolean).join(' ');
}

/** The choices under a closed conversation's notice. Nothing starts until one of them is clicked. */
export function ContinuationChoices({ continuation, actions, enabled }: {
  readonly continuation: ConversationContinuation; readonly actions: ConversationActions; readonly enabled: boolean;
}) {
  const { view, action, error } = continuation;
  if (!view) return null;
  const ready = enabled && action === null;
  const successor = view.successor;
  const button = (label: string, run: () => Promise<void>) => <button type="button" disabled={!ready} onClick={() => void run()}>{label}</button>;
  const newChat = <>{button('Start a new chat', actions.startNewChat)}</>;
  let body: ReactNode;
  if (action === 'start' || action === 'move' || successor?.kind === 'starting' || successor?.kind === 'confirmed') body = <p>Continuing…</p>;
  else if (successor === null) body = <>
    <p className="continuation-disclosure">{BEFORE_CONTINUE}</p>
    <div className="action-row">{button('Continue', actions.continueConversation)}{newChat}</div>
    <p>{NEW_CHAT_NOTE}</p>
  </>;
  else if (successor.kind === 'refused') {
    const refusal = REFUSAL[successor.refusal];
    body = <>
      <p>{refusal.text}</p>
      {(refusal.tryAgain || refusal.newChat) && <div className="action-row">
        {refusal.tryAgain && button('Try again', actions.continueConversation)}{refusal.newChat && newChat}
      </div>}
      {refusal.newChat && <p>{NEW_CHAT_NOTE}</p>}
    </>;
  } else if (successor.kind === 'pending') body = <>
    <p>The provider saved the continuation but has not delivered the carried context. AgentUI will not send it again.</p>
    <div className="action-row">{button('Check again', actions.checkContinuation)}{newChat}</div>
    <p>{NEW_CHAT_NOTE}</p>
  </>;
  else body = <>
    <p>Continue is not confirmed. Checking again cannot start a second conversation.</p>
    <div className="action-row">{button('Check again', actions.checkContinuation)}{button('Try again', actions.continueConversation)}</div>
  </>;
  return <div className="continuation-choices">{body}{error && <p role="alert">{error}</p>}</div>;
}

/** Earlier segments loaded on request, then the boundary above the open segment's own messages. */
export function ContinuationHistory({ continuation, actions, enabled, assistant }: {
  readonly continuation: ConversationContinuation; readonly actions: ConversationActions; readonly enabled: boolean; readonly assistant: string;
}) {
  if (!continuation.boundary) return null;
  return <div className="continuation-history">
    {continuation.more && <button type="button" disabled={!enabled || continuation.action !== null}
      onClick={() => void actions.loadEarlierSegment()}>{continuation.action === 'earlier' ? 'Loading earlier messages…' : 'Show earlier messages'}</button>}
    {continuation.earlierError && <p role="alert">{continuation.earlierError}</p>}
    {continuation.earlier.map(segment => <Fragment key={segment.scope.conversationId}>
      {segment.boundary && <p className="continuation-boundary" role="note">{boundaryNote(segment.boundary)}</p>}
      <section className="transcript earlier-segment" aria-label="Earlier messages">
        {segment.messages.map(message => <article className={`message message-${message.role}`} key={message.messageId}>
          <strong>{message.role === 'user' ? 'You' : assistant}</strong>
          {message.role === 'assistant' ? <AssistantReply text={message.text} /> : message.text && <p>{message.text}</p>}
          {!message.complete && <span className="progress-label">Did not finish</span>}
        </article>)}
      </section>
    </Fragment>)}
    <p className="continuation-boundary" role="note">{boundaryNote(continuation.boundary)}</p>
  </div>;
}
