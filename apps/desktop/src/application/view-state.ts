import type { DraftStoragePort } from '@agentui/client';
import type { ConversationScope } from '@agentui/contracts';

export interface SavedView {
  readonly version: 2;
  readonly route: ConversationScope | null;
  readonly pendingCreation: { readonly scope: ConversationScope; readonly agentId: string | null } | null;
}
export interface OwnedViewStorage {
  readonly viewId: string;
  readView(hostId: string): Promise<SavedView>;
  saveView(hostId: string, state: SavedView): Promise<void>;
  savedViews(hostId: string, after: string | null): Promise<{
    readonly ids: readonly string[]; readonly unreadable: number; readonly after: string | null;
  }>;
  drafts(onFailure: (error: unknown) => void): DraftStoragePort;
  close(): void | Promise<void>;
}
export interface ViewStorageFactory {
  open(onFailure: (error: unknown) => void): Promise<OwnedViewStorage>;
  reopen(viewId: string, onFailure: (error: unknown) => void): Promise<OwnedViewStorage>;
}
