import type { z } from 'zod';
import { CrewHttpError, type ApprovalDetailIdentity, type Capabilities, type CrewClient, type DecisionRecord } from '@birbcrew/client';
import { decisionReceiptsCapabilityV1Schema } from '@birbcrew/client/contract';
import type { ProviderCommandEffect, ProviderOutcome } from '@agentui/sdk';
import { uncertain, type choiceSchema } from './provider-model.js';

type Choice = z.infer<typeof choiceSchema>;
export type DecisionVerdict = 'confirmed' | 'rejected' | 'uncertain';
/** One decide as AgentUI would send it: the card identity, the choice and the decision id it carries, if any. */
export interface DecisionRequest extends ApprovalDetailIdentity { readonly choice: Choice; readonly decisionId: string | null }
/**
 * What Crew said about one decide: its reply, a 409 refusal code, the decision record read back under the id the
 * decide carried, or nothing readable because the decide carried no id.
 */
export type DecisionSignal =
  | { readonly kind: 'reply'; readonly approvalId: string; readonly choice: string }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'record'; readonly decisionId: string; readonly record: DecisionRecord }
  | { readonly kind: 'unread' };

const choiceTools: Record<Choice, readonly DecisionRecord['toolName'][]> = {
  approve: ['record_work_item'], allow_conversation: ['record_work_item'], allow_always: ['record_work_item'],
  inspect: ['choose_next_step'], test: ['choose_next_step'], deny: ['record_work_item', 'choose_next_step'],
};

/** The decide operation carries no tool name, so a choice is named only when every tool it can belong to is advertised. */
export function decisionReceipts(capabilities: Capabilities): ((choice: Choice) => boolean) | null {
  const advertised = decisionReceiptsCapabilityV1Schema.safeParse(capabilities.decisionReceipts);
  if (!advertised.success) return null;
  const tools = new Set(advertised.data.tools);
  return choice => choiceTools[choice].every(tool => tools.has(tool));
}

/** The one decision table (docs/decision-receipts.md in Crew). */
export function decisionVerdict(signal: DecisionSignal, expected: DecisionRequest): DecisionVerdict {
  switch (signal.kind) {
    case 'reply': return signal.approvalId === expected.approvalId && signal.choice === expected.choice ? 'confirmed' : 'uncertain';
    case 'refused': return signal.code === 'decision_conflict' && expected.decisionId !== null ? 'rejected' : 'uncertain';
    case 'unread': return 'uncertain';
    case 'record': {
      const record = signal.record;
      switch (record.state) {
        case 'decided':
          if (record.decisionId === null) return 'uncertain';
          if (record.decisionId !== signal.decisionId) return 'rejected';
          return record.choice === expected.choice ? 'confirmed' : 'uncertain';
        case 'auto_approved': case 'closed': return 'rejected';
        case 'undecided': return 'uncertain';
      }
    }
  }
}

const rejections: Record<string, string> = {
  decided: 'Crew settled this card with a competing decision.',
  decision_conflict: 'Crew settled this card with a competing decision.',
  auto_approved: 'Crew settled this card under a standing permission.',
  closed: 'Crew closed this card before recording this decision.',
};

function settlement(signal: DecisionSignal): string | null {
  switch (signal.kind) {
    case 'record': return signal.record.state;
    case 'refused': return signal.code;
    case 'reply': case 'unread': return null;
  }
}

function refusal(error: unknown): DecisionSignal {
  if (error instanceof CrewHttpError && error.status === 409) return { kind: 'refused', code: error.code };
  throw error;
}

async function exchange(client: CrewClient, request: DecisionRequest, fresh: boolean): Promise<DecisionSignal> {
  const { choice, decisionId, ...identity } = request;
  if (fresh) {
    return client.decide({ ...identity, choice, ...(decisionId !== null && { decisionId }) }, { signal: AbortSignal.timeout(15000) })
      .then(reply => ({ kind: 'reply', approvalId: reply.approvalId, choice: reply.decision }) as const, refusal);
  }
  if (decisionId === null) {
    await client.requestStatus({ conversationId: identity.conversationId, requestId: identity.requestId }, { signal: AbortSignal.timeout(10000) });
    return { kind: 'unread' };
  }
  return { kind: 'record', decisionId, record: await client.decisionRecord(identity, { signal: AbortSignal.timeout(10000) }) };
}

/**
 * Sends a decide (fresh) or reads back what Crew recorded for it (reconcile), and settles it only through the table.
 * Failures other than a 409 refusal propagate to the caller's transport classification.
 */
export async function decide(client: CrewClient, request: DecisionRequest, fresh: boolean): Promise<ProviderOutcome<ProviderCommandEffect<string>>> {
  const signal = await exchange(client, request, fresh);
  const evidence = { approvalId: request.approvalId, choice: request.choice, ...(request.decisionId !== null && { decisionId: request.decisionId }) };
  switch (decisionVerdict(signal, request)) {
    case 'confirmed': return { kind: 'confirmed', value: { kind: 'decide', state: 'completed' }, evidence };
    case 'uncertain': return uncertain();
    case 'rejected': {
      const crew = settlement(signal);
      return { kind: 'rejected', reason: (crew !== null && rejections[crew]) || 'Crew recorded another outcome for this card.', evidence: { ...evidence, crew } };
    }
  }
}
