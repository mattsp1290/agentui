import type { ConversationScope, Json, RunAuthority } from '@agentui/contracts';

export const backendProviderContractVersion = 1;

declare const invariant: unique symbol;
type Invariant<T> = { readonly [invariant]?: (value: T) => T };

export interface ProviderModel {
  readonly request: Json;
  readonly cursor: Json;
  readonly state: Json;
  readonly event: Json;
}

export interface ProviderInstance<I extends string> extends Invariant<I> {
  readonly namespace: string;
  readonly installationId: I;
  readonly generation: string;
  readonly protocolVersion: string;
}

export interface ProviderRef<I extends string, K extends string> {
  readonly instance: ProviderInstance<I>;
  readonly kind: K;
  readonly opaqueId: string;
}

export interface CredentialHandle<I extends string> {
  readonly instance: ProviderInstance<I>;
  readonly hostId: string;
  readonly kind: 'credential-handle';
  readonly opaqueHandle: string;
}

export interface CreationIntent<I extends string> {
  readonly kind: 'create';
  readonly operationId: string;
  readonly scope: ConversationScope;
  readonly agent: ProviderRef<I, 'agent'>;
}

export interface ProviderConversation<I extends string> {
  readonly kind: 'agentui-created';
  readonly creation: CreationIntent<I>;
  readonly authority: RunAuthority & { readonly binding: { readonly installationId: I } };
}

export interface ConversationRef<I extends string, K extends 'run' | 'decision' | 'choice'> {
  readonly binding: ProviderConversation<I>;
  readonly ref: ProviderRef<I, K>;
}

export interface ProviderCursor<M extends ProviderModel, I extends string> extends Invariant<M['cursor']> {
  readonly binding: ProviderConversation<I>;
  readonly kind: 'provider-cursor';
  readonly opaque: M['cursor'];
}

export type ProviderCommand<M extends ProviderModel, I extends string> = Invariant<M> & {
  readonly operationId: string;
  readonly binding: ProviderConversation<I>;
} & (
  | { readonly kind: 'send'; readonly request: M['request'] }
  | { readonly kind: 'cancel'; readonly run: ConversationRef<I, 'run'> }
  | { readonly kind: 'decide'; readonly decision: ConversationRef<I, 'decision'>;
      readonly choice: ConversationRef<I, 'choice'> }
);

export type ProviderOperation<M extends ProviderModel, I extends string> = CreationIntent<I> | ProviderCommand<M, I>;
export type ProviderUnsupported = { readonly kind: 'unsupported'; readonly reason: string };
export type ProviderCapability = { readonly kind: 'supported' } | ProviderUnsupported;
export type ProviderFailure = {
  readonly kind: 'unavailable' | 'authentication-failed' | 'unauthorized' | 'version-unsupported';
  readonly reason: string;
};
export type ProviderOutcome<T> =
  | { readonly kind: 'confirmed'; readonly value: T; readonly evidence: Json }
  | { readonly kind: 'pending'; readonly evidence: Json }
  | { readonly kind: 'not-dispatched'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly reason: string; readonly evidence: Json }
  | { readonly kind: 'uncertain'; readonly reason: string; readonly evidence: Json }
  | ProviderUnsupported
  | ProviderFailure;

export type ProviderCommandEffect<I extends string> =
  | { readonly kind: 'send'; readonly run: ConversationRef<I, 'run'>;
      readonly state: 'accepted' | 'completed' }
  | { readonly kind: 'cancel' | 'decide'; readonly state: 'accepted' | 'completed' };

export interface ProviderSnapshot<M extends ProviderModel, I extends string> {
  readonly binding: ProviderConversation<I>;
  readonly cursor: ProviderCursor<M, I>;
  readonly projectionVersion: number;
  readonly state: M['state'];
  readonly decisions: readonly {
    readonly ref: ConversationRef<I, 'decision'>;
    readonly run: ConversationRef<I, 'run'>;
    readonly prompt: string;
    readonly choices: readonly { readonly ref: ConversationRef<I, 'choice'>; readonly label: string }[];
  }[];
}

export type ProviderItem<M extends ProviderModel, I extends string> =
  | { readonly kind: 'snapshot'; readonly snapshot: ProviderSnapshot<M, I> }
  | { readonly kind: 'event'; readonly cursor: ProviderCursor<M, I>; readonly eventId: string;
      readonly event: M['event'] };

export interface ProviderFeed<M extends ProviderModel, I extends string> {
  close(): void;
  readonly ended: Promise<{
    readonly kind: 'closed' | 'disconnected' | 'resync' | ProviderUnsupported['kind'] | ProviderFailure['kind'];
    readonly cursor: ProviderCursor<M, I> | null;
    readonly reason: string;
  }>;
}

export interface ConnectedProvider<M extends ProviderModel, I extends string> extends Invariant<M> {
  readonly instance: ProviderInstance<I>;
  readonly capabilities: {
    readonly create: ProviderCapability;
    readonly send: ProviderCapability;
    readonly cancel: ProviderCapability;
    readonly decide: ProviderCapability;
    readonly reconcile: ProviderCapability;
    readonly observe: ProviderCapability;
  };
  discover(): Promise<{ readonly kind: 'available'; readonly agents: readonly {
    readonly ref: ProviderRef<I, 'agent'>; readonly name: string;
  }[] } | ProviderUnsupported | ProviderFailure>;
  create(operation: CreationIntent<I>): Promise<ProviderOutcome<ProviderConversation<I>>>;
  submit(operation: ProviderCommand<M, I>): Promise<ProviderOutcome<ProviderCommandEffect<I>>>;
  reconcileCreation(operation: CreationIntent<I>): Promise<ProviderOutcome<ProviderConversation<I>>>;
  reconcileCommand(operation: ProviderCommand<M, I>): Promise<ProviderOutcome<ProviderCommandEffect<I>>>;
  snapshot(binding: ProviderConversation<I>): Promise<
    { readonly kind: 'available'; readonly snapshot: ProviderSnapshot<M, I> } | ProviderUnsupported | ProviderFailure>;
  observe(request: { readonly binding: ProviderConversation<I>; readonly after: ProviderCursor<M, I> | null },
    receive: (item: ProviderItem<M, I>) => Promise<void>): ProviderFeed<M, I>;
  close(): Promise<void>;
}

export interface BackendProvider<M extends ProviderModel, I extends string> extends Invariant<M> {
  readonly apiVersion: typeof backendProviderContractVersion;
  connect(request: { readonly apiVersion: typeof backendProviderContractVersion;
    readonly instance: ProviderInstance<I>; readonly credential: CredentialHandle<I> | null }): Promise<
    { readonly kind: 'connected'; readonly backend: ConnectedProvider<M, I> } | ProviderUnsupported | ProviderFailure>;
}
