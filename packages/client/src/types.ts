import type { ClientCommand, ConversationDocument, ConversationPort, ConversationScope, Projection, Receipt, SubmitResult } from '@agentui/contracts';

export interface OutboxEntry {
  readonly command: ClientCommand;
  readonly draftRevision: number | null;
}
export interface LocalRecords {
  readonly version: 1;
  readonly scope: ConversationScope;
  readonly draft: string;
  readonly draftRevision: number;
  readonly outbox: readonly OutboxEntry[];
}
export interface DraftStoragePort {
  load(scope: ConversationScope): Promise<unknown>;
  save(records: LocalRecords): Promise<void>;
}
export type ConnectionState =
  | { readonly kind: 'disconnected' | 'connecting' | 'connected' }
  | { readonly kind: 'resync' | 'mismatch' | 'failed'; readonly reason: string };
export interface ClientView<P> {
  readonly document: ConversationDocument<P>;
  readonly cursor: number | null;
  readonly draft: string;
  readonly outbox: readonly OutboxEntry[];
  readonly connection: ConnectionState;
  readonly submitting: readonly string[];
}
export interface ConversationStore<P> {
  readonly ready: Promise<void>;
  getSnapshot(): ClientView<P>;
  subscribe(listener: () => void): () => void;
  setDraft(text: string): Promise<void>;
  send(): Promise<SubmitResult>;
  approve(pendingId: string, choiceId: string): Promise<SubmitResult>;
  cancel(runId: string): Promise<SubmitResult>;
  retry(clientCommandId: string): Promise<SubmitResult>;
  refreshReceipt(clientCommandId: string): Promise<Receipt | null>;
  connect(): Promise<void>;
  disconnect(): void;
}
export interface StoreOptions<E, P> {
  readonly scope: ConversationScope;
  readonly port: ConversationPort<E, P>;
  readonly projection: Projection<E, P>;
  readonly drafts: DraftStoragePort;
  readonly createCommandId: () => string;
}
