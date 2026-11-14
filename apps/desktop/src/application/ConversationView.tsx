import { useEffect, useRef, useState } from 'react';
import { useConversation } from '@agentui/client/react';
import type { ConversationActions, OpenConversation } from './application-controller.js';
import { CommandRecovery } from './CommandRecovery.js';

type DraftEditor =
  | { readonly kind: 'saved' | 'saving'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string; readonly message: string };

export function ConversationStatus({ active }: { readonly active: OpenConversation }) {
  const view = useConversation(active.store);
  return <span role="status">Conversation {view.connection.kind}{'reason' in view.connection ? ` · ${view.connection.reason}` : ''}</span>;
}

export function ConversationView({ actions, active, agent = 'recorded' }: {
  readonly actions: ConversationActions; readonly active: OpenConversation; readonly agent?: 'codex' | 'recorded' | 'local';
}) {
  const view = useConversation(active.store);
  const [editor, setEditor] = useState<DraftEditor>({ kind: 'saved', text: view.draft });
  const editVersion = useRef(0);
  useEffect(() => {
    setEditor(previous => previous.kind === 'saved' && previous.text !== view.draft ? { kind: 'saved', text: view.draft } : previous);
  }, [view.draft]);
  async function edit(value: string): Promise<void> {
    const version = ++editVersion.current;
    setEditor({ kind: 'saving', text: value });
    try {
      await active.store.setDraft(value);
      if (version === editVersion.current) setEditor({ kind: 'saved', text: active.store.getSnapshot().draft });
    } catch (error) {
      if (version === editVersion.current) setEditor({ kind: 'failed', text: value,
        message: error instanceof Error ? error.message : 'Your draft could not be saved.' });
    }
  }
  const connected = actions.enabled && view.connection.kind === 'connected';
  const responding = agent === 'codex' && view.document.domain.messages.some(message => message.role === 'assistant' && !message.complete);
  const canSend = connected && !responding && editor.kind === 'saved' && Boolean(editor.text.trim());
  return <section className="conversation-panel" aria-label="Conversation">
    <header><p className="eyebrow">{agent === 'recorded' ? 'RECORDED CONVERSATION' : 'CONVERSATION'}</p><h1>Your conversation</h1><p className="scope-label">{active.scope.conversationId}</p></header>
    <div className="transcript" aria-label="Messages" aria-live="polite">
      {view.document.domain.messages.length === 0 && <p className="empty-state">{agent === 'recorded' ? 'Send a message to begin this recorded demonstration.' : 'Send a message to begin.'}</p>}
      {view.document.domain.messages.map(message => <article className={`message message-${message.role}`} key={message.messageId}>
        <strong>{message.role === 'user' ? 'You' : agent === 'codex' ? 'Codex' : agent === 'recorded' ? 'Recorded assistant' : 'Assistant'}</strong><p>{message.text}</p>
        {!message.complete && <span className="progress-label">{agent === 'recorded' ? 'Recorded response in progress…' : 'Responding…'}</span>}
      </article>)}
    </div>
    {Object.values(view.document.decisions).map(decision => <section className="decision-card" key={decision.pendingId} aria-label="Approval required">
      <h2>Approval required</h2><p>{decision.prompt}</p><div className="action-row">
        {decision.choices.map(choice => <button key={choice} disabled={!connected} onClick={() => void actions.submit(() => active.store.approve(decision.pendingId, choice))}>{choice === 'accept' ? 'Allow' : choice === 'decline' ? 'Deny' : choice}</button>)}
      </div>
    </section>)}
    <form className="composer" onSubmit={event => { event.preventDefault(); if (canSend) void actions.submit(() => active.store.send()); }}>
      <label htmlFor="message">Message</label>
      <textarea id="message" value={editor.text} onChange={event => void edit(event.target.value)} readOnly={Boolean(actions.storageFailure)} placeholder={agent === 'codex' ? 'Write to Codex…' : agent === 'recorded' ? 'Write to the recorded assistant…' : 'Write a message…'} rows={3} />
      {editor.kind === 'failed' && <p role={actions.storageFailure ? 'note' : 'alert'}>Draft not saved. {actions.storageFailure ? 'Copy your text before reloading.' : editor.message}</p>}
      <div className="composer-footer"><span>{agent === 'codex' ? 'Local Codex · Approvals required for changes' : agent === 'recorded' ? 'Recorded playback · No live model' : 'Local agent'}</span><button disabled={!canSend}>Send</button></div>
    </form>
    <CommandRecovery view={view} actions={actions} retry={id => active.store.retry(id)} />
  </section>;
}
