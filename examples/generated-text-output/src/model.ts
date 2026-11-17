import { z } from 'zod';
import { canonicalJson, OUTPUT_MAX_BYTES, OUTPUT_MAX_COUNT, OUTPUT_MAX_LIST_BYTES } from '@agentui/contracts';
import type { TextMetadata } from '@agentui/contracts';
import type { CreationIntent, ProviderCommandEffect, ProviderConversation, ProviderOutcome } from '@agentui/sdk';

export const instance = Object.freeze({ namespace: 'reports', installationId: 'reports', generation: '1', protocolVersion: '1' } as const);
const identity = z.strictObject({ namespace: z.literal('reports'), installationId: z.literal('reports'), generation: z.literal('1'), protocolVersion: z.literal('1') });
export const request = z.strictObject({ text: z.string().refine(text => text.isWellFormed() && Buffer.byteLength(text) <= 65536) });
const creation = z.strictObject({ kind: z.literal('create'), operationId: z.uuidv4(),
  scope: z.strictObject({ hostId: z.string().min(1).max(1024), conversationId: z.string().min(1).max(1024) }),
  agent: z.strictObject({ instance: identity, kind: z.literal('agent'), opaqueId: z.literal('writer') }) });
export function binding(intent: CreationIntent<'reports'>): ProviderConversation<'reports'> {
  return { kind: 'agentui-created', creation: intent, authority: { kind: 'remote-provider', binding: {
    namespace: instance.namespace, installationId: instance.installationId, opaqueSessionId: intent.operationId,
  } } };
}
export function reportMetadata(byteLength: number, sha256: string): TextMetadata {
  return { name: 'response.txt', mediaType: 'text/plain', byteLength, sha256 };
}
export function outputListing(value: ProviderConversation<'reports'>, outputs: readonly { opaqueId: string; metadata: TextMetadata }[]) {
  return { kind: 'complete' as const, outputs: outputs.map(({ opaqueId, metadata }) => ({ ...metadata,
    reference: { binding: value, ref: { instance, kind: 'output' as const, opaqueId } },
  })) };
}
export function supportsOutputs(value: ProviderConversation<'reports'>): boolean {
  const output = { opaqueId: value.creation.operationId, metadata: reportMetadata(OUTPUT_MAX_BYTES, 'f'.repeat(64)) };
  return Buffer.byteLength(canonicalJson(outputListing(value, Array.from({ length: OUTPUT_MAX_COUNT }, () => output)))) <= OUTPUT_MAX_LIST_BYTES;
}
export const conversation = z.strictObject({ kind: z.literal('agentui-created'), creation,
  authority: z.strictObject({ kind: z.literal('remote-provider'), binding: z.strictObject({ namespace: z.literal('reports'),
    installationId: z.literal('reports'), opaqueSessionId: z.uuidv4() }) }),
}).refine(value => canonicalJson(value) === canonicalJson(binding(value.creation)) && Buffer.byteLength(canonicalJson(value)) <= 8192 && supportsOutputs(value));
export const operation = z.discriminatedUnion('kind', [creation, z.strictObject({ kind: z.literal('send'),
  operationId: z.uuidv4(), binding: conversation, request })]);
export type ReportOperation = z.infer<typeof operation>;
export type ReportModel = { request: z.infer<typeof request>; cursor: null; state: null; event: null };
export function settlement(value: ReportOperation): ProviderOutcome<ProviderConversation<'reports'> | ProviderCommandEffect<'reports'>> {
  return { kind: 'confirmed', evidence: null, value: value.kind === 'create' ? binding(value) : {
    kind: 'send', state: 'completed', run: { binding: value.binding, ref: { instance, kind: 'run', opaqueId: value.operationId } },
  } };
}
