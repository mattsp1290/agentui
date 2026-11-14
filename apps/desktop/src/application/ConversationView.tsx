import { useEffect, useRef, useState } from 'react';
import { useConversation } from '@agentui/client/react';
import { SERVICE_MAX_COMMAND_BYTES } from '@agentui/contracts/service';
import type { ConversationActions, OpenConversation } from './application-controller.js';
import { CommandRecovery } from './CommandRecovery.js';

export function ConversationStatus({ active }: { readonly active: OpenConversation }) {
  const view = useConversation(active.store);
  return <span role="status">Conversation {view.connection.kind}{'reason' in view.connection ? ` · ${view.connection.reason}` : ''}</span>;
}

export function ConversationView({ actions, active }: { readonly actions: ConversationActions; readonly active: OpenConversation }) {
  const view = useConversation(active.store);
  const [text, setText] = useState(view.draft);
  const pendingEdits = useRef(0);
  useEffect(() => { if (pendingEdits.current === 0) setText(view.draft); }, [view.draft]);
  async function edit(value: string): Promise<void> {
    setText(value);
    pendingEdits.current++;
    try { await active.store.setDraft(value); }
    catch (error) { actions.reportDraftFailure(error); }
    finally {
      pendingEdits.current--;
      if (pendingEdits.current === 0) setText(active.store.getSnapshot().draft);
    }
  }
  const connected = actions.enabled && view.connection.kind === 'connected';
  return <section className="conversation-panel" aria-label="Conversation">
    <header><p className="eyebrow">RECORDED CONVERSATION</p><h1>Your conversation</h1><p className="scope-label">{active.scope.conversationId}</p></header>
    <div className="transcript" aria-label="Messages" aria-live="polite">
      {view.document.domain.messages.length === 0 && <p className="empty-state">Send a message to begin this recorded demonstration.</p>}
      {view.document.domain.messages.map(message => <article className={`message message-${message.role}`} key={message.messageId}>
        <strong>{message.role === 'user' ? 'You' : 'Recorded assistant'}</strong><p>{message.text}</p>
        {!message.complete && <span className="progress-label">Recorded response in progress…</span>}
      </article>)}
    </div>
    {Object.values(view.document.decisions).map(decision => <section className="decision-card" key={decision.pendingId} aria-label="Approval required">
      <h2>Approval required</h2><p>{decision.prompt}</p><div className="action-row">
        {decision.choices.map(choice => <button key={choice} disabled={!connected} onClick={() => void actions.submit(() => active.store.approve(decision.pendingId, choice))}>{choice}</button>)}
      </div>
    </section>)}
    <form className="composer" onSubmit={event => { event.preventDefault(); void actions.submit(() => active.store.send()); }}>
      <label htmlFor="message">Message</label>
      <textarea id="message" maxLength={SERVICE_MAX_COMMAND_BYTES} value={text} onChange={event => void edit(event.target.value)} disabled={Boolean(actions.storageFailure)} placeholder="Write to the recorded assistant…" rows={3} />
      <div className="composer-footer"><span>Recorded playback · No live model</span><button disabled={!connected || !text.trim()}>Send</button></div>
    </form>
    <CommandRecovery view={view} actions={actions} retry={id => active.store.retry(id)} />
  </section>;
}
