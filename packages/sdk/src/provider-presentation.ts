import type { ContinuationCarried, ContinuationRefusal, ConversationClosure, Json, RunIdentity } from '@agentui/contracts';
import type { Transcript, TranscriptEvent } from '@agentui/contracts/conversation';
import type { ConversationRef, CredentialHandle, ProviderConversation, ProviderInstance, ProviderModel } from './providers.js';

declare const invariant: unique symbol;

export interface PresentationRefs<I extends string> {
  run(ref: ConversationRef<I, 'run'>): RunIdentity;
}

/** Model values and presentation output must be bounded, secret-free JSON. */
export interface ProviderPresentation<M extends ProviderModel, I extends string> {
  readonly [invariant]?: (model: M) => M;
  readonly instance: ProviderInstance<I>;
  readonly decodeRequest: (value: unknown) => M['request'];
  readonly decodeCursor: (value: unknown) => M['cursor'];
  readonly decodeState: (value: unknown) => M['state'];
  readonly decodeEvent: (value: unknown) => M['event'];
  readonly request: (text: string, binding: ProviderConversation<I>) => M['request'];
  readonly snapshot: (state: M['state'], refs: PresentationRefs<I>) => Transcript;
  readonly apply: (previous: M['state'], event: M['event'], refs: PresentationRefs<I>) => {
    readonly state: M['state']; readonly events: readonly TranscriptEvent[];
  };
  /** Reports that the provider ended this conversation, read from saved state without I/O. */
  readonly closure?: (state: M['state']) => { readonly cause: ConversationClosure } | null;
  /** Reads what a successor creation carried, or why it was refused, from that creation's saved evidence without I/O. */
  readonly continuation?: (evidence: Json) => ContinuationCarried | { readonly refused: ContinuationRefusal } | null;
}

/** Full-trust server code must keep secrets out of errors, model values and client output. */
export interface ServerProviderCredentials {
  use<I extends string, T>(request: { readonly credential: CredentialHandle<I>; readonly service: string },
    action: (secret: string) => Promise<T>): Promise<T>;
}
