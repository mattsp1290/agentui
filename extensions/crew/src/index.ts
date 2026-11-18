import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson, parseScope } from '@agentui/sdk';
import type { ConversationScope, RunIdentity } from '@agentui/contracts';
import { CrewClient, CrewHttpError } from '@birbcrew/client';
import { openConversationSchema, requestReceiptResponseSchema, submitRequestSchema } from '@birbcrew/client/contract';

const localRecord = z.strictObject({
  version: z.literal(2),
  scope: z.strictObject({ hostId: z.string().min(1), conversationId: z.string().min(1) }),
  authority: z.strictObject({ kind: z.literal('remote-provider'), binding: z.strictObject({
    namespace: z.literal('crew'), installationId: z.string().min(1), opaqueSessionId: z.string().uuid(),
  }) }),
  memberId: z.string().uuid(),
  command: submitRequestSchema,
  outcome: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('unresolved') }),
    z.strictObject({ kind: z.literal('rejected'), status: z.int().min(400).max(499), code: z.string() }),
    z.strictObject({ kind: z.literal('receipt'), receipt: requestReceiptResponseSchema }),
  ]),
});
export type IntentRecord = z.infer<typeof localRecord>;
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

function terminal(record: IntentRecord): boolean {
  return record.outcome.kind === 'receipt' &&
    ['completed', 'failed', 'cancelled'].includes(record.outcome.receipt.status);
}

export async function connectCrewConversation(options: CrewConversationOptions) {
  const scope = parseScope(options.scope);
  const target = openConversationSchema.parse({ conversationId: options.conversationId, memberId: options.memberId });
  const authority = localRecord.shape.authority.parse({ kind: 'remote-provider', binding: {
    namespace: 'crew', installationId: options.installationId, opaqueSessionId: target.conversationId,
  } });
  const stored = await options.intents.load();
  let record = stored === null ? null : localRecord.parse(stored);
  const savedReceipt = record?.outcome.kind === 'receipt' ? record.outcome.receipt : null;
  if (record && (
    canonicalJson(record.scope) !== canonicalJson(scope) ||
    canonicalJson(record.authority) !== canonicalJson(authority) ||
    record.memberId !== target.memberId ||
    record.command.conversationId !== target.conversationId ||
    (savedReceipt && (savedReceipt.requestId !== record.command.requestId ||
      savedReceipt.conversationId !== target.conversationId))
  )) {
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
  function requireWritableRetryStorage(intent: IntentRecord): Promise<void> {
    return options.intents.save(structuredClone(intent));
  }
  async function invalidateRejection(intent: IntentRecord): Promise<IntentRecord> {
    const unresolved: IntentRecord = { ...intent, outcome: { kind: 'unresolved' } };
    await save(unresolved);
    return unresolved;
  }
  async function dispatch(intent: IntentRecord, admission: 'known-absent' | 'unknown-or-observed') {
    const receipt = await options.client.submit(intent.command).catch(async error => {
      if (admission === 'known-absent' && error instanceof CrewHttpError && error.status >= 400 && error.status < 500) {
        await save({ ...intent, outcome: { kind: 'rejected', status: error.status, code: error.code } });
      }
      throw error;
    });
    await save({ ...intent, outcome: { kind: 'receipt', receipt } });
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
        if (record && record.outcome.kind !== 'rejected' && !terminal(record)) {
          throw new Error('Reconcile or retry the original Crew request before sending another');
        }
        const next: IntentRecord = { version: 2, scope, authority, memberId: target.memberId,
          command: submitRequestSchema.parse({ conversationId: target.conversationId, requestId: randomUUID(), text }), outcome: { kind: 'unresolved' } };
        await save(next);
        return dispatch(next, 'known-absent');
      });
    },
    retry() {
      return exclusive(async () => {
        if (!record) throw new Error('No saved Crew request');
        if (record.outcome.kind === 'rejected') return dispatch(await invalidateRejection(record), 'known-absent');
        await requireWritableRetryStorage(record);
        return dispatch(record, 'unknown-or-observed');
      });
    },
    reconcile() {
      return exclusive(async () => {
        if (!record) return null;
        const receipt = await options.client.requestStatus(record.command);
        await save({ ...record, outcome: { kind: 'receipt', receipt } });
        return receipt;
      });
    },
  };
}
