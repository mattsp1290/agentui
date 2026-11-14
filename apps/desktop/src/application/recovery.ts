import type { ClientView, OutboxEntry } from '@agentui/client';
import type { Receipt } from '@agentui/contracts';

export function recoveryModel(view: Pick<ClientView<unknown>, 'outbox' | 'document'>, busy: boolean): {
  readonly retained: readonly OutboxEntry[];
  readonly uncertain: readonly Receipt[];
  readonly pending: readonly Receipt[];
} {
  const own = new Set(view.outbox.map(entry => entry.command.clientCommandId));
  const uncertain: Receipt[] = [], pending: Receipt[] = [];
  for (const receipt of Object.values(view.document.receipts)) {
    if (own.has(receipt.clientCommandId)) continue;
    if (receipt.state.kind === 'uncertain') uncertain.push(receipt);
    else if (receipt.state.kind === 'pending') pending.push(receipt);
  }
  return { retained: busy ? [] : view.outbox, uncertain, pending };
}
