import type { z } from 'zod';
import type { Capabilities, DecisionRecord } from '@birbcrew/client';
import { decisionReceiptsCapabilityV1Schema } from '@birbcrew/client/contract';
import type { choiceSchema } from './provider-model.js';

type Choice = z.infer<typeof choiceSchema>;
export type DecisionVerdict = 'confirmed' | 'rejected' | 'uncertain';
/** What Crew said about one decide: a validated reply, a 409 refusal code, or a decision record read back. */
export type DecisionSignal =
  | { readonly kind: 'reply' }
  | { readonly kind: 'refused'; readonly code: string }
  | { readonly kind: 'record'; readonly record: DecisionRecord };
export interface DecisionExpectation { readonly choice: Choice; readonly decisionId: string | null }

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

/**
 * The one decision table (docs/decision-receipts.md in Crew). A record is read with the id this operation would
 * carry; an operation sent without one can never match it, so naming need not be persisted for a correct verdict.
 */
export function decisionVerdict(signal: DecisionSignal, expected: DecisionExpectation): DecisionVerdict {
  switch (signal.kind) {
    case 'reply': return 'confirmed';
    case 'refused': return signal.code === 'decision_conflict' && expected.decisionId !== null ? 'rejected' : 'uncertain';
    case 'record': {
      const record = signal.record;
      switch (record.state) {
        case 'decided':
          if (record.decisionId === null) return 'uncertain';
          if (record.decisionId !== expected.decisionId) return 'rejected';
          return record.choice === expected.choice ? 'confirmed' : 'uncertain';
        case 'auto_approved': case 'closed': return 'rejected';
        case 'undecided': return 'uncertain';
      }
    }
  }
}
