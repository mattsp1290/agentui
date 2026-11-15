import { z } from 'zod';
import type { ProviderConversation, ProviderInstance, ProviderModel, ProviderPresentation, ConversationRef } from '@agentui/sdk';

const id = z.string().min(1).max(512);
export const choiceSchema = z.enum(['approve', 'deny', 'inspect', 'test', 'allow_conversation', 'allow_always']);
export const approvalSchema = z.object({ conversationId: z.uuid(), memberId: z.uuid(), requestId: z.uuid(),
  invocationId: z.uuid(), approvalId: z.uuid(), version: z.int(), summary: z.string().max(2048),
  toolName: id.optional(), argumentsComplete: z.boolean().optional(),
  choices: z.array(choiceSchema).max(6), standingChoices: z.array(choiceSchema).max(2).optional() });
export const remoteSchema = z.object({ conversationId: z.uuid(), memberId: z.uuid(), phase: z.string(),
  pendingApprovals: z.array(approvalSchema).max(32), pendingQuestions: z.array(approvalSchema).max(32).optional() });
export const messageSchema = z.strictObject({ messageId: id, role: z.enum(['user', 'assistant']),
  text: z.string().max(262144), revision: z.int().positive(), complete: z.boolean() });
export const runSchema = z.strictObject({ requestId: z.uuid(), status: z.enum([
  'accepted', 'waiting', 'running', 'cancellation_requested', 'completed', 'cancelled', 'failed', 'uncertain']) });
const instanceSchema = z.strictObject({ namespace: id, installationId: id, generation: id, protocolVersion: id });
export const bindingSchema = z.strictObject({ kind: z.literal('agentui-created'),
  creation: z.strictObject({ kind: z.literal('create'), operationId: z.uuid(),
    scope: z.strictObject({ hostId: id, conversationId: id }),
    agent: z.strictObject({ instance: instanceSchema, kind: z.literal('agent'), opaqueId: z.uuid() }) }),
  authority: z.strictObject({ kind: z.literal('remote-provider'), binding: z.strictObject({
    namespace: id, installationId: id, opaqueSessionId: z.uuid() }) }) });
export const stateSchema = z.strictObject({ binding: bindingSchema, messages: z.array(messageSchema).max(2048), run: runSchema.nullable() });
export const cursorSchema = z.strictObject({ epoch: z.uuid(), sequence: z.int().nonnegative(), requests: z.array(z.uuid()).max(2048) });
export const requestSchema = z.strictObject({ text: z.string().min(1).max(65536) });
export type CrewState = z.infer<typeof stateSchema>;
export type CrewCursor = z.infer<typeof cursorSchema>;
export type CrewApproval = z.infer<typeof approvalSchema>;
export interface CrewModel extends ProviderModel {
  readonly request: z.infer<typeof requestSchema>;
  readonly cursor: CrewCursor;
  readonly state: CrewState;
  readonly event: CrewState;
}
export function reference<K extends 'run' | 'decision' | 'choice'>(binding: ProviderConversation<string>, kind: K,
  opaqueId: string): ConversationRef<string, K> {
  return { binding, ref: { instance: binding.creation.agent.instance, kind, opaqueId } };
}
export const decisionKey = z.tuple([z.uuid(), z.uuid(), z.uuid(), z.int()]);
export function approvalKey(card: CrewApproval): string {
  return JSON.stringify([card.requestId, card.invocationId, card.approvalId, card.version]);
}
export const choiceLabels: Record<z.infer<typeof choiceSchema>, string> = {
  approve: 'Approve once', deny: 'Deny', inspect: 'Inspect', test: 'Test',
  allow_conversation: 'Allow for this conversation', allow_always: 'Always allow for this member',
};
export function presentation(instance: ProviderInstance<string>): ProviderPresentation<CrewModel, string> {
  return { instance, decodeRequest: value => requestSchema.parse(value), decodeCursor: value => cursorSchema.parse(value),
    decodeState: value => stateSchema.parse(value), decodeEvent: value => stateSchema.parse(value),
    request: text => requestSchema.parse({ text }),
    snapshot(state, refs) {
      const run = state.run;
      if (!run) return { messages: state.messages, currentRun: null };
      const runId = refs.run(reference(state.binding, 'run', run.requestId)).runId;
      const outcome = run.status === 'completed' ? 'completed' : run.status === 'cancelled' ? 'interrupted'
        : run.status === 'failed' ? 'failed' : null;
      return { messages: state.messages, currentRun: outcome ? { kind: 'ended', runId, outcome } : { kind: 'running', runId } };
    },
    apply() { throw new Error('Crew observation supplies authoritative snapshots'); },
  };
}
