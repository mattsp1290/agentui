import { canRetryObservation } from '@agentui/contracts';
import type { ConversationClosure, ObservationStopReason } from '@agentui/contracts';
import { IMAGE_MAX_BYTES } from '@agentui/contracts/image';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useConversation } from '@agentui/client/react';
import type { ConversationActions, OpenConversation, ConversationObservation, PermissionState } from './application-controller.js';
import { ConversationPermissions } from './ConversationPermissions.js';
import { CommandRecovery } from './CommandRecovery.js';
import { recoveryModel } from './recovery.js';
import { AGENT_PRESENTATION, agentPresentation } from './agent-presentation.js';
import { conversationResponding } from './responding.js';
import { FileActivity } from './FileActivity.js';
import { CommandActivity } from './CommandActivity.js';
import { AssistantReply } from './AssistantReply.js';
import { CustomizationActivity, CustomizationTranscript, type ActivitySelection, type ContentLayoutSelection, type TranscriptSelection } from './DesktopCustomizations.js';
import { CustomizationContent } from './CustomizationContent.js';
import { ImageAttachmentCard, imageSize } from './ImageAttachmentCard.js';

const OBSERVATION_NOTICE: Record<ObservationStopReason, string> = {
  'unsupported': 'This provider does not support live updates.',
  'snapshot-unavailable': 'The provider could not refresh this conversation.',
  'invalid-projection': 'The provider’s saved state or updates could not be validated.',
  'recovery-failed': 'The provider could not resume updates.',
  'retry-exhausted': 'Updates stopped after repeated gaps without progress.',
  'provider-disconnected': 'The provider stopped delivering updates.',
  'original-provider-unavailable': 'Restore this conversation’s original provider configuration to resume updates.',
  'original-credentials-unavailable': 'Restore this conversation’s original provider credentials to resume updates.',
  'original-binding-unavailable': 'This conversation’s original provider binding is unavailable. Restore its original configuration.',
  'cleanup-failed': 'The previous observer could not close safely. Restart the host before resuming updates.',
};
const CLOSURE_NOTICE: Record<ConversationClosure, string> = {
  cancelled: 'it was stopped',
  failed: 'the provider reported a failure',
  exhausted: 'it reached its turn limit',
};

type DraftEditor =
  | { readonly kind: 'saved' | 'saving'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string; readonly message: string };

export function ConversationStatus({ active }: { readonly active: OpenConversation }) {
  const view = useConversation(active.store);
  return <span role="status">Conversation {view.connection.kind}{'reason' in view.connection ? ` · ${view.connection.reason}` : ''}</span>;
}

export function ConversationView({ actions, active, enabled, storageFailure, observation = null, permissionState, agent = 'recorded', composerControls, transcript = { kind: 'default' }, activity = { kind: 'default' }, contentLayout = { kind: 'default' }, modules = null }: {
  readonly actions: ConversationActions; readonly active: OpenConversation; readonly enabled: boolean; readonly storageFailure: string; readonly agent?: keyof typeof AGENT_PRESENTATION;
  readonly permissionState?: PermissionState;
  readonly observation?: ConversationObservation | null;
  readonly transcript?: TranscriptSelection;
  readonly activity?: ActivitySelection;
  readonly contentLayout?: ContentLayoutSelection;
  readonly modules?: ReactNode;
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
  const imageInput = useRef<HTMLInputElement>(null);
  const [imageError, setImageError] = useState<{ readonly store: OpenConversation['store']; readonly message: string } | null>(null);
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
  const observationStatus = observation?.status;
  const paused = observationStatus?.kind === 'stopped';
  const concluded = observationStatus?.kind === 'concluded';
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
  const image = view.image;
  const acceptsImages = active.agent.imageInput.kind === 'supported' && active.agent.commands.includes('send');
  const canSend = connected && !concluded && active.agent.commands.includes('send') && !responding && editor.kind === 'saved' &&
    (image ? image.status === 'ready' && acceptsImages : Boolean(editor.text.trim()));
  const sentImages = view.document.domain.messages.flatMap(message => message.image ? [{ messageId: message.messageId, image: message.image }] : []);
  function imageAction(operation: () => Promise<void>): void {
    const store = active.store;
    setImageError(null);
    void operation().catch((error: unknown) => setImageError({ store, message: error instanceof Error ? error.message : 'The image could not be changed.' }));
  }
  const conversationKey = `${active.viewId}/${active.scope.hostId}/${active.scope.conversationId}`;
  const context = { conversation: active.scope, activity: view.document, outputs: actions.outputs, commands: actions.commands, permissions: actions.permissions };
  const nativeMessages = <>
      {view.document.domain.messages.length === 0 && <p className="empty-state">{agent === 'recorded' ? 'Send a message to begin this recorded demonstration.' : 'Send a message to begin.'}</p>}
      {view.document.domain.messages.map(message => <article className={`message message-${message.role}`} key={message.messageId}>
        <strong>{message.role === 'user' ? 'You' : presentation.assistant}</strong>
        {message.role === 'assistant' ? <AssistantReply text={message.text} /> : message.text && <p>{message.text}</p>}
        {message.image && <ImageAttachmentCard attachment={message.image} read={actions.readImage} />}
        {!message.complete && <span className="progress-label">{concluded ? 'Did not finish' : paused ? 'Updates paused' : agent === 'recorded' ? 'Recorded response in progress…' : 'Responding…'}</span>}
      </article>)}
    </>;
  const nativeActivity = <>
      <CommandActivity transcript={view.document.domain} connected={view.connection.kind === 'connected'} paused={paused} />
      <FileActivity transcript={view.document.domain} connected={view.connection.kind === 'connected'} paused={paused} />
    </>;
  const nativeTranscript = <div className="transcript" aria-label="Messages" aria-live="polite">{nativeMessages}{nativeActivity}</div>;
  const selectiveTranscript = <div className="transcript" aria-label="Messages" aria-live="polite">{nativeMessages}
    <CustomizationActivity selection={activity} conversationKey={conversationKey} fallback={nativeActivity}
      context={{ ...context, updates: paused ? 'paused' : view.connection.kind === 'connected' ? 'connected' : 'reconnecting' }} />
  </div>;

  return <section className="conversation-panel" aria-label="Conversation">
    <header><p className="eyebrow">{agent === 'recorded' ? 'RECORDED CONVERSATION' : 'CONVERSATION'}</p><h1>Your conversation</h1><p className="agent-label">{active.agent.label}</p><p className="scope-label">{active.scope.conversationId}</p></header>
    {active.agent.availability.kind === 'unavailable' && <p role="status">{active.agent.availability.reason} Saved history remains available.</p>}
    {observationStatus?.kind === 'unknown' && <p role="status">Observation status unavailable. Reconnect to check for updates.</p>}
    {observationStatus?.kind === 'recovering' && <p role="status">Resuming provider updates…</p>}
    {observationStatus?.kind === 'stopped' && <div role="status" className="observation-notice">
      <p>Updates paused. {OBSERVATION_NOTICE[observationStatus.reason]} Saved messages and your draft remain available.{run && run.kind !== 'ended' ? ' The provider may still be running.' : ''}</p>
      {canRetryObservation(observationStatus) && <>
        <p>Checking for updates does not restart this request or resend commands.</p>
        <button type="button" disabled={!enabled || observation?.retrying}
          onClick={() => void actions.retryObservation()}>{observation?.retrying ? 'Checking for updates…' : 'Check for updates'}</button>
      </>}
    </div>}
    {observationStatus?.kind === 'concluded' && <div role="status" className="observation-notice">
      <p>This conversation ended: {CLOSURE_NOTICE[observationStatus.cause]}. Earlier messages and your draft stay available.</p>
    </div>}
    {permissionState && <ConversationPermissions retained={recoveryModel(view).retained} state={permissionState} actions={actions} enabled={connected} />}
    <CustomizationContent selection={contentLayout} conversationKey={conversationKey} modules={modules} nativeTranscript={nativeTranscript}
      transcript={<CustomizationTranscript selection={transcript} conversationKey={conversationKey}
        context={context}
        fallback={transcript.kind === 'claimed' ? nativeTranscript : selectiveTranscript}
        appendix={sentImages.length > 0 && <section className="sent-images" aria-label="Sent images">
          <h2>Sent images</h2>{sentImages.map(sent => <ImageAttachmentCard key={sent.messageId} attachment={sent.image} read={actions.readImage} />)}
        </section>} />} />
    {Object.values(view.document.decisions).map(decision => <section className="decision-card" key={decision.pendingId} aria-label="Approval required">
      <h2>Approval required</h2><p>{decision.prompt}</p><div className="action-row">
        {decision.choices.map(choice => <button key={choice} disabled={!connected || !active.agent.commands.includes('approve') || decision.reserved || approving.has(decision.pendingId)} onClick={() => approve(decision.pendingId, choice)}>{decision.choiceLabels?.[choice] ?? (agent === 'codex' && choice === 'accept' ? 'Allow' : agent === 'codex' && choice === 'decline' ? 'Deny' : choice)}</button>)}
      </div>
    </section>)}
    <form className="composer" onSubmit={event => { event.preventDefault(); if (canSend) void actions.submit(() => active.store.send()); }}>
      <label htmlFor="message">Message</label>
      <textarea id="message" value={editor.text} onChange={event => void edit(event.target.value)} readOnly={Boolean(storageFailure)} placeholder={presentation.placeholder} rows={3} />
      {editor.kind === 'failed' && <p role={storageFailure ? 'note' : 'alert'}>Draft not saved. {storageFailure ? 'Copy your text before reloading.' : editor.message}</p>}
      {(image || acceptsImages) && <div className="composer-attachments">
        {image && <div className="composer-image" aria-label="Attached image">
          <span>{image.name} · {imageSize(image.byteLength)}</span>
          <span role="status">{image.status === 'uploading' ? 'Uploading…' : image.status === 'ready' ? 'Ready' : image.status === 'interrupted' ? 'Upload interrupted' : image.reason}</span>
          {(image.status === 'failed' || image.status === 'interrupted') && <button type="button" disabled={!enabled}
            onClick={() => imageAction(() => active.store.retryImage())}>Retry</button>}
          <button type="button" disabled={Boolean(storageFailure)} onClick={() => imageAction(() => active.store.removeImage())}>Remove</button>
        </div>}
        {image && !acceptsImages && <span>{active.agent.imageInput.kind === 'unsupported' ? active.agent.imageInput.reason : 'This agent cannot receive images.'} Remove the image to send.</span>}
        {acceptsImages && <>
          <input ref={imageInput} type="file" accept="image/png,image/jpeg" aria-label="Image file" hidden onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) imageAction(async () => {
              if (file.size > IMAGE_MAX_BYTES) throw new Error('Choose an image of at most 4 MB.');
              await active.store.selectImage({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
            });
          }} />
          <button type="button" disabled={!enabled || Boolean(storageFailure) || image?.status === 'uploading'}
            onClick={() => imageInput.current?.click()}>{image ? 'Replace image' : 'Add image'}</button>
        </>}
        {imageError?.store === active.store && <p role="alert">{imageError.message}</p>}
      </div>}
      <div className="composer-footer">{composerControls?.(enabled && editor.kind === 'saved' && !responding)}<div className="composer-send-actions"><button disabled={!canSend}>Send</button>
        {run && run.kind !== 'ended' && !concluded && <button type="button" disabled={!connected || !active.agent.commands.includes('cancel') || stopping} onClick={stop}>{stopping ? 'Stopping…' : 'Stop'}</button>}</div>
      <p className="composer-disclosure">{presentation.footer}</p>
      </div>
    </form>
    <CommandRecovery view={view} actions={actions} enabled={enabled} canRetry={available} retry={id => active.store.retry(id)} />
  </section>;
}
