export { contractVersion } from '@agentui/contracts';
export type { ConversationScope, ProviderBinding, RunAuthority, RunIdentity } from '@agentui/contracts';

export type ExtensionEntry =
  | { readonly kind: 'server'; readonly module: string }
  | { readonly kind: 'desktop'; readonly module: string }
  | { readonly kind: 'ios'; readonly module: string };

export interface ExtensionManifest {
  readonly namespace: string;
  readonly trust: 'full';
  readonly entries: readonly ExtensionEntry[];
}
