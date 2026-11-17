import { z } from 'zod';
import { requestReceiptResponseSchema } from '@birbcrew/client/contract';
import type { ProviderConversation, ProviderInstance, ProviderModel, ProviderPresentation, ConversationRef } from '@agentui/sdk';

export const uncertain = () => ({ kind: 'uncertain', reason: 'Crew outcome is unresolved. Recover the original operation.', evidence: null } as const);
const id = z.string().min(1).max(512);
export const choiceSchema = z.enum(['approve', 'deny', 'inspect', 'test', 'allow_conversation', 'allow_always']);
export const approvalSchema = z.object({ conversationId: z.uuid(), memberId: z.uuid(), requestId: z.uuid(),
  invocationId: z.uuid(), approvalId: z.uuid(), version: z.int(), summary: z.string().max(2048),
  toolName: id.optional(), policyVersion: z.int().optional(), argumentsComplete: z.boolean().optional(),
  choices: z.array(choiceSchema).max(6), standingChoices: z.array(choiceSchema).max(2).optional() });
export const remoteSchema = z.object({ conversationId: z.uuid(), memberId: z.uuid(), phase: z.string(),
  pendingApprovals: z.array(approvalSchema).max(32), pendingQuestions: z.array(approvalSchema).max(32).optional() });
export const messageSchema = z.strictObject({ messageId: id, role: z.enum(['user', 'assistant']),
  text: z.string().max(262144), revision: z.int().positive(), complete: z.boolean() });
export const runSchema = z.strictObject({ requestId: z.uuid(), status: z.enum([
  'accepted', 'waiting', 'running', 'cancellation_requested', 'completed', 'cancelled', 'failed', 'uncertain']),
  cancellation: requestReceiptResponseSchema.options[0].shape.cancellation.unwrap().nullable().exactOptional() });
const instanceSchema = z.strictObject({ namespace: id, installationId: id, generation: id, protocolVersion: id });
const scopeSchema = z.strictObject({ hostId: id, conversationId: id });
const sessionSchema = z.strictObject({ namespace: id, installationId: id, opaqueSessionId: z.uuid() });
export const bindingSchema = z.strictObject({ kind: z.literal('agentui-created'),
  creation: z.strictObject({ kind: z.literal('create'), operationId: z.uuid(), scope: scopeSchema,
    agent: z.strictObject({ instance: instanceSchema, kind: z.literal('agent'), opaqueId: z.uuid() }),
    from: z.strictObject({ scope: scopeSchema, binding: sessionSchema }).exactOptional() }),
  authority: z.strictObject({ kind: z.literal('remote-provider'), binding: sessionSchema }) });
export const closureSchema = z.strictObject({ cause: z.enum(['cancelled', 'failed', 'exhausted']) });
export const stateSchema = z.strictObject({ binding: bindingSchema, messages: z.array(messageSchema).max(2048), run: runSchema.nullable(),
  closure: closureSchema.exactOptional(), handoff: z.strictObject({ firstRequestId: z.uuid() }).exactOptional() });
const carriedSchema = z.strictObject({ handoffId: z.uuid(), firstRequestId: z.uuid(), carriedTurns: z.int().min(1).max(128),
  omittedTurns: z.int().min(0).max(127), uncertainTurns: z.int().min(0).max(128), transcriptBytes: z.int().min(1).max(65536) });
const refusedSchema = z.strictObject({ refused: z.enum(['busy', 'limit', 'unavailable', 'continued-elsewhere']), code: z.string().regex(/^[A-Za-z0-9_]{1,128}$/) });
const handoffTranscriptBytes = 65536;
export const cursorSchema = z.strictObject({ epoch: z.uuid(), sequence: z.int().nonnegative(), requests: z.array(z.uuid()).max(2048) });
export const requestSchema = z.strictObject({ text: z.string().min(1).max(65536) });
export type CrewState = z.infer<typeof stateSchema>;
export type CrewCursor = z.infer<typeof cursorSchema>;
export type CrewClosure = z.infer<typeof closureSchema>;
export type CrewApproval = z.infer<typeof approvalSchema>;
export interface CrewModel extends ProviderModel {
  readonly request: z.infer<typeof requestSchema>;
  readonly cursor: CrewCursor;
  readonly state: CrewState;
  readonly event: CrewState;
}
export function reference<K extends 'run' | 'decision' | 'choice' | 'permission'>(binding: ProviderConversation<string>, kind: K,
  opaqueId: string): ConversationRef<string, K> {
  return { binding, ref: { instance: binding.creation.agent.instance, kind, opaqueId } };
}
export const decisionKey = z.tuple([z.uuid(), z.uuid(), z.uuid(), z.int()]);
export function approvalKey(card: CrewApproval): string {
  return JSON.stringify([card.requestId, card.invocationId, card.approvalId, card.version]);
}
export const choiceLabels: Record<z.infer<typeof choiceSchema>, string> = {
  approve: 'Approve once', deny: 'Deny', inspect: 'Inspect', test: 'Test',
  allow_conversation: 'Approve this item and allow work items for this conversation', allow_always: 'Always allow for this member',
};
export function runOutcome(run: z.input<typeof runSchema> | z.infer<typeof requestReceiptResponseSchema>) {
  return run.status === 'completed' ? 'completed' : run.status === 'failed' ? 'failed'
    : run.status === 'cancelled' || run.cancellation?.nativeTermination === 'confirmed' ? 'interrupted' : null;
}
export function closureCause(phase: string): CrewClosure['cause'] | null {
  return phase === 'cancelled' || phase === 'failed' ? phase : phase === 'complete' ? 'exhausted' : null;
}
export function presentation(instance: ProviderInstance<string>): ProviderPresentation<CrewModel, string> {
  return { instance, decodeRequest: value => requestSchema.parse(value), decodeCursor: value => cursorSchema.parse(value),
    decodeState: value => stateSchema.parse(value), decodeEvent: value => stateSchema.parse(value),
    request: text => requestSchema.parse({ text }),
    snapshot(state, refs) {
      const carried = state.handoff?.firstRequestId, run = state.run;
      const messages = carried ? state.messages.filter(message => message.messageId !== carried) : state.messages;
      if (!run) return { messages, currentRun: null };
      const runId = refs.run(reference(state.binding, 'run', run.requestId)).runId;
      const outcome = runOutcome(run);
      return { messages, currentRun: outcome ? { kind: 'ended', runId, outcome } : { kind: 'running', runId } };
    },
    apply() { throw new Error('Crew observation supplies authoritative snapshots'); },
    closure: state => state.closure ?? null,
    continuation(evidence) {
      const refused = refusedSchema.safeParse(evidence);
      if (refused.success) return { refused: refused.data.refused };
      const carried = carriedSchema.safeParse(evidence);
      if (!carried.success) return null;
      return { carriedTurns: carried.data.carriedTurns, omittedTurns: carried.data.omittedTurns, uncertainTurns: carried.data.uncertainTurns,
        carriedBytes: carried.data.transcriptBytes, limitBytes: handoffTranscriptBytes };
    },
  };
}
