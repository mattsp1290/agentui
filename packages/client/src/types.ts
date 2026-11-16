import type { ClientCommand, FrontendOffer, OfferedCommand, ConversationDocument, ConversationPort, ConversationScope, PermissionScope, Projection, Receipt, SubmitResult } from '@agentui/contracts';

export interface OutboxEntry {
  readonly command: ClientCommand;
  readonly draftRevision: number | null;
}
export interface FrontendRecoveryReference {
  readonly command: OfferedCommand;
  readonly ownerId: string;
  readonly state: 'retained' | 'unavailable-pending' | 'unavailable-confirmed';
}
export interface FrontendJournal {
  read(): readonly FrontendRecoveryReference[];
  unavailable(id: string): Promise<void>;
  acknowledged(id: string): Promise<void>;
}
export interface FrontendAdmission {
  capture(id: string): { readonly ownerId: string; readonly offer: FrontendOffer; commit(command: OfferedCommand, journal: FrontendJournal): boolean; release(): void } | null;
  canRetry(command: OfferedCommand): boolean;
  rejected(id: string): Promise<void>;
}
export interface LocalRecords {
  readonly version: 2;
  readonly frontendSends: readonly FrontendRecoveryReference[];
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
  readonly frontendJournal: FrontendJournal;
  dispose(): Promise<void>;
  getSnapshot(): ClientView<P>;
  subscribe(listener: () => void): () => void;
  setDraft(text: string): Promise<void>;
  send(text?: string): Promise<SubmitResult>;
  approve(pendingId: string, choiceId: string): Promise<SubmitResult>;
  revokePermission(permissionId: string, scope: PermissionScope): Promise<SubmitResult>;
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
  readonly frontend?: FrontendAdmission;
}
