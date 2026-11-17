import type { ConversationScope, Json, RunIdentity } from '@agentui/contracts';
import type { FrontendPlatform, FrontendTool, FrontendToolOutcome } from '@agentui/sdk/tools';
import type { LocalHost } from '../local-host.js';
import { frontendToolsContext } from '../frontend-tools-context.js';

type Binding = { readonly name: string; readonly activationId: string; readonly definition: FrontendTool };
type Result = FrontendToolOutcome | { readonly kind: 'refused'; readonly code: 'denied' };
export interface FrontendRunKey { readonly threadId: string; readonly runId: string }
export interface FrontendActor { readonly id: string; readonly platform: FrontendPlatform; authorized(request: { readonly scope: ConversationScope; readonly key: FrontendRunKey; readonly action: 'inspect' | 'claim' | 'receipt'; readonly callId: string | null; readonly activationId: string | null }): boolean }
export interface FrontendRegistration { readonly identity: RunIdentity; readonly threadId: string; readonly platform: FrontendPlatform; readonly bindings: readonly Binding[] }
export type FrontendReceipt = FrontendToolOutcome | { readonly kind: 'uncertain' };
export interface FrontendRunView { readonly status: 'collecting' | 'ready' | 'blocked' | 'faulted'; readonly calls: readonly { readonly id: string; readonly name: string; readonly status: 'collecting' | 'sealed' | 'pending' | 'claimable' | 'uncertain' | 'resolved'; readonly activationId: string | null; readonly argumentsDigest: string | null }[] }
export interface FrontendToolProducer {
  inspect(key: FrontendRunKey): FrontendRunView;
  register(registration: FrontendRegistration): void;
  observe(key: FrontendRunKey, cursor: number, event: unknown): 'accepted' | 'duplicate' | 'faulted';
  decide(key: FrontendRunKey, callId: string, decision: 'allow' | 'deny', activationId: string, argumentsDigest: string): void;
  cancel(key: FrontendRunKey): void;
  results(key: FrontendRunKey): { kind: 'ready'; identity: RunIdentity; threadId: string; batch: readonly { toolCallId: string; result: Result }[] } | { kind: 'waiting' | 'blocked' };
}
export interface FrontendToolClient {
  inspect(key: FrontendRunKey): FrontendRunView;
  claim(key: FrontendRunKey, callId: string, activationId: string):
    | { kind: 'permit'; permitId: string; name: string; arguments: Json }
    | { kind: 'unavailable' | 'uncertain' };
  receipt(key: FrontendRunKey, permitId: string, result: FrontendReceipt): 'recorded' | 'duplicate' | 'uncertain';
}
export interface FrontendTools {
  producer(scope: ConversationScope): FrontendToolProducer;
  client(scope: ConversationScope, actor: FrontendActor): FrontendToolClient;
}
/** Requires the exact handle returned by openLocalHost or openRecordedHost. Copied or wrapped handles are not registered. */
export function frontendToolsFor<E, P>(host: LocalHost<E, P>): FrontendTools {
  const store = frontendToolsContext(host);
  return store.frontendTools(store.authorized);
}
