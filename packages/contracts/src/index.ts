export const contractVersion = 1;

export interface ConversationScope {
  readonly hostId: string;
  readonly conversationId: string;
}

export interface ProviderBinding {
  readonly namespace: string;
  readonly installationId: string;
  readonly opaqueSessionId: string;
}

export type RunAuthority =
  | { readonly kind: 'agentui-host'; readonly hostId: string; readonly binding: ProviderBinding }
  | { readonly kind: 'remote-provider'; readonly binding: ProviderBinding };

export interface RunIdentity {
  readonly conversation: ConversationScope;
  readonly runId: string;
  readonly authority: RunAuthority;
}
