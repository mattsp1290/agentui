export { contractVersion } from '@agentui/contracts';
export type { ConversationScope, Json, ProviderBinding, RunAuthority, RunIdentity } from '@agentui/contracts';

export type ExtensionEntry =
  | { readonly kind: 'server'; readonly module: string }
  | { readonly kind: 'desktop'; readonly module: string }
  | { readonly kind: 'ios'; readonly module: string };

export interface ExtensionManifest {
  readonly namespace: string;
  readonly trust: 'full';
  readonly entries: readonly ExtensionEntry[];
}

export { backendProviderContractVersion } from './providers.js';
export type {
  ProviderModel, ProviderInstance, ProviderRef, CredentialHandle, CreationIntent, ProviderConversation,
  ConversationRef, ProviderCursor, ProviderCommand, ProviderOperation, ProviderUnsupported, ProviderCapability,
  ProviderFailure, ProviderOutcome, ProviderCommandEffect, ProviderSnapshot, ProviderItem, ProviderFeed,
  ConnectedProvider, BackendProvider,
} from './providers.js';
