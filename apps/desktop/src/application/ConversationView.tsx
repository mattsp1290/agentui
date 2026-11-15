import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useConversation } from '@agentui/client/react';
import type { ConversationActions, OpenConversation } from './application-controller.js';
import { CommandRecovery } from './CommandRecovery.js';
import { AGENT_PRESENTATION, agentPresentation } from './agent-presentation.js';
import { conversationResponding } from './responding.js';
import { CommandActivity } from './CommandActivity.js';
import { AssistantReply } from './AssistantReply.js';

type DraftEditor =
  | { readonly kind: 'saved' | 'saving'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string; readonly message: string };

export function ConversationStatus({ active }: { readonly active: OpenConversation }) {
  const view = useConversation(active.store);
  return <span role="status">Conversation {view.connection.kind}{'reason' in view.connection ? ` · ${view.connection.reason}` : ''}</span>;
}

export function ConversationView({ actions, active, enabled, storageFailure, agent = 'recorded', composerControls }: {
  readonly actions: ConversationActions; readonly active: OpenConversation; readonly enabled: boolean; readonly storageFailure: string; readonly agent?: keyof typeof AGENT_PRESENTATION;
  readonly composerControls?: (canSwitch: boolean) => ReactNode;
}) {
  const presentation = 'kind' in active.agent ? agentPresentation(active.agent).presentation : AGENT_PRESENTATION[agent];
  const view = useConversation(active.store);
  const [editor, setEditor] = useState<DraftEditor>({ kind: 'saved', text: view.draft });
  const editVersion = useRef(0);
  const stopGuard = useRef<{ readonly store: OpenConversation['store']; readonly runId: string } | null>(null);
  const approvalGuards = useRef(new Map<OpenConversation['store'], Set<string>>());
  const [approving, setApproving] = useState<ReadonlySet<string>>(new Set());
  const [stopPending, setStopPending] = useState<typeof stopGuard.current>(null);
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
  const available = active.agent.availability.kind === 'ready';
  const connected = enabled && available && view.connection.kind === 'connected';
  const live = presentation.live;
  const run = live ? view.document.domain.currentRun : null;
  const responding = conversationResponding(agent, view.document.domain);
  const retainedCancel = run && view.outbox.some(entry => entry.command.body.kind === 'cancel' && entry.command.body.runId === run.runId);
  const stopping = run?.kind === 'stopping' || Boolean(retainedCancel) ||
    (stopPending?.store === active.store && stopPending.runId === run?.runId);
  function stop(): void {
    if (!connected || !active.agent.commands.includes('cancel') || run?.kind !== 'running' || stopping ||
      (stopGuard.current?.store === active.store && stopGuard.current.runId === run.runId)) return;
    const target = { store: active.store, runId: run.runId };
    stopGuard.current = target;
    setStopPending(target);
    void actions.submit(() => target.store.cancel(target.runId)).finally(() => {
      if (stopGuard.current === target) {
        stopGuard.current = null;
        setStopPending(null);
      }
    });
  }
  function approve(pendingId: string, choiceId: string): void {
    const store = active.store, decision = store.getSnapshot().document.decisions[pendingId];
    const guards = approvalGuards.current.get(store) ?? new Set<string>();
    if (!connected || !active.agent.commands.includes('approve') || !decision || decision.reserved || guards.has(pendingId)) return;
    guards.add(pendingId);
    approvalGuards.current.set(store, guards);
    setApproving(new Set(guards));
    void actions.submit(() => store.approve(pendingId, choiceId)).finally(() => {
      guards.delete(pendingId);
      setApproving(new Set(guards));
    });
  }
  const canSend = connected && active.agent.commands.includes('send') && !responding && editor.kind === 'saved' && Boolean(editor.text.trim());
  return <section className="conversation-panel" aria-label="Conversation">
    <header><p className="eyebrow">{agent === 'recorded' ? 'RECORDED CONVERSATION' : 'CONVERSATION'}</p><h1>Your conversation</h1><p className="agent-label">{active.agent.label}</p><p className="scope-label">{active.scope.conversationId}</p></header>
    {active.agent.availability.kind === 'unavailable' && <p role="status">{active.agent.availability.reason} Saved history remains available.</p>}
    <div className="transcript" aria-label="Messages" aria-live="polite">
      {view.document.domain.messages.length === 0 && <p className="empty-state">{agent === 'recorded' ? 'Send a message to begin this recorded demonstration.' : 'Send a message to begin.'}</p>}
      {view.document.domain.messages.map(message => <article className={`message message-${message.role}`} key={message.messageId}>
        <strong>{message.role === 'user' ? 'You' : presentation.assistant}</strong>
        {message.role === 'assistant' ? <AssistantReply text={message.text} /> : <p>{message.text}</p>}
        {!message.complete && <span className="progress-label">{agent === 'recorded' ? 'Recorded response in progress…' : 'Responding…'}</span>}
      </article>)}
      <CommandActivity transcript={view.document.domain} connected={view.connection.kind === 'connected'} />
    </div>
    {Object.values(view.document.decisions).map(decision => <section className="decision-card" key={decision.pendingId} aria-label="Approval required">
      <h2>Approval required</h2><p>{decision.prompt}</p><div className="action-row">
        {decision.choices.map(choice => <button key={choice} disabled={!connected || !active.agent.commands.includes('approve') || decision.reserved || approving.has(decision.pendingId)} onClick={() => approve(decision.pendingId, choice)}>{decision.choiceLabels?.[choice] ?? (agent === 'codex' && choice === 'accept' ? 'Allow' : agent === 'codex' && choice === 'decline' ? 'Deny' : choice)}</button>)}
      </div>
    </section>)}
    <form className="composer" onSubmit={event => { event.preventDefault(); if (canSend) void actions.submit(() => active.store.send()); }}>
      <label htmlFor="message">Message</label>
      <textarea id="message" value={editor.text} onChange={event => void edit(event.target.value)} readOnly={Boolean(storageFailure)} placeholder={presentation.placeholder} rows={3} />
      {editor.kind === 'failed' && <p role={storageFailure ? 'note' : 'alert'}>Draft not saved. {storageFailure ? 'Copy your text before reloading.' : editor.message}</p>}
      <div className="composer-footer">{composerControls?.(enabled && editor.kind === 'saved' && !responding)}<div className="composer-send-actions"><button disabled={!canSend}>Send</button>
        {run && run.kind !== 'ended' && <button type="button" disabled={!connected || !active.agent.commands.includes('cancel') || stopping} onClick={stop}>{stopping ? 'Stopping…' : 'Stop'}</button>}</div>
      <p className="composer-disclosure">{presentation.footer}</p>
      </div>
    </form>
    <CommandRecovery view={view} actions={actions} enabled={enabled} canRetry={available} retry={id => active.store.retry(id)} />
  </section>;
}
