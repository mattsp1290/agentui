import type { ClientView } from '@agentui/client';
import type { SubmitResult } from '@agentui/contracts';
import type { ConversationActions } from './application-controller.js';
import { recoveryModel } from './recovery.js';

export function CommandRecovery({ view, actions, retry, enabled }: {
  readonly view: Pick<ClientView<unknown>, 'outbox' | 'document' | 'submitting'>;
  readonly actions: ConversationActions;
  readonly enabled: boolean;
  readonly retry: (id: string) => Promise<SubmitResult>;
}) {
  const { retained: recoverable, uncertain, pending } = recoveryModel(view);
  return <>
    {(recoverable.length > 0 || uncertain.length > 0) && <section className="outbox" aria-label="Command recovery">
      <h2>Command recovery</h2><p>Retry keeps the original command ID. Reconcile checks the host’s recorded result. An absent result or rejected retry cannot rule out an earlier submission; its saved command is kept.</p>
      {recoverable.map(entry => <article key={entry.command.clientCommandId}>
        <p><strong>{entry.command.body.kind === 'send' ? entry.command.body.text : entry.command.body.kind}</strong></p>
        <code>{entry.command.clientCommandId}</code><p>{view.document.receipts[entry.command.clientCommandId]?.state.kind ?? 'Result unknown'}</p>
        <div className="action-row"><button disabled={!enabled} onClick={() => void actions.submit(() => retry(entry.command.clientCommandId))}>Retry original command</button>
          <button disabled={!enabled} onClick={() => void actions.reconcile(entry.command.clientCommandId)}>Reconcile command</button></div>
      </article>)}
      {uncertain.map(receipt => <article key={receipt.clientCommandId}><code>{receipt.clientCommandId}</code><p>{receipt.state.kind}</p>
        <button disabled={!enabled} onClick={() => void actions.reconcile(receipt.clientCommandId)}>Reconcile command</button>
      </article>)}
    </section>}
    {pending.length > 0 && <section className="outbox" aria-label="Pending commands">
      <h2>Pending commands</h2><p>These commands may still be running. Check their recorded result if progress has stopped.</p>
      {pending.map(receipt => <article key={receipt.clientCommandId}>
        <code>{receipt.clientCommandId}</code><p>{receipt.state.kind}</p>
        <button disabled={!enabled} onClick={() => void actions.reconcile(receipt.clientCommandId)}>Check pending command</button>
      </article>)}
    </section>}
  </>;
}
