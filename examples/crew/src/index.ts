import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, parseScope } from '@agentui/contracts';
import type { ConversationScope, RunIdentity } from '@agentui/contracts';
import { CrewClient } from '@birbcrew/client';
import { openConversationSchema, requestReceiptSchema, submitRequestSchema } from '@birbcrew/client/contract';

const localRecord = z.strictObject({
  version: z.literal(1),
  scope: z.strictObject({ hostId: z.string().min(1), conversationId: z.string().min(1) }),
  authority: z.strictObject({ kind: z.literal('remote-provider'), binding: z.strictObject({
    namespace: z.literal('crew'), installationId: z.string().min(1), opaqueSessionId: z.string().uuid(),
  }) }),
  memberId: z.string().uuid(),
  command: submitRequestSchema,
  receipt: requestReceiptSchema.nullable(),
});
type IntentRecord = z.infer<typeof localRecord>;
export interface IntentStorage {
  load(): Promise<unknown>;
  save(record: IntentRecord): Promise<void>;
}
export interface CrewConversationOptions {
  readonly client: CrewClient;
  readonly scope: ConversationScope;
  readonly installationId: string;
  readonly conversationId: string;
  readonly memberId: string;
  readonly intents: IntentStorage;
}

export async function connectCrewConversation(options: CrewConversationOptions) {
  const scope = parseScope(options.scope);
  const target = openConversationSchema.parse({ conversationId: options.conversationId, memberId: options.memberId });
  const authority = localRecord.shape.authority.parse({ kind: 'remote-provider', binding: {
    namespace: 'crew', installationId: options.installationId, opaqueSessionId: target.conversationId,
  } });
  const stored = await options.intents.load();
  let record = stored === null ? null : localRecord.parse(stored);
  if (record && (canonicalJson(record.scope) !== canonicalJson(scope) ||
    canonicalJson(record.authority) !== canonicalJson(authority) || record.memberId !== target.memberId ||
    record.command.conversationId !== target.conversationId || (record.receipt &&
    (record.receipt.requestId !== record.command.requestId || record.receipt.conversationId !== target.conversationId)))) {
    throw new Error('Stored Crew intent belongs to another scope or remote authority');
  }
  const remote = await options.client.conversation({ conversationId: target.conversationId });
  if (remote.memberId !== target.memberId) throw new Error('Crew conversation belongs to another member');
  let busy = false;
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (busy) throw new Error('Crew intent operation already in progress');
    busy = true;
    try { return await operation(); }
    finally { busy = false; }
  }
  async function save(next: IntentRecord) {
    await options.intents.save(structuredClone(next));
    record = next;
  }
  async function dispatch(intent: IntentRecord) {
    const receipt = await options.client.submit(intent.command);
    await save({ ...intent, receipt });
    return receipt;
  }
  return {
    runIdentity(): RunIdentity | null {
      return record ? { conversation: { ...scope }, runId: record.command.requestId,
        authority: structuredClone(authority) } : null;
    },
    intent() { return structuredClone(record); },
    send(text: string) {
      return exclusive(async () => {
        if (record && !['completed', 'failed', 'cancelled'].includes(record.receipt?.status ?? 'unknown')) {
          throw new Error('Reconcile or retry the original Crew request before sending another');
        }
        const next: IntentRecord = { version: 1, scope, authority, memberId: target.memberId,
          command: submitRequestSchema.parse({ conversationId: target.conversationId, requestId: randomUUID(), text }), receipt: null };
        await save(next);
        return dispatch(next);
      });
    },
    retry() {
      return exclusive(async () => {
        if (!record) throw new Error('No saved Crew request');
        await options.intents.save(structuredClone(record));
        return dispatch(record);
      });
    },
    reconcile() {
      return exclusive(async () => {
        if (!record) return null;
        const receipt = await options.client.requestStatus(record.command);
        await save({ ...record, receipt });
        return receipt;
      });
    },
  };
}
