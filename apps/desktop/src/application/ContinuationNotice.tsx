import { Fragment } from 'react';
import type { ConversationActions, ConversationContinuation } from './application-controller.js';
import { AssistantReply } from './AssistantReply.js';
import { BEFORE_CONTINUE, NEW_CHAT_NOTE, boundaryNote, continuationNotice, earlierLabel, type ContinuationChoice } from './continuation-copy.js';

/** The choices under a closed conversation's notice. Nothing starts until one of them is clicked. */
export function ContinuationChoices({ continuation, actions, enabled }: {
  readonly continuation: ConversationContinuation; readonly actions: ConversationActions; readonly enabled: boolean;
}) {
  const notice = continuationNotice(continuation);
  if (!notice) return null;
  const ready = enabled && continuation.action === null;
  const run: Record<ContinuationChoice, () => Promise<void>> = { Continue: actions.continueConversation, 'Try again': actions.continueConversation,
    'Check again': actions.checkContinuation, 'Start a new chat': actions.startNewChat };
  // The persistent region above the view announces the state line, so this part of the notice stays quiet.
  return <div className="continuation-choices" aria-live="off">
    {notice.status && <p>{notice.status}</p>}
    {notice.disclosure && <p className="continuation-disclosure">{BEFORE_CONTINUE}</p>}
    {notice.choices.length > 0 && <div className="action-row">{notice.choices.map(choice =>
      <button key={choice} type="button" disabled={!ready} onClick={() => void run[choice]()}>{choice}</button>)}</div>}
    {notice.choices.includes('Start a new chat') && <p>{NEW_CHAT_NOTE}</p>}
    {continuation.error && <p role="alert">{continuation.error}</p>}
  </div>;
}

/** Earlier segments loaded on request, then the boundary above the open segment's own messages. */
export function ContinuationHistory({ continuation, actions, enabled, assistant }: {
  readonly continuation: ConversationContinuation; readonly actions: ConversationActions; readonly enabled: boolean; readonly assistant: string;
}) {
  if (!continuation.boundary) return null;
  const earlier = earlierLabel(continuation);
  return <div className="continuation-history">
    {earlier && <button type="button" disabled={!enabled || continuation.action !== null}
      onClick={() => void actions.loadEarlierSegment()}>{earlier}</button>}
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
