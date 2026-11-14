import { useEffect, useRef, useState } from 'react';
import { useConversation } from '@agentui/client/react';
import { SERVICE_MAX_SEND_TEXT } from '@agentui/contracts/service';
import type { Application, OpenConversation } from './use-application.js';

export function ConversationStatus({ active }: { readonly active: OpenConversation }) {
  const view = useConversation(active.store);
  return <span role="status">Conversation {view.connection.kind}{'reason' in view.connection ? ` · ${view.connection.reason}` : ''}</span>;
}

export function ConversationView({ app, active }: { readonly app: Application; readonly active: OpenConversation }) {
  const view = useConversation(active.store);
  const [text, setText] = useState(view.draft);
  const pendingEdits = useRef(0);
  useEffect(() => { if (pendingEdits.current === 0) setText(view.draft); }, [view.draft]);
  async function edit(value: string): Promise<void> {
    setText(value);
    pendingEdits.current++;
    try { await active.store.setDraft(value); }
    catch (error) { app.draftFailure(active, error); }
    finally {
      pendingEdits.current--;
      if (pendingEdits.current === 0) setText(active.store.getSnapshot().draft);
    }
  }
  const connected = app.enabled && view.connection.kind === 'connected';
  const recoverable = app.busy ? [] : view.outbox;
  const unresolved = Object.values(view.document.receipts).filter(receipt =>
    (receipt.state.kind === 'pending' || receipt.state.kind === 'uncertain') &&
    !view.outbox.some(entry => entry.command.clientCommandId === receipt.clientCommandId));
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
        {decision.choices.map(choice => <button key={choice} disabled={!connected} onClick={() => void app.command(() => active.store.approve(decision.pendingId, choice))}>{choice}</button>)}
      </div>
    </section>)}
    <form className="composer" onSubmit={event => { event.preventDefault(); void app.command(() => active.store.send()); }}>
      <label htmlFor="message">Message</label>
      <textarea id="message" maxLength={SERVICE_MAX_SEND_TEXT} value={text} onChange={event => void edit(event.target.value)} disabled={Boolean(app.storageFailure)} placeholder="Write to the recorded assistant…" rows={3} />
      <div className="composer-footer"><span>Recorded playback · No live model</span><button disabled={!connected || !text.trim()}>Send</button></div>
    </form>
    {(recoverable.length > 0 || unresolved.some(receipt => receipt.state.kind === 'uncertain')) && <section className="outbox" aria-label="Command recovery">
      <h2>Command recovery</h2><p>Retry keeps the original command ID. Reconcile checks the host’s recorded result. An absent result or rejected retry cannot rule out an earlier submission; its saved command is kept.</p>
      {recoverable.map(entry => <article key={entry.command.clientCommandId}>
        <p><strong>{entry.command.body.kind === 'send' ? entry.command.body.text : entry.command.body.kind}</strong></p>
        <code>{entry.command.clientCommandId}</code><p>{view.document.receipts[entry.command.clientCommandId]?.state.kind ?? 'Result unknown'}</p>
        <div className="action-row"><button disabled={!app.enabled} onClick={() => void app.command(() => active.store.retry(entry.command.clientCommandId))}>Retry original command</button>
          <button disabled={!app.enabled} onClick={() => void app.reconcile(active.scope, entry.command.clientCommandId)}>Reconcile command</button></div>
      </article>)}
      {unresolved.filter(receipt => receipt.state.kind === 'uncertain').map(receipt => <article key={receipt.clientCommandId}><code>{receipt.clientCommandId}</code><p>{receipt.state.kind}</p>
        <button disabled={!app.enabled} onClick={() => void app.reconcile(active.scope, receipt.clientCommandId)}>Reconcile command</button>
      </article>)}
    </section>}
    {unresolved.some(receipt => receipt.state.kind === 'pending') && <section className="outbox" aria-label="Pending commands">
      <h2>Pending commands</h2><p>These commands may still be running. Check their recorded result if progress has stopped.</p>
      {unresolved.filter(receipt => receipt.state.kind === 'pending').map(receipt => <article key={receipt.clientCommandId}>
        <code>{receipt.clientCommandId}</code><p>{receipt.state.kind}</p>
        <button disabled={!app.enabled} onClick={() => void app.reconcile(active.scope, receipt.clientCommandId)}>Check pending command</button>
      </article>)}
    </section>}
  </section>;
}
